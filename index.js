const express = require('express');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// ---- Load config ----
const CONFIG_PATH = path.join(__dirname, 'config.json');
let CONFIG = {};
try {
  CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  console.log('✓ Loaded config.json');
} catch (e) {
  console.error('✗ config.json error:', e.message);
  process.exit(1);
}

app.use(express.json({ limit: '256kb' }));

// ============================================================
//  Static files (public folder)
// ============================================================
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1y',
  immutable: true,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// ============================================================
//  In-memory cache (per warm lambda)
// ============================================================
const cache = new Map();
function cacheGet(key) {
  if (!CONFIG.cache?.enabled) return null;
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expires) {
    cache.delete(key);
    return null;
  }
  return item.value;
}
function cacheSet(key, value) {
  if (!CONFIG.cache?.enabled) return;
  const ttl = (CONFIG.cache.ttlSeconds || 300) * 1000;
  cache.set(key, { value, expires: Date.now() + ttl });
  if (cache.size > (CONFIG.cache.maxEntries || 200)) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
}

// ============================================================
//  Simple in-memory rate limiter (per IP, per warm lambda)
// ============================================================
const rateBuckets = new Map();
function rateLimit(req, res, next) {
  const limit = CONFIG.limits?.rateLimitPerMin || 20;
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  const now = Date.now();
  const windowMs = 60_000;

  let bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.start > windowMs) {
    bucket = { start: now, count: 0 };
    rateBuckets.set(ip, bucket);
  }
  bucket.count++;

  res.setHeader('X-RateLimit-Limit', limit);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, limit - bucket.count));

  if (bucket.count > limit) {
    res.setHeader('Retry-After', Math.ceil((bucket.start + windowMs - now) / 1000));
    return res.status(429).json({ success: false, error: 'Too many requests. Please wait a minute.' });
  }

  if (rateBuckets.size > 500) {
    for (const [k, v] of rateBuckets) {
      if (now - v.start > windowMs) rateBuckets.delete(k);
    }
  }
  next();
}

// ============================================================
//  Explicit page routes
// ============================================================
app.get('/', (req, res, next) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'), (err) => {
    if (err) next(err);
  });
});

app.get('/downloader', (req, res, next) => {
  res.sendFile(path.join(__dirname, 'public', 'downloader.html'), (err) => {
    if (err) next(err);
  });
});

// ============================================================
//  API routes
// ============================================================
app.get('/api/config', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json({
    site: CONFIG.site,
    limits: {
      rateLimitPerMin: CONFIG.limits?.rateLimitPerMin || 20,
      maxUrlLength: CONFIG.limits?.maxUrlLength || 2048,
    },
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'ok',
    version: CONFIG.site?.version || '1.0.0',
    uptime: Math.floor(process.uptime()),
    cacheSize: cache.size,
  });
});

app.get('/api/tiktok', rateLimit, async (req, res, next) => {
  const tiktokUrl = (req.query.url || '').trim();

  // --- Validation ---
  if (!tiktokUrl) {
    return res.status(400).json({ success: false, error: 'TikTok URL is required' });
  }
  if (tiktokUrl.length > (CONFIG.limits?.maxUrlLength || 2048)) {
    return res.status(400).json({ success: false, error: 'URL too long' });
  }
  if (!/^https?:\/\/(www\.|vm\.|vt\.|m\.)?tiktok\.com\//i.test(tiktokUrl)) {
    return res.status(400).json({ success: false, error: 'Not a valid TikTok URL' });
  }

  // --- Cache check ---
  const cacheKey = `tt:${tiktokUrl}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    return res.json(cached);
  }
  res.setHeader('X-Cache', 'MISS');

  const cfg = CONFIG.ssstik;
  const timeout = CONFIG.limits?.requestTimeoutMs || 25000;

  const headers = {
    'accept': '*/*',
    'accept-language': 'en-US,en;q=0.9',
    'content-type': 'application/x-www-form-urlencoded',
    'origin': cfg.origin,
    'referer': cfg.referer,
    'sec-ch-ua': '"Not A(Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'user-agent': cfg.userAgent,
  };

  const body = new URLSearchParams({
    id: tiktokUrl,
    locale: cfg.locale || 'en',
    tt: cfg.ttToken,
  }).toString();

  try {
    const { data: html } = await axios.post(cfg.endpoint, body, {
      headers,
      timeout,
      maxRedirects: 3,
    });

    const extract = (regex, fallback = '') => {
      const m = html.match(regex);
      return m && m[1] ? decodeHtml(m[1]).trim() : fallback;
    };

    const result = {
      success: true,
      author: extract(/<h2>(.*?)<\/h2>/, 'Unknown'),
      profilePic: extract(/<img class="result_author" src="(.*?)"/, ''),
      description: extract(/<p class="maintext">(.*?)<\/p>/, ''),
      likes: extract(/<div>\s*(\d+)\s*<\/div>\s*<\/div>\s*<\/div>\s*<div class="d-flex flex-1 align-items-center justify-content-center">/, '0'),
      comments: extract(/<div class="d-flex flex-1 align-items-center justify-content-center">\s*<svg[^>]*><\/svg>\s*<div>\s*(\d+)\s*<\/div>/, '0'),
      downloadLink: extract(/href="(https:\/\/tikcdn\.io\/ssstik\/[^"]+)"/, ''),
      mp3DownloadLink: extract(/<a href="(https:\/\/tikcdn\.io\/ssstik\/[^"]+)"[^>]*class="pure-button[^>]*download_link music[^>]*">/, ''),
      source: tiktokUrl,
      fetchedAt: new Date().toISOString(),
    };

    if (!result.downloadLink) {
      return res.status(502).json({
        success: false,
        error: 'Could not extract download link. The video may be private, deleted, or ssstik.io changed its HTML.',
      });
    }

    cacheSet(cacheKey, result);
    res.json(result);

  } catch (error) {
    const isTimeout = error.code === 'ECONNABORTED';
    const status = error.response?.status || (isTimeout ? 504 : 500);

    console.error('TikTok DL error:', error.message);

    res.status(status).json({
      success: false,
      error: isTimeout ? 'Upstream timeout. Try again.' : 'Upstream error',
      message: error.message,
    });
  }
});

// ---- HTML decode helper ----
function decodeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/');
}

// ============================================================
//  404 handler — MUST come AFTER all routes
//  Only sends 404.html for HTML requests; JSON for /api/*
// ============================================================
app.use((req, res) => {
  // API routes → JSON 404
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({
      success: false,
      error: 'API endpoint not found',
      path: req.path,
    });
  }

  // HTML pages → custom 404 page
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'), (err) => {
    if (err) {
      // Fallback if 404.html is missing
      res.status(404).type('html').send('<h1>404 — Not Found</h1>');
    }
  });
});

// ============================================================
//  500 handler — MUST be last, with 4 args
// ============================================================
app.use((err, req, res, next) => {
  console.error('Server error:', err.stack);

  // API routes → JSON 500
  if (req.path.startsWith('/api/')) {
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: err.message,
    });
  }

  // HTML pages → custom 500 page
  res.status(500).sendFile(path.join(__dirname, 'public', '500.html'), (sendErr) => {
    if (sendErr) {
      res.status(500).type('html').send('<h1>500 — Server Error</h1>');
    }
  });
});

// ============================================================
//  Export for Vercel + local listen
// ============================================================
module.exports = app;

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`🎵 TikTok Downloader at http://localhost:${PORT}`));
}