(function () {
  const $ = (id) => document.getElementById(id);

  function toast(msg, type = 'info') {
    const box = $('toast');
    if (!box) return;
    box.textContent = msg;
    box.className = `toast toast-${type} show`;
    clearTimeout(box._t);
    box._t = setTimeout(() => box.classList.remove('show'), 3200);
  }

  function setLoading(loading) {
    $('fetch-btn').disabled = loading;
    $('fetch-label').textContent = loading ? 'Fetching…' : 'Fetch Video';
    $('fetch-spinner').style.display = loading ? 'inline-block' : 'none';
  }

  function resetResult() {
    $('result').style.display = 'none';
    $('empty-state').style.display = 'flex';
    $('error-state').style.display = 'none';
  }

  function showError(msg) {
    $('result').style.display = 'none';
    $('empty-state').style.display = 'none';
    $('error-state').style.display = 'flex';
    $('error-message').textContent = msg;
  }

  function renderResult(data) {
    $('empty-state').style.display = 'none';
    $('error-state').style.display = 'none';
    $('result').style.display = 'block';

    const avatar = $('r-avatar');
    if (data.profilePic) {
      avatar.src = data.profilePic;
      avatar.style.display = 'block';
      avatar.onerror = () => { avatar.style.display = 'none'; };
    } else {
      avatar.style.display = 'none';
    }

    $('r-author').textContent = data.author || 'Unknown author';
    $('r-description').textContent = data.description || 'No description available.';
    $('r-likes').textContent = data.likes || '0';
    $('r-comments').textContent = data.comments || '0';

    const dlVideo = $('r-dl-video');
    const dlMp3 = $('r-dl-mp3');
    const safeName = (data.author || 'tiktok').replace(/[^\w\-]+/g, '_');

    if (data.downloadLink) {
      dlVideo.href = data.downloadLink;
      dlVideo.style.display = 'inline-flex';
      dlVideo.setAttribute('download', `${safeName}.mp4`);
    } else {
      dlVideo.style.display = 'none';
    }

    if (data.mp3DownloadLink) {
      dlMp3.href = data.mp3DownloadLink;
      dlMp3.style.display = 'inline-flex';
      dlMp3.setAttribute('download', `${safeName}.mp3`);
    } else {
      dlMp3.style.display = 'none';
    }
  }

  // ---- History ----
  function renderHistory() {
    const wrap = $('history-list');
    const section = $('history-section');
    if (!wrap || !section) return;

    const list = window.TikHistory?.load() || [];
    if (!list.length) {
      section.style.display = 'none';
      return;
    }
    section.style.display = 'block';

    wrap.innerHTML = list.map((item, i) => `
      <div class="history-item" data-index="${i}">
        <div class="history-thumb" style="${item.profilePic ? `background-image:url('${item.profilePic}')` : ''}"></div>
        <div class="history-body">
          <div class="history-author">${escapeHtml(item.author || 'Unknown')}</div>
          <div class="history-desc">${escapeHtml(item.description || '').slice(0, 80)}</div>
        </div>
        <button class="history-remove" data-remove="${escapeHtml(item.source)}" title="Remove">
          <i class="fas fa-xmark"></i>
        </button>
      </div>
    `).join('');

    wrap.querySelectorAll('.history-item').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.history-remove')) return;
        const idx = +el.dataset.index;
        const item = list[idx];
        if (item) renderResult(item);
      });
    });
    wrap.querySelectorAll('[data-remove]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        window.TikHistory.remove(btn.dataset.remove);
        renderHistory();
      });
    });
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  // ---- Fetch ----
  async function fetchVideo() {
    const url = $('tiktok-url').value.trim();
    if (!url) {
      toast('Please paste a TikTok URL', 'warn');
      $('tiktok-url').focus();
      return;
    }
    if (!/^https?:\/\/(www\.|vm\.|vt\.|m\.)?tiktok\.com\//i.test(url)) {
      toast('That doesn\'t look like a TikTok URL', 'warn');
      return;
    }

    setLoading(true);
    resetResult();
    const t0 = performance.now();

    try {
      const res = await fetch(`/api/tiktok?url=${encodeURIComponent(url)}`);
      const data = await res.json();

      if (!data.success) throw new Error(data.error || 'Failed to fetch video');

      const elapsed = Math.round(performance.now() - t0);
      renderResult(data);
      window.TikHistory?.save(data);
      renderHistory();
      toast(`Fetched in ${elapsed}ms`, 'ok');
    } catch (err) {
      console.error(err);
      showError(err.message);
      toast('Failed: ' + err.message, 'warn');
    } finally {
      setLoading(false);
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('fetch-btn').addEventListener('click', fetchVideo);
    $('tiktok-url').addEventListener('keydown', e => {
      if (e.key === 'Enter') fetchVideo();
    });

    $('clear-url').addEventListener('click', () => {
      $('tiktok-url').value = '';
      resetResult();
      $('tiktok-url').focus();
    });

    document.querySelectorAll('[data-example]').forEach(btn => {
      btn.addEventListener('click', () => {
        $('tiktok-url').value = btn.dataset.example;
        $('tiktok-url').focus();
      });
    });

    // Paste from clipboard
    const pasteBtn = $('paste-btn');
    if (pasteBtn) {
      pasteBtn.addEventListener('click', async () => {
        try {
          const text = await navigator.clipboard.readText();
          if (text) {
            $('tiktok-url').value = text.trim();
            toast('Pasted from clipboard', 'ok');
          }
        } catch {
          toast('Clipboard access denied', 'warn');
        }
      });
    }

    // Clear history
    const clearHistBtn = $('clear-history');
    if (clearHistBtn) {
      clearHistBtn.addEventListener('click', () => {
        if (confirm('Clear all history?')) {
          window.TikHistory.clear();
          renderHistory();
          toast('History cleared', 'ok');
        }
      });
    }

    // Copy buttons
    document.querySelectorAll('[data-copy]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const target = document.querySelector(btn.dataset.copy);
        if (!target || !target.href) return;
        try {
          await navigator.clipboard.writeText(target.href);
          const orig = btn.innerHTML;
          btn.innerHTML = '<i class="fas fa-check"></i>';
          setTimeout(() => btn.innerHTML = orig, 1500);
          toast('Link copied', 'ok');
        } catch {}
      });
    });

    renderHistory();
  });
})();