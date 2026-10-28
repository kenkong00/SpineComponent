/* ============================================================
 * cutter.js — 切割工坊 UI
 * 导入原图 → 自动切分 → 手动修边 → 命名排序 → 导出 Spine 资源
 * ============================================================ */
window.Cutter = (function () {
  'use strict';
  const M = window.CMask;
  const E = window.CutterEngine;

  const S = {
    zoom: 1,
    view: 'both',
    tool: 'wand',
    selMode: 'new',
    tol: 32,
    brush: 12,
    feather: 0,
    sel: null,          // 当前选区 Uint8Array
    selId: null,        // 当前选中部件
    picked: new Set(),  // 多选（用于合并）
    drag: null,         // 拖拽状态
    lasso: [],
    dirty: true,
    rafId: 0,
  };

  const els = {};
  let srcCv = null, srcCtx = null;   // 原图离屏
  let maskCv = null, maskCtx = null; // 分区染色层
  let selCv = null, selCtx = null;   // 选区层
  let cv = null, ctx = null;         // 屏幕画布

  /* ---------------- 初始化 ---------------- */
  function init() {
    ['cutBadge', 'cutNote', 'cutList', 'cutFoot', 'cutInfo', 'cutView', 'cutShowSel',
      'cutZoom', 'cutZoomV', 'cutFit', 'cutStage', 'cutCanvas', 'cutScroll', 'cutHint',
      'cutDrop', 'cutPick', 'cutFile', 'cutStrategy', 'cutParams', 'cutRun', 'cutRunNote',
      'cutTools', 'cutTol', 'cutTolV', 'cutBrush', 'cutBrushV', 'cutSelMode',
      'cutSelAll', 'cutSelInv', 'cutSelClear', 'cutToPart', 'cutPartAdd', 'cutPartSub',
      'cutFeather', 'cutFeatherV', 'cutGrow', 'cutShrink', 'cutSmooth',
      'cutSortY', 'cutSplit', 'cutMerge', 'cutDel',
      'cutCharId', 'cutPad', 'cutPadV', 'cutTrim', 'cutOverwrite', 'cutExport', 'cutExportNote',
      'cutAiPlan', 'cutAiCustomRow', 'cutAiCustom', 'cutAiThr', 'cutAiThrV', 'cutAiRun', 'cutAiNote',
    ].forEach((k) => els[k] = document.getElementById(k));

    cv = els.cutCanvas; ctx = cv.getContext('2d');

    els.cutPick.onclick = () => els.cutFile.click();
    els.cutFile.onchange = () => { if (els.cutFile.files[0]) loadFile(els.cutFile.files[0]); };

    const drop = els.cutDrop;
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = (e) => {
      e.preventDefault(); drop.classList.remove('over');
      const f = e.dataTransfer.files[0];
      if (f && f.type.startsWith('image/')) loadFile(f);
    };

    // 工具
    U.els('.tbtn', els.cutTools).forEach((b) => {
      b.onclick = () => {
        S.tool = b.dataset.tool;
        U.els('.tbtn', els.cutTools).forEach((x) => x.classList.toggle('on', x === b));
        updateHint();
      };
    });
    U.els('button', els.cutSelMode).forEach((b) => {
      b.onclick = () => {
        S.selMode = b.dataset.mode;
        U.els('button', els.cutSelMode).forEach((x) => x.classList.toggle('on', x === b));
      };
    });
    U.els('.tbtn', els.cutTools)[0].classList.add('on');

    // 参数滑块
    bindRange(els.cutTol, els.cutTolV, (v) => S.tol = v);
    bindRange(els.cutBrush, els.cutBrushV, (v) => S.brush = v);
    bindRange(els.cutFeather, els.cutFeatherV, (v) => S.feather = v);
    bindRange(els.cutZoom, els.cutZoomV, (v) => { S.zoom = v / 100; applyZoom(); });
    bindRange(els.cutPad, els.cutPadV, () => { });

    // 视图
    els.cutView.onchange = () => { S.view = els.cutView.value; draw(); };
    els.cutShowSel.onchange = draw;
    els.cutFit.onclick = fit;

    // 自动切分
    els.cutStrategy.onchange = () => buildParams();
    els.cutRun.onclick = runSplit;

    // AI 智能识别
    bindRange(els.cutAiThr, els.cutAiThrV, () => { });
    els.cutAiPlan.onchange = () => {
      els.cutAiCustomRow.style.display = els.cutAiPlan.value === 'custom' ? '' : 'none';
    };
    els.cutAiRun.onclick = aiRun;

    // 选区操作
    els.cutSelAll.onclick = () => { S.sel = M.create(E.S.w, E.S.h).fill(255); draw(); };
    els.cutSelInv.onclick = () => { if (S.sel) { S.sel = M.invert(S.sel); draw(); } };
    els.cutSelClear.onclick = () => { S.sel = M.create(E.S.w, E.S.h); draw(); };
    els.cutToPart.onclick = () => {
      const p = E.partFromSelection(M.clone(S.sel), null);
      if (p) { S.selId = p.id; refreshList(); note('新建部件 ' + p.name); }
      else U.toast('选区是空的');
    };
    els.cutPartAdd.onclick = () => applySel('add');
    els.cutPartSub.onclick = () => applySel('sub');
    els.cutGrow.onclick = () => morphSel('grow');
    els.cutShrink.onclick = () => morphSel('shrink');
    els.cutSmooth.onclick = () => morphSel('smooth');

    // 部件操作
    els.cutSortY.onclick = sortByPosition;
    els.cutSplit.onclick = () => {
      if (!S.selId) return U.toast('先选中一个部件');
      const made = E.splitPart(S.selId, 1);
      if (!made.length) return U.toast('该部件只有一个连通块');
      S.selId = made[0].id; refreshList(); note('拆成 ' + made.length + ' 块');
    };
    els.cutMerge.onclick = () => {
      const ids = S.picked.size >= 2 ? [...S.picked] : (S.selId ? [S.selId] : []);
      if (ids.length < 2) return U.toast('按住 Ctrl 点选至少 2 个部件再合并');
      const p = E.mergeParts(ids);
      if (p) { S.picked.clear(); S.selId = p.id; refreshList(); note('已合并 ' + ids.length + ' 个部件'); }
    };
    els.cutDel.onclick = () => {
      const ids = S.picked.size ? [...S.picked] : (S.selId ? [S.selId] : []);
      if (!ids.length) return U.toast('先选中部件');
      ids.forEach((id) => E.removePart(id));
      if (ids.includes(S.selId)) S.selId = null;
      S.picked.clear(); refreshList(); note('已删除 ' + ids.length + ' 个部件');
    };

    // 导出
    els.cutExport.onclick = doExport;

    // 画布交互
    cv.onmousedown = onDown;
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);

    buildParams();
    updateHint();
  }

  function bindRange(r, label, fn) {
    if (!r) return;
    const upd = () => { const v = Number(r.value); if (label) label.textContent = v; fn(v); };
    r.oninput = upd; upd();
  }

  function note(msg) { els.cutNote.textContent = msg; }

  /* ---------------- 自动切分参数面板 ---------------- */
  function buildParams() {
    const st = els.cutStrategy.value;
    const box = els.cutParams;
    box.innerHTML = '';
    const row = (label, html) => {
      const d = document.createElement('div');
      d.className = 'fld-row';
      d.innerHTML = '<label>' + label + '</label>' + html;
      box.appendChild(d);
      return d;
    };
    if (st === 'alpha') {
      row('最小面积', '<input type="range" id="cpMin" min="0" max="2000" step="10" value="60" class="rng"><span class="val" id="cpMinV">60</span>');
      row('Alpha 阈值', '<input type="range" id="cpA" min="0" max="128" value="8" class="rng"><span class="val" id="cpAV">8</span>');
    } else if (st === 'bgcolor') {
      row('容差', '<input type="range" id="cpTol" min="0" max="120" value="24" class="rng"><span class="val" id="cpTolV">24</span>');
      row('最小面积', '<input type="range" id="cpMin" min="0" max="2000" step="10" value="60" class="rng"><span class="val" id="cpMinV">60</span>');
      row('闭运算', '<input type="range" id="cpClose" min="0" max="8" value="0" class="rng"><span class="val" id="cpCloseV">0</span>');
    } else {
      row('列', '<input type="range" id="cpCols" min="1" max="16" value="4" class="rng"><span class="val" id="cpColsV">4</span>');
      row('行', '<input type="range" id="cpRows" min="1" max="16" value="4" class="rng"><span class="val" id="cpRowsV">4</span>');
    }
    U.els('.rng', box).forEach((r) => {
      const lab = document.getElementById(r.id + 'V');
      r.oninput = () => { if (lab) lab.textContent = r.value; };
    });
  }

  /* ---------------- 载入 ---------------- */
  function loadFromImage(img, name) {
    const info = E.loadImage(img, name);
    S.sel = M.create(info.w, info.h);
    S.selId = null; S.picked.clear();
    srcCv = document.createElement('canvas');
    srcCv.width = info.w; srcCv.height = info.h;
    srcCtx = srcCv.getContext('2d');
    srcCtx.drawImage(img, 0, 0);
    cv.width = info.w; cv.height = info.h;
    maskCv = document.createElement('canvas'); maskCv.width = info.w; maskCv.height = info.h;
    maskCtx = maskCv.getContext('2d');
    selCv = document.createElement('canvas'); selCv.width = info.w; selCv.height = info.h;
    selCtx = selCv.getContext('2d');
    els.cutCharId.value = E.S.name;
    note('已载入：' + info.w + '×' + info.h);
    // 自动检测背景类型并预选策略
    const st = detectBackground();
    els.cutStrategy.value = st; buildParams();
    runSplit();
    fit();
  }

  function loadFile(file) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      loadFromImage(img, file.name.replace(/\.[^.]+$/, ''));
      URL.revokeObjectURL(url);
    };
    img.onerror = () => U.toast('图片读取失败');
    img.src = url;
  }

  /** 从 dataURL 载入（粘贴图片 / 自动化测试用） */
  function loadFromDataURL(dataUrl, name) {
    const img = new Image();
    img.onload = () => loadFromImage(img, name || 'image');
    img.onerror = () => U.toast('图片读取失败');
    img.src = dataUrl;
  }

  /** 采样四角：透明像素多 → alpha，否则 bgcolor */
  function detectBackground() {
    const d = E.S.data, w = E.S.w, h = E.S.h;
    let transparent = 0, total = 0;
    const probe = (x, y) => { total++; if (d[(y * w + x) * 4 + 3] < 8) transparent++; };
    for (let i = 0; i < 24; i++) {
      probe(Math.floor(w * i / 24), 0);
      probe(Math.floor(w * i / 24), h - 1);
      probe(0, Math.floor(h * i / 24));
      probe(w - 1, Math.floor(h * i / 24));
    }
    return transparent / total > 0.5 ? 'alpha' : 'bgcolor';
  }

  function runSplit() {
    if (!E.S.ready) return U.toast('先导入图片');
    const st = els.cutStrategy.value;
    const g = (id) => { const e = document.getElementById(id); return e ? Number(e.value) : undefined; };
    const opt = st === 'alpha'
      ? { minArea: g('cpMin'), alphaThreshold: g('cpA') }
      : st === 'bgcolor'
        ? { tolerance: g('cpTol'), minArea: g('cpMin'), closeRadius: g('cpClose') }
        : { cols: g('cpCols'), rows: g('cpRows'), minArea: 1 };
    const t0 = performance.now();
    const r = E.autoSplit(st, opt);
    const ms = (performance.now() - t0).toFixed(0);
    // 自动按位置重排并命名：part_01 = 最上方的部件，贴近「从上到下分配图层」的直觉
    if (r.parts > 0 && st !== 'grid') sortByPosition(true);
    S.selId = E.orderedParts()[0] ? E.orderedParts()[0].id : null;
    S.sel = M.create(E.S.w, E.S.h);
    S.picked.clear();
    els.cutRunNote.textContent = r.note + ' · ' + ms + 'ms';
    note('切出 ' + r.parts + ' 个部件（' + ms + 'ms）');
    refreshList();
    rebuildMaskLayer();
    draw();
  }

  /* ---------------- AI 智能识别（YOLOv8-pose + SAM 3.1） ----------------
   * 推理在本地常驻 Python 服务（ai/ai_server.py，端口 5311），Node 只做代理。
   * 模型只加载一次（约 30 秒），之后每次推理 1~3 秒。 */
  const AI_BODY = 'hair,head,torso,arm_l,forearm_l,hand_l,arm_r,forearm_r,hand_r,' +
    'thigh_l,shin_l,foot_l,thigh_r,shin_r,foot_r';
  const AI_CLOTH = 'cloth_top,cloth_bot,shoes,hat';
  let _aiBusy = false;

  async function aiRun() {
    if (_aiBusy) return;
    if (!E.S.ready) { els.cutAiNote.textContent = '请先导入图片'; return; }
    _aiBusy = true;
    els.cutAiRun.disabled = true;
    const t0 = Date.now();
    try {
      // 1) 确保服务在跑
      let h = await (await fetch('/api/ai/health')).json();
      if (h.status !== 'ready') {
        if (h.status === 'error') throw new Error(h.err || 'AI 服务加载失败（看 ai/config.json）');
        els.cutAiNote.textContent = '正在启动 AI 服务...';
        await fetch('/api/ai/start', { method: 'POST' });
      }
      // 2) 等模型就绪
      for (;;) {
        h = await (await fetch('/api/ai/health')).json();
        if (h.status === 'ready') break;
        if (h.status === 'error') throw new Error(h.err || '模型加载失败');
        const sec = Math.round((Date.now() - t0) / 1000);
        els.cutAiNote.textContent = '模型加载中 ' + sec + 's（首次约 30 秒，之后免加载）...';
        await new Promise((r) => setTimeout(r, 1000));
        if (sec > 240) throw new Error('等待模型超时（240s）');
      }
      // 3) 组装请求
      const plan = els.cutAiPlan.value;
      const keys = plan === 'body' ? AI_BODY
        : plan === 'body_cloth' ? AI_BODY + ',' + AI_CLOTH
          : els.cutAiCustom.value;
      const parts = keys.split(',').map((s) => s.trim()).filter(Boolean);
      if (!parts.length) throw new Error('请填写自定义提示词');
      els.cutAiNote.textContent = 'AI 推理中（' + parts.length + ' 类部件，GPU）...';
      const r = await fetch('/api/ai/segment', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: srcCv.toDataURL('image/png'),
          parts,
          threshold: Number(els.cutAiThr.value) / 100,
          useBox: true,
        }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || '推理失败');
      applyAiParts(d);
    } catch (e) {
      els.cutAiNote.textContent = '❌ ' + (e.message || e);
    }
    _aiBusy = false;
    els.cutAiRun.disabled = false;
  }

  async function applyAiParts(d) {
    const t0 = performance.now();
    const got = [];
    for (const p of d.parts) {
      if (!p.ok || !p.mask) continue;
      const im = new Image();
      await new Promise((res, rej) => {
        im.onload = res; im.onerror = rej;
        im.src = 'data:image/png;base64,' + p.mask;
      });
      const c = document.createElement('canvas');
      c.width = E.S.w; c.height = E.S.h;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(im, 0, 0, E.S.w, E.S.h);   // 蒙版尺寸与原图不一致时缩放回原图
      const px = g.getImageData(0, 0, E.S.w, E.S.h).data;
      const mask = M.create(E.S.w, E.S.h);
      let n = 0;
      // 蒙版是灰度 PNG（无 alpha 通道），drawImage 后红通道=蒙版值，不能用 alpha 判断
      for (let i = 0; i < mask.length; i++) {
        if (px[i * 4] > 127) { mask[i] = 255; n++; }
      }
      if (n > 8) got.push({ name: p.name, cn: p.cn, score: p.score, mask, n });
    }
    if (!got.length) {
      els.cutAiNote.textContent = '❌ 没有检出部件：调低置信度，或改用纯文本方案';
      return;
    }
    // 按空间位置排序（先 y 后 x）—— 和手动切分一样「从上到下」
    got.sort((a, b) => {
      const ba = M.bounds(a.mask, E.S.w, E.S.h), bb = M.bounds(b.mask, E.S.w, E.S.h);
      return (ba.y - bb.y) || (ba.x - bb.x);
    });
    E.clearParts();
    const used = new Set();
    got.forEach((g) => {
      let nm = g.cn || g.name || 'part';
      if (used.has(nm)) { let k = 2; while (used.has(nm + k)) k++; nm = nm + k; }
      used.add(nm);
      const p = E.makePart(g.mask, nm);
      p.aiScore = g.score;
    });
    S.selId = null; S.picked.clear();
    S.sel = M.create(E.S.w, E.S.h);
    refreshList(); rebuildMaskLayer(); draw();
    const ms = (performance.now() - t0).toFixed(0);
    els.cutAiNote.textContent = '✅ ' + got.length + ' 个部件 · 推理 ' + d.elapsed +
      's · ' + (d.hasPose ? 'YOLO 定位+框提示' : '纯文本模式') + ' · device=' + d.device;
    note('AI 识别出 ' + got.length + ' 个部件（' + ms + 'ms）');
  }

  /* ---------------- 渲染 ---------------- */
  function rebuildMaskLayer() {
    if (!E.S.ready || !maskCtx) return;
    const W = E.S.w, H = E.S.h;
    const list = E.orderedParts();
    const owner = new Int32Array(W * H).fill(-1);
    const rgb = new Uint8Array(list.length * 3);
    list.forEach((p, k) => {
      const c = hexRgb(p.color);
      rgb[k * 3] = c[0]; rgb[k * 3 + 1] = c[1]; rgb[k * 3 + 2] = c[2];
    });
    // 只在部件包围盒内遍历（部件通常只占画面一小部分）
    list.forEach((p, k) => {
      if (!p.visible) return;
      const b = p.bbox;
      for (let y = b.y; y < b.y + b.h; y++) {
        const row = y * W;
        for (let x = b.x; x < b.x + b.w; x++) if (p.mask[row + x]) owner[row + x] = k;
      }
    });
    const img = new ImageData(W, H);
    const d = img.data;
    for (let i = 0; i < owner.length; i++) {
      const k = owner[i];
      if (k < 0) continue;
      const o = i * 4;
      d[o] = rgb[k * 3]; d[o + 1] = rgb[k * 3 + 1]; d[o + 2] = rgb[k * 3 + 2];
      d[o + 3] = 120;
    }
    maskCtx.putImageData(img, 0, 0);
  }

  function rebuildSelLayer() {
    if (!E.S.ready || !selCtx || !S.sel) return;
    const W = E.S.w, H = E.S.h;
    const img = new ImageData(W, H);
    const d = img.data;
    for (let i = 0; i < S.sel.length; i++) {
      if (!S.sel[i]) continue;
      const o = i * 4;
      d[o] = 90; d[o + 1] = 160; d[o + 2] = 255; d[o + 3] = 95;
    }
    selCtx.putImageData(img, 0, 0);
  }

  function draw() {
    if (!E.S.ready) return;
    const W = E.S.w, H = E.S.h;
    ctx.clearRect(0, 0, W, H);
    if (S.view !== 'mask') ctx.drawImage(srcCv, 0, 0);
    if (S.view !== 'src') ctx.drawImage(maskCv, 0, 0);
    if (els.cutShowSel.checked) {
      rebuildSelLayer();
      ctx.drawImage(selCv, 0, 0);
    }
    // 选中部件描边
    const p = E.byId(S.selId);
    if (p && p.bbox && p.bbox.w) {
      ctx.save();
      ctx.strokeStyle = '#ff3b30';
      ctx.lineWidth = Math.max(1, 2 / S.zoom);
      ctx.setLineDash([6 / S.zoom, 4 / S.zoom]);
      ctx.strokeRect(p.bbox.x + .5, p.bbox.y + .5, p.bbox.w - 1, p.bbox.h - 1);
      ctx.restore();
    }
    // 拖拽预览
    if (S.drag && S.drag.preview) {
      ctx.save();
      ctx.strokeStyle = '#1e6fff';
      ctx.lineWidth = Math.max(1, 1.5 / S.zoom);
      ctx.setLineDash([4 / S.zoom, 3 / S.zoom]);
      const d = S.drag;
      if (S.tool === 'rect') ctx.strokeRect(d.x0, d.y0, d.x - d.x0, d.y - d.y0);
      else if (S.tool === 'ellipse') {
        ctx.beginPath();
        ctx.ellipse((d.x0 + d.x) / 2, (d.y0 + d.y) / 2, Math.abs(d.x - d.x0) / 2, Math.abs(d.y - d.y0) / 2, 0, 0, Math.PI * 2);
        ctx.stroke();
      } else if (S.tool === 'lasso' && S.lasso.length > 1) {
        ctx.beginPath();
        ctx.moveTo(S.lasso[0].x, S.lasso[0].y);
        for (let i = 1; i < S.lasso.length; i++) ctx.lineTo(S.lasso[i].x, S.lasso[i].y);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  function scheduleDraw() {
    if (S.rafId) return;
    S.rafId = requestAnimationFrame(() => { S.rafId = 0; draw(); });
  }

  function applyZoom() {
    if (!E.S.ready) return;
    cv.style.width = (E.S.w * S.zoom) + 'px';
    cv.style.height = (E.S.h * S.zoom) + 'px';
  }

  function fit() {
    if (!E.S.ready) return;
    const box = els.cutScroll.getBoundingClientRect();
    const k = Math.min((box.width - 40) / E.S.w, (box.height - 40) / E.S.h, 6);
    S.zoom = Math.max(0.1, Math.min(6, k));
    els.cutZoom.value = Math.round(S.zoom * 100);
    els.cutZoomV.textContent = Math.round(S.zoom * 100);
    applyZoom();
  }

  function resize() { if (E.S.ready) applyZoom(); }

  /* ---------------- 画布交互 ---------------- */
  function toImg(e) {
    const r = cv.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(E.S.w - 1, Math.floor((e.clientX - r.left) / S.zoom))),
      y: Math.max(0, Math.min(E.S.h - 1, Math.floor((e.clientY - r.top) / S.zoom))),
    };
  }

  function onDown(e) {
    if (!E.S.ready || e.button !== 0) return;
    const p = toImg(e);
    if (S.tool === 'wand') {
      const m = M.magicWand(E.S.data, E.S.w, E.S.h, p.x, p.y, S.tol, true);
      S.sel = (S.selMode === 'new') ? m : M.combine(S.sel, m, S.selMode === 'add' ? 'add' : 'sub');
      if (S.selMode === 'new') S.selMode = 'new';
      // 点击处若命中某部件则顺带选中它（方便直接修边）
      const hit = hitPart(p.x, p.y);
      if (hit) { S.selId = hit.id; refreshList(); }
      draw();
      return;
    }
    if (S.tool === 'brush' || S.tool === 'eraser') {
      const part = E.byId(S.selId);
      if (!part) { U.toast('先选中一个部件再涂抹'); return; }
      S.drag = { x0: p.x, y0: p.y, x: p.x, y: p.y, painting: true };
      M.brush(part.mask, E.S.w, E.S.h, p.x, p.y, S.brush, S.tool === 'brush' ? 255 : 0);
      afterPaint(part);
      return;
    }
    // 矩形 / 椭圆 / 套索：生成选区
    S.drag = { x0: p.x, y0: p.y, x: p.x, y: p.y, preview: true };
    if (S.tool === 'lasso') S.lasso = [p];
  }

  function onMove(e) {
    if (!S.drag || !E.S.ready) return;
    const p = toImg(e);
    S.drag.x = p.x; S.drag.y = p.y;
    if (S.drag.painting) {
      const part = E.byId(S.selId);
      if (part) {
        M.brushLine(part.mask, E.S.w, E.S.h, S.drag.lx != null ? S.drag.lx : p.x, S.drag.ly != null ? S.drag.ly : p.y, p.x, p.y, S.brush, S.tool === 'brush' ? 255 : 0);
        afterPaint(part);
      }
    } else if (S.tool === 'lasso') {
      const last = S.lasso[S.lasso.length - 1];
      if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 2) S.lasso.push(p);
    }
    S.drag.lx = p.x; S.drag.ly = p.y;
    scheduleDraw();
  }

  function onUp() {
    if (!S.drag || !E.S.ready) { S.drag = null; return; }
    const d = S.drag;
    if (d.painting) {
      const part = E.byId(S.selId);
      if (part) { rebuildMaskLayer(); refreshList(); }
      S.drag = null; draw(); return;
    }
    const m = M.create(E.S.w, E.S.h);
    if (S.tool === 'rect') M.fillRect(m, E.S.w, E.S.h, d.x0, d.y0, d.x, d.y);
    else if (S.tool === 'ellipse') M.fillEllipse(m, E.S.w, E.S.h, d.x0, d.y0, d.x, d.y);
    else if (S.tool === 'lasso' && S.lasso.length > 2) M.fillPolygon(m, E.S.w, E.S.h, S.lasso);
    if (M.count(m)) {
      S.sel = (S.selMode === 'new') ? m : M.combine(S.sel, m, S.selMode === 'add' ? 'add' : 'sub');
    }
    S.drag = null; S.lasso = [];
    draw();
  }

  function afterPaint(part) {
    const c = M.centroid(part.mask, E.S.w, E.S.h);
    const b = M.bounds(part.mask, E.S.w, E.S.h);
    part.area = c ? c.n : 0;
    part.bbox = b || { x: 0, y: 0, w: 0, h: 0 };
    rebuildMaskLayer();
    scheduleDraw();
  }

  /** 命中测试：从上层往下找（后画的在上） */
  function hitPart(x, y) {
    const list = E.orderedParts();
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      if (p.visible && p.mask[y * E.S.w + x]) return p;
    }
    return null;
  }

  /* ---------------- 选区 → 部件 ---------------- */
  function applySel(mode) {
    if (!S.selId) return U.toast('先选中一个部件');
    let sel = S.sel;
    if (S.feather > 0) sel = M.feather(sel, E.S.w, E.S.h, S.feather);
    E.applySelectionToPart(S.selId, sel, mode);
    rebuildMaskLayer(); refreshList(); draw();
    note((mode === 'sub' ? '已从部件减去 ' : '已并入部件 ') + M.count(sel) + ' px');
  }

  function morphSel(kind) {
    if (!S.sel || !M.count(S.sel)) return U.toast('选区是空的');
    if (kind === 'grow') S.sel = M.dilate(S.sel, E.S.w, E.S.h, 2);
    else if (kind === 'shrink') S.sel = M.erode(S.sel, E.S.w, E.S.h, 2);
    else S.sel = M.smooth(S.sel, E.S.w, E.S.h, 2);
    if (S.feather > 0) S.sel = M.feather(S.sel, E.S.w, E.S.h, S.feather);
    draw();
  }

  /* ---------------- 部件列表 ---------------- */
  function sortByPosition(silent) {
    const list = E.orderedParts();
    list.sort((a, b) => (a.bbox.y - b.bbox.y) || (a.bbox.x - b.bbox.x));
    E.S.order = list.map((p) => p.id);
    list.forEach((p, i) => p.name = 'part_' + String(i + 1).padStart(2, '0'));
    refreshList(); rebuildMaskLayer(); draw();
    if (!silent) note('已按位置重排并重命名（从上到下）');
  }

  function refreshList() {
    const list = E.orderedParts();
    els.cutBadge.textContent = list.length;
    els.cutList.innerHTML = '';
    // order 尾部在上层，列表从上到下呈现「上层 → 下层」
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      const row = document.createElement('div');
      row.className = 'cut-item' + (p.id === S.selId ? ' on' : '') + (S.picked.has(p.id) ? ' pick' : '');
      row.dataset.id = p.id;
      row.innerHTML =
        '<img class="cut-thumb" src="' + E.partThumb(p, 40) + '" alt="">' +
        '<div class="cut-meta"><b>' + esc(p.name) + '</b>' +
        '<small>' + p.bbox.w + '×' + p.bbox.h + ' · ' + fmtK(p.area) + ' px</small></div>' +
        '<button class="cut-eye" title="显示/隐藏">' + (p.visible ? '👁' : '🚫') + '</button>';
      row.onclick = (ev) => {
        if (ev.ctrlKey || ev.metaKey) {
          S.picked.has(p.id) ? S.picked.delete(p.id) : S.picked.add(p.id);
        } else {
          S.picked.clear();
          S.selId = p.id;
        }
        refreshList(); draw();
      };
      row.querySelector('.cut-eye').onclick = (ev) => {
        ev.stopPropagation();
        E.togglePart(p.id);
        refreshList(); rebuildMaskLayer(); draw();
      };
      row.ondblclick = () => {
        const n = prompt('重命名部件', p.name);
        if (n && n.trim()) { E.renamePart(p.id, n.trim()); refreshList(); }
      };
      els.cutList.appendChild(row);
    }
    const total = list.reduce((s, p) => s + p.area, 0);
    els.cutFoot.textContent = list.length + ' 个部件 · 共 ' + fmtK(total) + ' px';
    els.cutInfo.textContent = E.S.ready ? (E.S.w + '×' + E.S.h + ' · ' + list.length + ' 部件') : '—';
  }

  const fmtK = (n) => n >= 10000 ? (n / 1000).toFixed(1) + 'k' : String(n);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function hexRgb(hex) {
    const h = hex.replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  function updateHint() {
    const map = {
      wand: '点击相近颜色的区域生成选区（容差可调），然后用「存为新部件 / 加到部件 / 从部件删」。',
      rect: '拖出矩形选区。',
      ellipse: '拖出椭圆选区。',
      lasso: '按住拖动手绘轮廓，松开闭合。',
      brush: '在「当前选中部件」上涂抹，补回缺失的像素。',
      eraser: '在「当前选中部件」上涂抹，擦掉多余的像素。',
    };
    els.cutHint.textContent = '提示：' + map[S.tool];
  }

  /* ---------------- 导出 ---------------- */
  async function doExport() {
    if (!E.S.ready) return U.toast('先导入图片');
    const list = E.orderedParts().filter((p) => p.visible && p.area > 0);
    if (!list.length) return U.toast('没有可导出的部件');
    const id = (els.cutCharId.value || '').trim();
    if (!/^[A-Za-z0-9_\-]+$/.test(id)) return U.toast('角色 ID 只能用字母/数字/下划线/连字符');

    els.cutExport.disabled = true;
    els.cutExportNote.textContent = '正在生成 PNG 与 JSON…';
    try {
      const t0 = performance.now();
      const ex = E.buildExport({ padding: Number(els.cutPad.value), trim: els.cutTrim.checked });
      const gen = (performance.now() - t0).toFixed(0);
      const t1 = performance.now();
      const r = await API.cutterExport({
        id, parts: ex.parts, skeleton: ex.skeleton, overwrite: els.cutOverwrite.checked,
      });
      const up = (performance.now() - t1).toFixed(0);
      els.cutExportNote.innerHTML = '✅ 已写入 <code>spine/' + esc(id) + '/</code>（' + r.files +
        ' 个 PNG + JSON）· 生成 ' + gen + 'ms / 上传 ' + up + 'ms';
      U.toast('导出成功，正在刷新装配台…');
      await App.reloadChars();
      App.setChar(id);
      await new Promise((r2) => setTimeout(r2, 200));
      App.switchTab('compose');
    } catch (err) {
      els.cutExportNote.textContent = '❌ ' + err.message;
      U.toast('导出失败：' + err.message, 3000);
    } finally {
      els.cutExport.disabled = false;
    }
  }

  return { init, refresh: refreshList, resize, S, loadFromDataURL };
})();
