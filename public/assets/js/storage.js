/* ============================================================
   Local history — persists last 12 fetched videos
   ============================================================ */
(function () {
  const KEY = 'tikdl-history';
  const MAX = 12;

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }

  function save(item) {
    if (!item || !item.downloadLink) return;
    const list = load().filter(x => x.source !== item.source);
    list.unshift({
      author: item.author,
      description: item.description,
      profilePic: item.profilePic,
      source: item.source,
      downloadLink: item.downloadLink,
      mp3DownloadLink: item.mp3DownloadLink,
      likes: item.likes,
      comments: item.comments,
      fetchedAt: new Date().toISOString(),
    });
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  }

  function clear() {
    localStorage.removeItem(KEY);
  }

  function remove(source) {
    const list = load().filter(x => x.source !== source);
    localStorage.setItem(KEY, JSON.stringify(list));
  }

  window.TikHistory = { load, save, clear, remove, MAX };
})();