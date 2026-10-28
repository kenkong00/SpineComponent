/* ============================================================
 * parts.js — 部件库 + 批量导入自动归类
 * ============================================================ */
window.Parts = (function () {
  const S = { parts: [], pool: [], pick: null, slotTarget: null };
  const els = {};

  // 槽位关键词 -> 语义（用于自动归类与提示）
  const KW = ['head', 'hair', 'face', 'bang', 'eye', 'brow', 'eyebrow', 'mouth', 'nose', 'ear',
    'body', 'cloth', 'arm', 'hand', 'leg', 'foot', 'toe', 'shoe', 'skirt', 'tail', 'ear_',
    'tentacle', 'leaf', 'flower', 'sword', 'flag', 'collar', 'scapular', 'ahoge', 'bow'];

  function init() {
    ['libGrid', 'libBadge', 'dropZone', 'fileLib', 'pool', 'slotList', 'dropBatch', 'fileBatch'].forEach((k) => {
      els[k] = document.getElementById(k);
    });
    document.getElementById('btnPickLib').onclick = () => els.fileLib.click();
    els.fileLib.onchange = () => { uploadFiles(els.fileLib.files); els.fileLib.value = ''; };
    document.getElementById('btnBatch').onclick = () => els.fileBatch.click();
    els.fileBatch.onchange = () => { addToPool(els.fileBatch.files); els.fileBatch.value = ''; };
    document.getElementById('btnBatchClear').onclick = () => { S.pool = []; S.pick = null; renderPool(); };
    wireDrop(els.dropZone, (files) => uploadFiles(files));
    wireDrop(els.dropBatch, (files) => addToPool(files));
  }

  function wireDrop(el, cb) {
    ['dragenter', 'dragover'].forEach((ev) => el.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation(); el.classList.add('over');
    }));
    ['dragleave', 'drop'].forEach((ev) => el.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation(); el.classList.remove('over');
    }));
    el.addEventListener('drop', (e) => {
      const fs = Array.from((e.dataTransfer && e.dataTransfer.files) || []).filter(f => /^image\//.test(f.type));
      if (fs.length) cb(fs);
    });
  }

  async function refresh() {
    const d = await API.parts();
    S.parts = d.parts;
    els.libBadge.textContent = S.parts.length;
    renderLib();
  }

  function renderLib() {
    els.libGrid.innerHTML = '';
    if (!S.parts.length) els.libGrid.innerHTML = '<div class="empty">还没有上传过部件</div>';
    S.parts.forEach((p) => {
      const c = document.createElement('div');
      c.className = 'lib-card';
      c.innerHTML = '<div class="im"><img src="' + p.url + '" alt="" loading="lazy"></div>' +
        '<div class="nm" title="' + p.name + ' · ' + (p.w || '?') + '×' + (p.h || '?') + '">' + p.name + '</div>' +
        '<button class="del" title="删除">✕</button>';
      c.onclick = async (e) => {
        if (e.target.classList.contains('del')) {
          if (!confirm('删除部件「' + p.name + '」？')) return;
          await API.delPart(p.name);
          refresh();
          return;
        }
        // 若装配台已选中部件 -> 直接套用
        if (window.Compose && Compose.S.sel >= 0) {
          Compose.applyReplace(Compose.S.sel, p.url, p.name, p.w, p.h);
        } else {
          U.toast('先在装配台选中一个部件，再点这里套用');
        }
      };
      els.libGrid.appendChild(c);
    });
  }

  async function uploadFiles(files) {
    files = Array.from(files || []);
    if (!files.length) return;
    let ok = 0;
    for (const f of files) {
      try {
        const url = await U.fileToDataUrl(f);
        await API.upload(f.name, url, Compose.S.doc && Compose.S.doc.id);
        ok++;
      } catch (e) { console.warn('upload fail', f.name, e); }
    }
    U.toast('已上传 ' + ok + '/' + files.length + ' 个部件');
    refresh();
  }

  /* ---------------- 批量导入到当前角色 ---------------- */
  async function addToPool(files) {
    files = Array.from(files || []);
    if (!files.length) return;
    const doc = Compose.S.doc;
    if (!doc) return U.toast('先在装配台选一个角色');
    let auto = 0;
    for (const f of files) {
      const url = await U.fileToDataUrl(f);
      const base = f.name.replace(/\.[^.]+$/, '');
      const hit = matchSlot(doc, base);
      if (hit) {
        Compose.applyReplace(hit.i, url, f.name);
        auto++;
      } else {
        S.pool.push({ name: f.name, base, url });
      }
    }
    renderPool();
    renderSlots();
    U.toast('自动匹配 ' + auto + ' 个，剩 ' + S.pool.length + ' 个待指派');
  }

  function norm(s) { return String(s).toLowerCase().replace(/[\s_\-\.]+/g, ''); }

  function matchSlot(doc, base) {
    // 1) 完全同名
    for (let i = 0; i < doc.parts.length; i++) {
      const p = doc.parts[i];
      if (norm(p.attachment) === norm(base) || norm(p.slot) === norm(base)) return { i, p, how: '同名' };
    }
    // 2) 去掉编号尾巴（eye_L_1 -> eye_L / eye）
    const strip = norm(base).replace(/[0-9]+$/, '');
    if (strip !== norm(base)) {
      for (let i = 0; i < doc.parts.length; i++) {
        const p = doc.parts[i];
        if (norm(p.attachment) === strip || norm(p.slot) === strip) return { i, p, how: '去尾号' };
      }
    }
    // 3) 关键词包含
    for (let i = 0; i < doc.parts.length; i++) {
      const p = doc.parts[i];
      const a = norm(p.attachment), b = norm(base);
      if (a.length > 2 && (b.includes(a) || a.includes(b))) return { i, p, how: '关键词' };
    }
    return null;
  }

  function renderPool() {
    els.pool.innerHTML = '';
    if (!S.pool.length) els.pool.innerHTML = '<div class="empty" style="grid-column:1/-1">没有待指派的图片</div>';
    S.pool.forEach((it, k) => {
      const c = document.createElement('div');
      c.className = 'lib-card' + (k === S.pick ? ' selpick' : '');
      c.innerHTML = '<div class="im"><img src="' + it.url + '" alt=""></div><div class="nm" title="' + it.name + '">' + it.name + '</div>';
      c.onclick = () => { S.pick = k; renderPool(); renderSlots(); };
      els.pool.appendChild(c);
    });
  }

  function renderSlots() {
    const doc = Compose.S.doc;
    els.slotList.innerHTML = '';
    if (!doc) { els.slotList.innerHTML = '<div class="empty" style="grid-column:1/-1">先在装配台选一个角色</div>'; return; }
    doc.parts.forEach((p, i) => {
      const cur = Compose.S.parts[i];
      const d = document.createElement('div');
      d.className = 'slot-it' + (cur && cur.custom ? ' has' : '');
      d.innerHTML = (cur && cur.imgUrl ? '<img src="' + cur.imgUrl + '" alt="">' : '<div style="height:44px"></div>') +
        '<div class="sn" title="' + p.slot + '">' + p.slot + '</div>';
      d.title = p.attachment + ' · ' + Math.round(p.w) + '×' + Math.round(p.h) + (p.variant ? '（备用/变体）' : '');
      d.onclick = () => {
        if (S.pick == null) return U.toast('先在左边点选一张待指派图片');
        const it = S.pool[S.pick];
        Compose.applyReplace(i, it.url, it.name);
        S.pool.splice(S.pick, 1);
        S.pick = null;
        renderPool(); renderSlots();
      };
      els.slotList.appendChild(d);
    });
  }

  return { init, refresh, renderSlots, renderPool, S };
})();
