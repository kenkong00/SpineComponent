/* ============================================================
 * compose.js — 装配台
 * 源 JSON 拆件还原 + 逐部件替换 + 变换 + 套装
 * ============================================================ */
window.Compose = (function () {
  const S = {
    doc: null,        // 服务端解析结果
    parts: [],        // 绘制顺序：0 = 最底层
    bbox: null,
    sel: -1,
    zoom: 1,
    flipAll: false,
    bg: 'checker',
    search: '',
    onlyActive: false,
    libPickTarget: -1,
    poolPick: null,
  };
  const els = {};

  /* ---------------- 初始化 ---------------- */
  function init() {
    ['stage', 'canvas', 'layers', 'partBadge', 'srcNote', 'stageInfo', 'zoom', 'zoomV', 'bgSel',
      'chkOutline', 'statTxt', 'layerFoot', 'propBody', 'propEmpty', 'propBadge', 'propTitle',
      'propThumb', 'propMeta', 'propBox', 'partSearch', 'onlyActive', 'stageScroll',
      'libMask', 'libPickGrid', 'libPickHint', 'extraMask', 'extraGrid',
      'saveMask', 'outfitName', 'outfitNote', 'saveHint', 'outfitMask', 'outfitList'].forEach((k) => {
        els[k] = document.getElementById(k);
      });

    document.getElementById('btnShowAll').onclick = () => { S.parts.forEach((p) => p.visible = true); refresh(); };
    document.getElementById('btnHideAll').onclick = () => { S.parts.forEach((p) => p.visible = false); refresh(); };
    document.getElementById('btnResetAll').onclick = resetAll;
    els.zoom.oninput = () => setZoom(els.zoom.value / 100);
    document.getElementById('btnFit').onclick = fit;
    els.bgSel.onchange = () => { S.bg = els.bgSel.value; applyBg(); };
    els.chkOutline.onchange = () => els.canvas.classList.toggle('no-outline', !els.chkOutline.checked);
    els.partSearch.oninput = () => { S.search = els.partSearch.value.trim().toLowerCase(); renderLayers(); };
    els.onlyActive.onchange = () => { S.onlyActive = els.onlyActive.checked; renderLayers(); };

    document.getElementById('btnReplace').onclick = () => pickFileForPart(S.sel);
    document.getElementById('btnUseLib').onclick = () => openLibPicker(S.sel);
    document.getElementById('btnUseExtra').onclick = () => openExtraPicker(S.sel);
    document.getElementById('btnResetPart').onclick = () => resetPart(S.sel);
    document.getElementById('pUp').onclick = () => movePart(S.sel, +1);
    document.getElementById('pDown').onclick = () => movePart(S.sel, -1);

    bindProp('pDx', 'dx', v => v, 'pDxV', 0);
    bindProp('pDy', 'dy', v => v, 'pDyV', 0);
    bindProp('pSx', 'sx', v => v, 'pSxV', 2);
    bindProp('pSy', 'sy', v => v, 'pSyV', 2);
    bindProp('pRot', 'rot', v => v, 'pRotV', 0, '°');
    bindProp('pOp', 'opacity', v => v, 'pOpV', 2);
    bindProp('pBri', 'bri', v => v, 'pBriV', 2);
    bindProp('pSat', 'sat', v => v, 'pSatV', 2);
    bindProp('pHue', 'hue', v => v, 'pHueV', 0, '°');
    document.getElementById('pFlipX').onclick = () => toggleProp('flipX');
    document.getElementById('pFlipY').onclick = () => toggleProp('flipY');
    document.getElementById('pFit').onchange = (e) => setProp('fit', e.target.value);
    document.getElementById('pTint').oninput = (e) => setProp('tint', e.target.value);
    document.getElementById('pTintClear').onclick = () => { setProp('tint', '#ffffff'); document.getElementById('pTint').value = '#ffffff'; };

    document.getElementById('btnFlipAll').onclick = () => { S.flipAll = !S.flipAll; applyTransform(); };
    document.getElementById('btnExportPng').onclick = exportPng;
    document.getElementById('btnExportJson').onclick = exportJson;
    document.getElementById('btnSaveOutfit').onclick = openSave;

    // 舞台交互
    els.stageScroll.addEventListener('pointerdown', onStageDown);
    els.stageScroll.addEventListener('wheel', onWheel, { passive: false });
    document.addEventListener('keydown', onKey);

    document.getElementById('libPickCancel').onclick = () => els.libMask.classList.add('hide');
    document.getElementById('extraCancel').onclick = () => els.extraMask.classList.add('hide');
    document.getElementById('saveCancel').onclick = () => els.saveMask.classList.add('hide');
    document.getElementById('saveOk').onclick = doSave;
    document.getElementById('outfitCancel').onclick = () => els.outfitMask.classList.add('hide');
  }

  function bindProp(id, key, cast, valId, dec, suffix) {
    const r = document.getElementById(id);
    if (!r) return;
    r.oninput = () => {
      setProp(key, cast(parseFloat(r.value)), true);
      const v = document.getElementById(valId);
      if (v) v.textContent = (dec ? parseFloat(r.value).toFixed(dec) : r.value) + (suffix || '');
    };
  }
  function toggleProp(k) {
    if (S.sel < 0) return;
    S.parts[S.sel][k] = !S.parts[S.sel][k];
    refresh();
  }
  function setProp(k, v, light) {
    if (S.sel < 0) return;
    const p = S.parts[S.sel];
    p[k] = v;
    if (light) { patchEl(S.parts, S.bbox, S.sel); } else refresh();
  }

  /* ---------------- 加载 ---------------- */
  async function load(charId) {
    U.toast('正在解析 ' + charId + ' …');
    const d = await API.character(charId);
    S.doc = d;
    S.bbox = d.bbox;
    S.sel = -1;
    S.flipAll = false;
    S.parts = d.parts.map((p, i) => ({
      id: p.id, slot: p.slot, attachment: p.attachment,
      x: p.x, y: p.y, w: p.w, h: p.h,
      active: p.active, variant: !!p.variant, hasImage: p.hasImage,
      imgUrl: p.imgUrl, origImgUrl: p.imgUrl,
      naturalW: p.naturalW, naturalH: p.naturalH, natW: p.naturalW, natH: p.naturalH,
      visible: p.active,
      dx: 0, dy: 0, sx: 1, sy: 1, rot: 0, flipX: false, flipY: false,
      opacity: 1, tint: '#ffffff', bri: 1, sat: 1, hue: 0, fit: 'fill',
      custom: false, locked: false,
      _z: i,
    }));
    els.srcNote.innerHTML = '源文件 <code>' + d.sourceFile + '</code> · 共 ' + d.parts.length +
      ' 个部件（默认显示 ' + d.parts.filter(p => p.active).length + ' 个）· 备用/变体 ' +
      d.parts.filter(p => p.variant).length + ' 个';
    els.partSearch.value = '';
    S.search = '';
    els.onlyActive.checked = false;
    S.onlyActive = false;
    els.bgSel.value = S.bg;
    applyBg();
    renderLayers();
    await renderStage();
    fit();
    if (S.parts.length) select(S.parts.map(p => p.visible).lastIndexOf(true));
    updateInfo();
    renderLayerFoot();
    return d;
  }

  /* ---------------- 渲染：舞台 ---------------- */
  async function renderStage() {
    const c = els.canvas;
    c.innerHTML = '';
    c.style.width = S.bbox.width + 'px';
    c.style.height = S.bbox.height + 'px';
    c.appendChild(frag(S.parts, S.bbox));
    const stage = els.stage;
    stage.style.width = (S.bbox.width * S.zoom) + 'px';
    stage.style.height = (S.bbox.height * S.zoom) + 'px';
    applyTransform();
    await R.preload(S.parts);
    await new Promise(r => setTimeout(r, 30));
  }
  function frag(parts, bbox) {
    const f = document.createDocumentFragment();
    parts.forEach((p, i) => f.appendChild(R.makeEl(p, bbox, i)));
    return f;
  }
  function patchEl(parts, bbox, idx) {
    const old = els.canvas.querySelector('[data-i="' + idx + '"]');
    if (!old) return renderStage();
    const nw = R.makeEl(parts[idx], bbox, idx);
    old.replaceWith(nw);
    if (idx === S.sel) nw.classList.add('sel');
  }
  function applyTransform() {
    const z = S.zoom, W = S.bbox.width;
    els.canvas.style.transform = S.flipAll
      ? 'translateX(' + (W * z) + 'px) scale(' + (-z) + ',' + z + ')'
      : 'scale(' + z + ')';
    els.stage.style.width = (S.bbox.width * z) + 'px';
    els.stage.style.height = (S.bbox.height * z) + 'px';
  }
  function applyBg() {
    const v = S.bg;
    els.canvas.className = 'canvas' + (v === 'dark' ? ' bg-dark' : v === 'light' ? ' bg-light' : v === 'grid' ? ' bg-grid' : '') +
      (els.chkOutline.checked ? '' : ' no-outline');
    if (v !== 'checker' && v !== 'dark' && v !== 'light' && v !== 'grid') {
      els.canvas.style.background = v;
      els.canvas.style.backgroundImage = 'none';
    } else {
      els.canvas.style.background = '';
      els.canvas.style.backgroundImage = '';
    }
  }
  function setZoom(z) {
    S.zoom = Math.max(0.05, Math.min(6, z));
    els.zoom.value = Math.round(S.zoom * 100);
    els.zoomV.textContent = Math.round(S.zoom * 100) + '%';
    applyTransform();
  }
  function fit() {
    const r = els.stageScroll.getBoundingClientRect();
    const pad = 62;
    const z = Math.min((r.width - pad) / S.bbox.width, (r.height - pad) / S.bbox.height);
    setZoom(isFinite(z) && z > 0 ? z : 1);
  }
  function onWheel(e) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom(S.zoom * (e.deltaY < 0 ? 1.1 : 0.9));
  }

  /* ---------------- 渲染：属性面板 ---------------- */
  function select(i) {
    if (i < 0 || i >= S.parts.length) { S.sel = -1; }
    else S.sel = i;
    U.els('.part', els.canvas).forEach((e) => e.classList.toggle('sel', +e.dataset.i === S.sel));
    U.els('.lyr', els.layers).forEach((e) => e.classList.toggle('sel', +e.dataset.i === S.sel));
    syncProps();
  }

  function syncProps() {
    const has = S.sel >= 0;
    els.propBody.classList.toggle('hide', !has);
    els.propEmpty.classList.toggle('hide', has);
    els.propBadge.textContent = has ? ('#' + (S.sel + 1) + ' / ' + S.parts.length) : '未选中';
    if (!has) return;
    const p = S.parts[S.sel];
    els.propTitle.textContent = '⚙ ' + p.slot;
    els.propThumb.src = p.imgUrl || '';
    els.propMeta.innerHTML =
      '<b>' + p.slot + '</b>' +
      '附件：' + p.attachment + '<br>' +
      '占位框：' + Math.round(p.w) + ' × ' + Math.round(p.h) + '<br>' +
      '源图：' + (p.naturalW ? p.naturalW + ' × ' + p.naturalH : '—') +
      (p.custom ? '<br><span style="color:#4f46e5">已替换为自定义图</span>' : '') +
      (p.variant ? '<br><span style="color:#b26a00">Spine 备用/变体部件</span>' : '');
    els.propBox.textContent = Math.round(p.w) + ' × ' + Math.round(p.h) + '  @ (' + p.x + ', ' + p.y + ')';
    for (const [id, key, dec, suf] of [
      ['pDx', 'dx', 1, ''], ['pDy', 'dy', 1, ''], ['pSx', 'sx', 2, ''], ['pSy', 'sy', 2, ''],
      ['pRot', 'rot', 0, '°'], ['pOp', 'opacity', 2, ''], ['pBri', 'bri', 2, ''],
      ['pSat', 'sat', 2, ''], ['pHue', 'hue', 0, '°']]) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.value = p[key];
      const v = document.getElementById(id + 'V');
      if (v) v.textContent = (dec ? (+p[key]).toFixed(dec) : p[key]) + suf;
    }
    document.getElementById('pFit').value = p.fit || 'fill';
    document.getElementById('pTint').value = p.tint || '#ffffff';
    document.getElementById('pFlipX').classList.toggle('on', !!p.flipX);
    document.getElementById('pFlipY').classList.toggle('on', !!p.flipY);
  }

  /* ---------------- 渲染：图层列表（顶部 = 最上层） ---------------- */
  function renderLayers() {
    const box = els.layers;
    box.innerHTML = '';
    let shown = 0;
    for (let i = S.parts.length - 1; i >= 0; i--) {
      const p = S.parts[i];
      if (S.search && !(p.slot.toLowerCase().includes(S.search) || p.attachment.toLowerCase().includes(S.search))) continue;
      if (S.onlyActive && !p.visible) continue;
      shown++;
      const row = document.createElement('div');
      row.className = 'lyr' + (i === S.sel ? ' sel' : '') + (p.visible ? '' : ' hidden');
      row.dataset.i = i;
      row.draggable = true;
      row.innerHTML =
        '<div class="th">' + (p.imgUrl ? '<img src="' + p.imgUrl + '" alt="">' : '') + '</div>' +
        '<div class="nm">' + p.slot + '<i>' + p.attachment + ' · ' + Math.round(p.w) + '×' + Math.round(p.h) + '</i></div>' +
        (p.custom ? '<span class="tagr">改</span>' : p.variant ? '<span class="tagv">备用</span>' : '') +
        '<div class="acts">' +
        '<button class="mini" data-a="eye" title="显示/隐藏">' + (p.visible ? '👁' : '🚫') + '</button>' +
        '<button class="mini" data-a="up" title="上传替换">⬆</button>' +
        '<button class="mini" data-a="moveup" title="上移一层">▲</button>' +
        '<button class="mini" data-a="movedown" title="下移一层">▼</button>' +
        '</div>';
      row.onclick = (e) => {
        if (e.target.dataset.a) return;
        select(i);
      };
      row.querySelector('.acts').onclick = (e) => {
        const a = e.target.dataset.a;
        if (!a) return;
        e.stopPropagation();
        if (a === 'eye') { p.visible = !p.visible; refresh(); }
        if (a === 'up') pickFileForPart(i);
        if (a === 'moveup') movePart(i, +1);
        if (a === 'movedown') movePart(i, -1);
      };
      // 拖拽排序
      row.ondragstart = (e) => { e.dataTransfer.setData('text/plain', i); row.style.opacity = '.5'; };
      row.ondragend = () => { row.style.opacity = ''; U.els('.lyr', box).forEach(x => x.classList.remove('dragover')); };
      row.ondragover = (e) => { e.preventDefault(); row.classList.add('dragover'); };
      row.ondragleave = () => row.classList.remove('dragover');
      row.ondrop = (e) => {
        e.preventDefault();
        row.classList.remove('dragover');
        const from = +e.dataTransfer.getData('text/plain');
        reorder(from, i);
      };
      box.appendChild(row);
    }
    els.partBadge.textContent = S.parts.filter(p => p.visible).length + '/' + S.parts.length;
    if (!shown) box.innerHTML = '<div class="empty">没有匹配的部件</div>';
  }

  function reorder(from, to) {
    if (from === to || isNaN(from)) return;
    const m = S.parts.splice(from, 1)[0];
    S.parts.splice(to, 0, m);
    renderLayers();
    renderStage().then(() => select(to));
  }
  function movePart(i, dir) {
    const t = i + dir;
    if (i < 0 || t < 0 || t >= S.parts.length) return;
    reorder(i, t);
  }

  /* ---------------- 部件替换 ---------------- */
  function pickFileForPart(i) {
    if (i < 0) return U.toast('先选中一个部件');
    const f = document.createElement('input');
    f.type = 'file';
    f.accept = 'image/*';
    f.onchange = async () => {
      if (!f.files || !f.files[0]) return;
      const file = f.files[0];
      const url = await U.fileToDataUrl(file);
      // 同时存进部件库，方便复用
      try {
        const up = await API.upload(file.name, url, S.doc && S.doc.id);
        Parts.refresh();
        applyReplace(i, up.url, file.name, up.w, up.h);
      } catch (e) {
        applyReplace(i, url, file.name);
      }
    };
    f.click();
  }

  function applyReplace(i, url, name, w, h) {
    const p = S.parts[i];
    p.imgUrl = url;
    p.custom = true;
    p.customName = name;
    p.natW = w || null; p.natH = h || null;
    p.visible = true;
    if (!S.doc.extras.some(e => e.url === url)) { /* noop */ }
    refresh();
    select(i);
    U.toast('已替换「' + p.slot + '」→ ' + name);
  }

  function resetPart(i) {
    if (i < 0) return;
    const p = S.parts[i];
    p.imgUrl = p.origImgUrl;
    p.custom = false; p.customName = null;
    p.dx = 0; p.dy = 0; p.sx = 1; p.sy = 1; p.rot = 0;
    p.flipX = false; p.flipY = false; p.opacity = 1;
    p.tint = '#ffffff'; p.bri = 1; p.sat = 1; p.hue = 0; p.fit = 'fill';
    p.visible = p.active;
    refresh();
    U.toast('已还原「' + p.slot + '」');
  }
  function resetAll() {
    S.parts.forEach((_, i) => {
      const p = S.parts[i];
      p.imgUrl = p.origImgUrl; p.custom = false;
      p.dx = 0; p.dy = 0; p.sx = 1; p.sy = 1; p.rot = 0;
      p.flipX = false; p.flipY = false; p.opacity = 1;
      p.tint = '#ffffff'; p.bri = 1; p.sat = 1; p.hue = 0; p.fit = 'fill';
      p.visible = p.active;
    });
    S.flipAll = false;
    refresh();
    U.toast('已全部还原为原始部件');
  }

  /* ---------------- 部件库 / 备用图 选择器 ---------------- */
  async function openLibPicker(i) {
    if (i < 0) return U.toast('先选中一个部件');
    S.libPickTarget = i;
    els.libPickHint.textContent = '目标部件：' + S.parts[i].slot;
    const data = await API.parts();
    els.libPickGrid.innerHTML = '';
    if (!data.parts.length) els.libPickGrid.innerHTML = '<div class="empty">部件库是空的，去「📦 部件库」上传</div>';
    data.parts.forEach((it) => {
      els.libPickGrid.appendChild(cardEl(it.name, it.url, it.w, it.h, (url, name, w, h) => {
        applyReplace(S.libPickTarget, url, name, w, h);
        els.libMask.classList.add('hide');
      }));
    });
    els.libMask.classList.remove('hide');
  }
  function openExtraPicker(i) {
    if (i < 0) return U.toast('先选中一个部件');
    const d = S.doc;
    els.extraGrid.innerHTML = '';
    if (!d.extras.length) els.extraGrid.innerHTML = '<div class="empty">该角色没有未被引用的备用图</div>';
    d.extras.forEach((ex) => {
      els.extraGrid.appendChild(cardEl(ex.name, ex.imgUrl, ex.naturalW, ex.naturalH, (url, name, w, h) => {
        applyReplace(i, url, name, w, h);
        els.extraMask.classList.add('hide');
      }));
    });
    els.extraMask.classList.remove('hide');
  }
  function cardEl(name, url, w, h, onPick) {
    const c = document.createElement('div');
    c.className = 'lib-card';
    c.innerHTML = '<div class="im"><img src="' + url + '" alt=""></div><div class="nm" title="' + name + '">' + name + '</div>';
    c.onclick = () => onPick(url, name, w, h);
    return c;
  }

  /* ---------------- 舞台交互 ---------------- */
  let drag = null;
  function toCanvasXY(e) {
    const r = els.canvas.getBoundingClientRect();
    let px = (e.clientX - r.left) / (r.width / S.bbox.width);
    const py = (e.clientY - r.top) / (r.height / S.bbox.height);
    if (S.flipAll) px = S.bbox.width - px;
    return { x: px, y: py };
  }
  function onStageDown(e) {
    if (e.button !== 0) return;
    const pt = toCanvasXY(e);
    const i = R.hitTest(S.parts, S.bbox, pt.x, pt.y);
    if (i < 0) { select(-1); return; }
    select(i);
    const p = S.parts[i];
    drag = { i, startX: e.clientX, startY: e.clientY, dx0: p.dx, dy0: p.dy, moved: false };
    const el = els.canvas.querySelector('[data-i="' + i + '"]');
    if (el) el.classList.add('dragging');
    els.stageScroll.setPointerCapture(e.pointerId);
    els.stageScroll.addEventListener('pointermove', onStageMove);
    els.stageScroll.addEventListener('pointerup', onStageUp);
    els.stageScroll.addEventListener('pointercancel', onStageUp);
  }
  function onStageMove(e) {
    if (!drag) return;
    const r = els.canvas.getBoundingClientRect();
    const sx = S.bbox.width / r.width, sy = S.bbox.height / r.height;
    let ddx = (e.clientX - drag.startX) * sx;
    let ddy = (e.clientY - drag.startY) * sy;
    if (S.flipAll) ddx = -ddx;
    if (Math.abs(ddx) > 0.3 || Math.abs(ddy) > 0.3) drag.moved = true;
    if (e.shiftKey) { if (Math.abs(ddx) > Math.abs(ddy)) ddy = 0; else ddx = 0; }
    const p = S.parts[drag.i];
    p.dx = Math.round((drag.dx0 + ddx) * 2) / 2;
    p.dy = Math.round((drag.dy0 + ddy) * 2) / 2;
    patchEl(S.parts, S.bbox, drag.i);
    const el = els.canvas.querySelector('[data-i="' + drag.i + '"]');
    if (el) el.classList.add('sel', 'dragging');
    if (drag.i === S.sel) {
      document.getElementById('pDx').value = p.dx;
      document.getElementById('pDxV').textContent = p.dx;
      document.getElementById('pDy').value = p.dy;
      document.getElementById('pDyV').textContent = p.dy;
    }
    setStat('拖动中：' + p.slot + '  Δ(' + p.dx + ', ' + p.dy + ')');
  }
  function onStageUp() {
    if (!drag) return;
    const i = drag.i;
    drag = null;
    els.stageScroll.removeEventListener('pointermove', onStageMove);
    els.stageScroll.removeEventListener('pointerup', onStageUp);
    els.stageScroll.removeEventListener('pointercancel', onStageUp);
    renderStage().then(() => select(i));
    updateInfo();
  }
  function onKey(e) {
    if (S.sel < 0) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
    const p = S.parts[S.sel];
    let step = e.shiftKey ? 10 : 1;
    let hit = true;
    if (e.key === 'ArrowLeft') p.dx = (p.dx || 0) - step;
    else if (e.key === 'ArrowRight') p.dx = (p.dx || 0) + step;
    else if (e.key === 'ArrowUp') p.dy = (p.dy || 0) - step;
    else if (e.key === 'ArrowDown') p.dy = (p.dy || 0) + step;
    else if (e.key === 'Delete' || e.key === 'Backspace') { resetPart(S.sel); hit = false; }
    else hit = false;
    if (hit) {
      e.preventDefault();
      patchEl(S.parts, S.bbox, S.sel);
      const el = els.canvas.querySelector('[data-i="' + S.sel + '"]');
      if (el) el.classList.add('sel');
      syncProps();
    }
  }

  /* ---------------- 状态刷新 ---------------- */
  function refresh() {
    renderLayers();
    renderStage().then(() => { if (S.sel >= 0) select(S.sel); });
    syncProps();
    updateInfo();
  }
  function updateInfo() {
    const vis = S.parts.filter(p => p.visible).length;
    const cus = S.parts.filter(p => p.custom).length;
    els.stageInfo.textContent = (S.doc ? S.doc.id : '') + ' · 画布 ' + S.bbox.width + '×' + S.bbox.height +
      ' · 显示 ' + vis + '/' + S.parts.length + (cus ? ' · 已替换 ' + cus : '');
    setStat('就绪');
  }
  function setStat(t) { els.statTxt.textContent = t; }
  function renderLayerFoot() {
    els.layerFoot.innerHTML =
      '<button class="btn sm" id="btnOutfitList">📂 套装库</button>' +
      '<button class="btn sm" id="btnImportJson">⬆ 导入套装</button>';
    document.getElementById('btnOutfitList').onclick = openOutfits;
    document.getElementById('btnImportJson').onclick = importJson;
  }

  /* ---------------- 导出 ---------------- */
  async function buildCanvas(scale) {
    scale = scale || 2;
    const W = S.bbox.width * scale, H = S.bbox.height * scale;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(W));
    c.height = Math.max(1, Math.round(H));
    const x = c.getContext('2d');
    await R.preload(S.parts);
    await R.drawTo(x, S.parts, S.bbox, scale);
    if (S.flipAll) {
      const t = document.createElement('canvas');
      t.width = c.width; t.height = c.height;
      const tx = t.getContext('2d');
      tx.translate(c.width, 0); tx.scale(-1, 1);
      tx.drawImage(c, 0, 0);
      return t;
    }
    return c;
  }
  async function exportPng() {
    setStat('正在导出 PNG …');
    const c = await buildCanvas(2);
    const name = U.sanitize((S.doc ? S.doc.id : 'char') + '_装配') + '.png';
    const a = document.createElement('a');
    a.href = c.toDataURL('image/png');
    a.download = name;
    a.click();
    setStat('已导出 ' + name + '（' + c.width + '×' + c.height + '，2× 倍率，透明背景）');
    U.toast('PNG 已导出');
  }
  function outfitData() {
    return {
      version: 1,
      charId: S.doc.id,
      parts: S.parts.map(p => ({
        id: p.id, slot: p.slot, attachment: p.attachment,
        visible: p.visible, dx: p.dx, dy: p.dy, sx: p.sx, sy: p.sy, rot: p.rot,
        flipX: !!p.flipX, flipY: !!p.flipY, opacity: p.opacity,
        tint: p.tint, bri: p.bri, sat: p.sat, hue: p.hue, fit: p.fit,
        imgUrl: p.custom ? p.imgUrl : null,
        custom: !!p.custom, customName: p.customName || null,
        // 自定义部件需要几何信息才能在别的角色上重建
        _w: p.w, _h: p.h, _x: p.x, _y: p.y,
      })),
      order: S.parts.map(p => p.id),
      flipAll: S.flipAll, bg: S.bg,
    };
  }
  function exportJson() {
    const d = outfitData();
    d.name = (S.doc.id + '_装配');
    d.exportedAt = new Date().toISOString();
    const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = U.sanitize(S.doc.id + '_套装') + '.json';
    a.click();
    U.toast('套装 JSON 已导出');
  }
  function importJson() {
    const f = document.createElement('input');
    f.type = 'file'; f.accept = '.json,application/json';
    f.onchange = async () => {
      if (!f.files[0]) return;
      try {
        const txt = await f.files[0].text();
        const d = JSON.parse(txt);
        applyOutfit(d);
        U.toast('套装已导入');
      } catch (e) { U.toast('导入失败：' + e.message); }
    };
    f.click();
  }

  /* ---------------- 套装 ---------------- */
  function openSave() {
    els.outfitName.value = (S.doc.id + ' 装配');
    els.outfitNote.value = '';
    els.saveHint.textContent = '将保存 ' + S.parts.filter(p => p.custom).length + ' 个自定义替换 + 全部变换。图片已存到 data/uploads/。';
    els.saveMask.classList.remove('hide');
  }
  async function doSave() {
    const name = els.outfitName.value.trim() || '未命名套装';
    els.saveMask.classList.add('hide');
    U.toast('正在生成缩略图…');
    const c = await buildCanvas(0.5);
    const o = outfitData();
    o.id = U.sanitize(S.doc.id + '_' + name + '_' + Date.now());
    o.name = name;
    o.note = els.outfitNote.value.trim();
    o.createdAt = Date.now();
    o.thumb = c.toDataURL('image/png');
    await API.saveOutfit(o);
    U.toast('套装「' + name + '」已保存');
  }
  async function openOutfits() {
    const d = await API.outfits();
    els.outfitList.innerHTML = '';
    if (!d.outfits.length) els.outfitList.innerHTML = '<div class="empty">还没有保存过套装</div>';
    d.outfits.forEach((o) => {
      const it = document.createElement('div');
      it.className = 'outfit-it';
      it.innerHTML =
        '<div class="th">' + (o.thumb ? '<img src="' + o.thumb + '" alt="">' : '') + '</div>' +
        '<div class="m"><b>' + (o.name || o.id) + '</b>' +
        '<span>' + o.charId + ' · ' + o.parts + ' 个部件状态 · ' +
        (o.updatedAt ? new Date(o.updatedAt).toLocaleString('zh-CN') : '') + '</span></div>';
      const b1 = document.createElement('button'); b1.className = 'btn sm pri'; b1.textContent = '载入';
      b1.onclick = async () => {
        const full = await API.outfit(o.id);
        if (full.charId !== S.doc.id) { await load(full.charId); App.setChar(full.charId); }
        applyOutfit(full);
        els.outfitMask.classList.add('hide');
        U.toast('已载入「' + (o.name || o.id) + '」');
      };
      const b2 = document.createElement('button'); b2.className = 'btn sm warn'; b2.textContent = '删除';
      b2.onclick = async () => { await API.delOutfit(o.id); openOutfits(); };
      const g = document.createElement('div'); g.style.cssText = 'display:flex;gap:6px';
      g.appendChild(b1); g.appendChild(b2);
      it.appendChild(g);
      els.outfitList.appendChild(it);
    });
    els.outfitMask.classList.remove('hide');
  }
  function applyOutfit(o) {
    if (!o || !o.parts) return;
    const map = new Map(S.parts.map(p => [p.id, p]));
    // 顺序
    if (o.order) {
      const idx = new Map(o.order.map((id, i) => [id, i]));
      S.parts.sort((a, b) => ((idx.has(a.id) ? idx.get(a.id) : 999) - (idx.has(b.id) ? idx.get(b.id) : 999)));
    }
    for (const s of o.parts) {
      let p = map.get(s.id);
      if (!p) {
        // 自定义部件：按几何信息重建
        p = {
          id: s.id, slot: s.slot, attachment: s.attachment,
          x: s._x, y: s._y, w: s._w, h: s._h, active: false, variant: true, hasImage: true,
          imgUrl: s.imgUrl, origImgUrl: s.imgUrl, naturalW: null, naturalH: null,
          visible: s.visible, dx: s.dx, dy: s.dy, sx: s.sx, sy: s.sy, rot: s.rot,
          flipX: s.flipX, flipY: s.flipY, opacity: s.opacity, tint: s.tint,
          bri: s.bri, sat: s.sat, hue: s.hue, fit: s.fit, custom: true, locked: false,
        };
        S.parts.push(p);
      } else {
        Object.assign(p, {
          visible: s.visible, dx: s.dx, dy: s.dy, sx: s.sx, sy: s.sy, rot: s.rot,
          flipX: s.flipX, flipY: s.flipY, opacity: s.opacity, tint: s.tint,
          bri: s.bri, sat: s.sat, hue: s.hue, fit: s.fit,
        });
        if (s.custom && s.imgUrl) { p.imgUrl = s.imgUrl; p.custom = true; p.customName = s.customName; }
        else { p.imgUrl = p.origImgUrl; p.custom = false; }
      }
    }
    if (o.flipAll != null) S.flipAll = o.flipAll;
    if (o.bg) { S.bg = o.bg; els.bgSel.value = o.bg; applyBg(); }
    refresh();
  }

  return {
    init, load, S, select, refresh, buildCanvas, applyOutfit,
    // 供部件库 / 外部调用
    applyReplace, resetPart, resetAll, applyBg, applyTransform, fit, setZoom,
    movePart, reorder, openLibPicker, openExtraPicker, openOutfits, openSave,
    outfitData, exportPng, exportJson, importJson, renderStage, renderLayers, syncProps,
  };
})();
