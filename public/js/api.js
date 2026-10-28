/* api.js — 与本地服务交互 */
window.API = (function () {
  async function j(url, opt) {
    const r = await fetch(url, opt);
    const t = await r.text();
    let d = null;
    try { d = t ? JSON.parse(t) : null; } catch (e) { d = { raw: t }; }
    if (!r.ok) throw new Error((d && d.error) || ('HTTP ' + r.status));
    return d;
  }
  return {
    characters: (refresh) => j('/api/characters' + (refresh ? '?refresh=1' : '')),
    character: (id) => j('/api/character/' + encodeURIComponent(id)),
    parts: () => j('/api/parts'),
    upload: (name, dataUrl, folder) => j('/api/parts/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, dataUrl, charFolder: folder || null }),
    }),
    delPart: (name) => j('/api/parts/' + encodeURIComponent(name), { method: 'DELETE' }),
    outfits: () => j('/api/outfits'),
    outfit: (id) => j('/api/outfits/' + encodeURIComponent(id)),
    saveOutfit: (o) => j('/api/outfits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(o),
    }),
    delOutfit: (id) => j('/api/outfits/' + encodeURIComponent(id), { method: 'DELETE' }),
    /* ---- 皮肤型模型（多皮肤源 JSON）---- */
    skinModels: (refresh) => j('/api/skinmodels' + (refresh ? '?refresh=1' : '')),
    skinModel: (id) => j('/api/skinmodel?id=' + encodeURIComponent(id)),
    actSkins: (refresh) => j('/api/actskins' + (refresh ? '?refresh=1' : '')),
    skinMerge: (payload) => j('/api/skin/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
    skinMixes: () => j('/api/skinmix'),
    skinMix: (id) => j('/api/skinmix/' + encodeURIComponent(id)),
    saveSkinMix: (o) => j('/api/skinmix', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(o),
    }),
    delSkinMix: (id) => j('/api/skinmix/' + encodeURIComponent(id), { method: 'DELETE' }),
    cutterExport: (payload) => j('/api/cutter/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  };
})();

/* 小工具 */
window.U = {
  el: (s, r) => (r || document).querySelector(s),
  els: (s, r) => Array.from((r || document).querySelectorAll(s)),
  toast(msg, ms) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(t._tm);
    t._tm = setTimeout(() => t.classList.remove('on'), ms || 1900);
  },
  fileToDataUrl(file) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = rej;
      fr.readAsDataURL(file);
    });
  },
  bytes(n) {
    if (n == null) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  },
  sanitize: (s) => String(s || '').replace(/[\\/:*?"<>|\s]+/g, '_'),
};
