/* ============================================================
 * skin.js — 切换演示：皮肤型源 JSON 的「部位 × 皮肤」自由混搭
 *
 * Spine 本身只能整体切一套皮肤（setSkin），这里把「皮肤」拆成
 * 「每个槽位(slot)各自选一套皮肤里的附件(attachment)」的矩阵，
 * 逐格点选即可做到：头用 02、身体用 01、手用 03 …… 任意组合。
 * 混搭结果还能合并成一个新 skin 写回 JSON，供 Spine 直接导入。
 * ============================================================ */
window.Skin = (function () {
  const S = {
    models: [],
    id: null,
    model: null,     // 服务端解析结果
    choice: {},      // slot名 -> 皮肤名（'' = 该部位不挂附件）
    hidden: {},      // slot名 -> true 隐藏
    sel: null,       // 当前选中的 slot 名
    zoom: 1,
    bg: 'checker',
    view: 'game',    // 'game' 游戏式（下拉+箭头） | 'matrix' 全览矩阵
    timer: null,     // 整套轮播
    parts: [],       // 当前绘制用的部件表
    busy: false,
  };
  const els = {};

  /* ---------------- 初始化 ---------------- */
  function init() {
    ['skModel', 'skNote', 'skQuick', 'skMatrix', 'skGame', 'skViewGame', 'skViewMatrix',
      'skFoot', 'skScroll', 'skStage', 'skCanvas',
      'skZoom', 'skZoomV', 'skBg', 'skStat', 'skDetail', 'skBadge', 'skMixName', 'skCover',
      'skPresetList', 'skSaveName', 'skSaveHint'].forEach((k) => {
        els[k] = document.getElementById(k);
      });

    document.getElementById('skReload').onclick = () => refreshModels(true);
    els.skModel.onchange = () => loadModel(els.skModel.value);
    document.getElementById('skPlay').onclick = togglePlay;
    document.getElementById('skRandom').onclick = randomize;
    document.getElementById('skReset').onclick = resetAll;
    document.getElementById('skShowAll').onclick = () => { S.hidden = {}; renderAll(); };
    document.getElementById('skFit').onclick = fit;
    document.getElementById('skPng').onclick = exportPng;
    document.getElementById('skMerge').onclick = mergeExport;
    document.getElementById('skSave').onclick = openSave;
    document.getElementById('skList').onclick = openList;

    els.skZoom.oninput = () => setZoom(els.skZoom.value / 100);
    els.skBg.onchange = () => { S.bg = els.skBg.value; applyBg(); };
    els.skScroll.addEventListener('wheel', onWheel, { passive: false });
    els.skScroll.addEventListener('pointerdown', onStageDown);

    // 混搭弹窗
    document.getElementById('skSaveCancel').onclick = () => document.getElementById('skSaveMask').classList.add('hide');
    document.getElementById('skSaveOk').onclick = doSave;
    document.getElementById('skListCancel').onclick = () => document.getElementById('skListMask').classList.add('hide');

    // 视图切换（记住上次的选择）
    let savedView = 'game';
    try { savedView = localStorage.getItem('skView') || 'game'; } catch (e) { /* 忽略 */ }
    setView(savedView === 'matrix' ? 'matrix' : 'game');
    els.skViewGame.onclick = () => setView('game');
    els.skViewMatrix.onclick = () => setView('matrix');

    refreshModels();
  }

  /* ---------------- 模型列表 ---------------- */
  async function refreshModels(force) {
    let d;
    try { d = await API.skinModels(force); } catch (e) { d = { models: [] }; }
    S.models = d.models || [];
    els.skModel.innerHTML = '';
    S.models.forEach((m) => {
      const o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.id + '   (' + m.skinNames.length + ' 套皮肤 / ' + m.slotCount + ' 部位)';
      els.skModel.appendChild(o);
    });
    if (!S.models.length) {
      els.skNote.innerHTML = '没有扫到皮肤型 JSON。<br>把 PSD「皮肤」模式导出的 JSON（<code>skins</code> 里是多套并列皮肤）连同图片目录放进 <code>spine/&lt;目录&gt;/</code>，再点 ↻。';
      els.skMatrix.innerHTML = '<div class="empty">暂无皮肤模型</div>';
      els.skGame.innerHTML = '<div class="empty">暂无皮肤模型</div>';
      els.skQuick.innerHTML = '';
      els.skDetail.innerHTML = '<div class="empty">—</div>';
      return;
    }
    await loadModel(S.models[0].id);
  }

  async function loadModel(id) {
    stopPlay();
    S.busy = true;
    let d;
    try { d = await API.skinModel(id); } catch (e) {
      S.busy = false;
      U.toast('加载失败：' + e.message);
      return;
    }
    S.model = d;
    S.id = id;
    els.skModel.value = id;
    S.choice = {};
    S.hidden = {};
    d.slots.forEach((s) => { S.choice[s.name] = firstSkinOf(s); });
    S.sel = d.slots.length ? d.slots[0].name : null;

    const cover = d.skinNames.map((sn) => {
      const miss = (d.missing[sn] || []).length;
      return sn + ':' + (d.slots.length - miss) + '/' + d.slots.length;
    }).join('  ');
    els.skNote.innerHTML = '<code>' + d.file + '</code> · 皮肤 <b>' + d.skinNames.join(' / ') +
      '</b> · 部位 <b>' + d.slots.length + '</b> · 附件选项 <b>' +
      d.slots.reduce((n, s) => n + d.skinNames.filter((sn) => s.options[sn]).length, 0) + '</b>';
    els.skCover.textContent = '覆盖 ' + cover;

    renderQuick();
    await renderStage();
    renderView();
    renderDetail();
    fit();
    updateStat();
    S.busy = false;
  }

  function firstSkinOf(slot) {
    const d = S.model;
    return d.skinNames.find((sn) => slot.options[sn]) || d.skinNames[0] || '';
  }
  function availSkins(slot) {
    return S.model.skinNames.filter((sn) => slot.options[sn]);
  }

  /* ---------------- 渲染：矩阵 ---------------- */
  function renderQuick() {
    const d = S.model;
    if (!d) return;
    els.skQuick.innerHTML = '<span class="lb" style="align-self:center">整套切换</span>';
    d.skinNames.forEach((sn) => {
      const miss = (d.missing[sn] || []).length;
      const b = document.createElement('button');
      b.className = 'btn sm';
      b.textContent = sn;
      b.title = '整套换成皮肤 ' + sn + (miss ? '（该皮肤缺 ' + miss + ' 个部位，缺的保持不变）' : '（覆盖全部部位）');
      b.onclick = () => applySet(sn);
      els.skQuick.appendChild(b);
    });
    const b2 = document.createElement('button');
    b2.className = 'btn sm';
    b2.textContent = '∅ 全部留空';
    b2.title = '把所有槽位的附件都摘掉';
    b2.onclick = () => { d.slots.forEach((s) => { S.choice[s.name] = ''; S.hidden[s.name] = false; }); renderAll(); };
    els.skQuick.appendChild(b2);
  }

  function renderMatrix() {
    const d = S.model;
    if (!d) return;
    const N = d.skinNames;
    const cols = '96px repeat(' + N.length + ',minmax(44px,1fr))';
    els.skMatrix.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'sk-row sk-head';
    head.style.gridTemplateColumns = cols;
    head.innerHTML = '<div class="sk-slot"><span class="nm">部位 \\ 皮肤</span></div>' +
      N.map((sn) => '<div class="sk-cell" style="cursor:default">' + sn + '</div>').join('');
    els.skMatrix.appendChild(head);

    d.slots.forEach((s) => {
      const cur = S.choice[s.name];
      const row = document.createElement('div');
      row.className = 'sk-row' + (S.sel === s.name ? ' sel' : '') + (S.hidden[s.name] ? ' off' : '');
      row.dataset.slot = s.name;
      row.style.gridTemplateColumns = cols;
      row.innerHTML =
        '<div class="sk-slot" title="' + s.name + '">' +
        '<button class="mini" data-a="eye">' + (S.hidden[s.name] ? '🚫' : '👁') + '</button>' +
        '<span class="nm">' + s.name + '</span><i>' + (cur || '空') + '</i></div>' +
        N.map((sn) => {
          const o = s.options[sn];
          const on = cur === sn;
          return '<div class="sk-cell' + (on ? ' on' : '') + (o ? '' : ' none') + '" data-skin="' + sn + '">' +
            (o && o.imgUrl ? '<img src="' + o.imgUrl + '" alt="" loading="lazy">' : '<span>—</span>') + '</div>';
        }).join('');

      row.onclick = (e) => {
        const eye = e.target.closest('[data-a="eye"]');
        if (eye) {
          S.hidden[s.name] = !S.hidden[s.name];
          renderAll();
          return;
        }
        const cell = e.target.closest('.sk-cell');
        if (cell && cell.dataset.skin != null) {
          if (cell.classList.contains('none')) {
            U.toast('皮肤「' + cell.dataset.skin + '」没有「' + s.name + '」这个部位');
            return;
          }
          setChoice(s.name, cell.dataset.skin);
        } else {
          S.sel = s.name;
          renderMatrix();
          renderDetail();
          highlightStage();
        }
      };
      els.skMatrix.appendChild(row);
    });
  }

  /* ---------------- 渲染：游戏式（下拉 + 左右箭头） ----------------
   * 适合皮肤很多（10~50+）的场景：每行一个部位，
   * ◀ ▶ 循环切换可用皮肤（含 ∅ 留空），下拉框直达任意一套。 */
  function partSeq(slot) {
    return availSkins(slot).concat(['']);   // 留空永远排在最后
  }

  function cyclePart(slot, dir) {
    const s = S.model.slots.find((x) => x.name === slot);
    if (!s) return;
    const seq = partSeq(s);
    let i = seq.indexOf(S.choice[slot]);
    i = i < 0 ? (dir > 0 ? 0 : seq.length - 1) : (i + dir + seq.length) % seq.length;
    setChoice(slot, seq[i]);
  }

  function renderView() {
    if (S.view === 'game') renderGame(); else renderMatrix();
  }

  function setView(v) {
    S.view = v;
    try { localStorage.setItem('skView', v); } catch (e) { /* 忽略 */ }
    els.skViewGame.classList.toggle('on', v === 'game');
    els.skViewMatrix.classList.toggle('on', v === 'matrix');
    els.skGame.classList.toggle('hide', v !== 'game');
    els.skMatrix.classList.toggle('hide', v !== 'matrix');
    renderView();
  }

  function renderGame() {
    const d = S.model;
    if (!d) return;
    els.skGame.innerHTML = '';
    d.slots.forEach((s) => {
      const cur = S.choice[s.name];
      const co = cur ? s.options[cur] : null;
      const seq = partSeq(s);
      const row = document.createElement('div');
      row.className = 'sk-g' + (S.sel === s.name ? ' sel' : '') + (S.hidden[s.name] ? ' off' : '');
      row.dataset.slot = s.name;
      row.innerHTML =
        '<button class="mini" data-a="eye" title="显示 / 隐藏该部位">' + (S.hidden[s.name] ? '🚫' : '👁') + '</button>' +
        '<span class="nm" data-a="sel" title="' + s.name + '（点我看详情）">' + s.name + '</span>' +
        '<span class="th" data-a="sel" title="当前：' + (cur || '留空') + '">' +
          (co && co.imgUrl ? '<img src="' + co.imgUrl + '" alt="" loading="lazy">' : '<i>∅</i>') + '</span>' +
        '<button class="arr" data-a="prev" title="上一套">◀</button>' +
        '<select class="gv" data-a="pick">' +
          seq.map((sn) => '<option value="' + sn + '"' + (cur === sn ? ' selected' : '') + '>' +
            (sn || '∅ 留空') + '</option>').join('') +
        '</select>' +
        '<button class="arr" data-a="next" title="下一套">▶</button>';

      row.onclick = (e) => {
        const act = e.target.closest('[data-a]');
        if (!act) return;
        const a = act.dataset.a;
        if (a === 'eye') { S.hidden[s.name] = !S.hidden[s.name]; renderAll(); return; }
        if (a === 'prev') { cyclePart(s.name, -1); return; }
        if (a === 'next') { cyclePart(s.name, +1); return; }
        if (a === 'sel') { S.sel = s.name; renderGame(); renderDetail(); highlightStage(); }
      };
      row.querySelector('[data-a="pick"]').onchange = (e) => setChoice(s.name, e.target.value);

      els.skGame.appendChild(row);
    });
  }

  /* ---------------- 渲染：右侧详情 ---------------- */
  function renderDetail() {
    const d = S.model;
    if (!d) return;
    const s = d.slots.find((x) => x.name === S.sel);
    els.skBadge.textContent = s ? s.name : '—';
    if (!s) { els.skDetail.innerHTML = '<div class="empty">在左侧矩阵里点一个部位</div>'; return; }

    const cur = S.choice[s.name];
    const co = cur ? s.options[cur] : null;
    let html = '<div class="sec">' + s.name + '</div>';
    html += '<div class="sk-opts">';
    d.skinNames.forEach((sn) => {
      const o = s.options[sn];
      html += '<div class="sk-opt' + (cur === sn ? ' on' : '') + (o ? '' : ' none') + '" data-skin="' + sn + '">' +
        '<div class="im">' + (o && o.imgUrl ? '<img src="' + o.imgUrl + '" alt="">' : '<span style="color:var(--tx3)">—</span>') + '</div>' +
        '<div class="nm">' + sn + '</div>' +
        '<div class="sub">' + (o ? (o.naturalW ? o.naturalW + '×' + o.naturalH : '框 ' + Math.round(o.w) + '×' + Math.round(o.h)) : '无此部位') + '</div>' +
        '</div>';
    });
    html += '<div class="sk-opt' + (cur === '' ? ' on' : '') + '" data-skin="">' +
      '<div class="im"><span style="color:var(--tx3);font-size:22px">∅</span></div>' +
      '<div class="nm">留空</div><div class="sub">不挂附件</div></div>';
    html += '</div>';

    html += '<div class="fld-row"><label>显示</label>' +
      '<button class="btn sm tgl' + (S.hidden[s.name] ? '' : ' on') + '" data-a="eye">' +
      (S.hidden[s.name] ? '已隐藏（点我显示）' : '显示中（点我隐藏）') + '</button></div>';

    html += '<div class="sec">信息</div>';
    html += '<div class="sk-kv"><span>骨骼</span><b>' + s.bone + '</b></div>';
    html += '<div class="sk-kv"><span>当前皮肤</span><b>' + (cur || '留空') + '</b></div>';
    html += '<div class="sk-kv"><span>附件名</span><b>' + (co ? co.attachment : '—') + '</b></div>';
    html += '<div class="sk-kv"><span>占位框</span><b>' + (co ? Math.round(co.w) + '×' + Math.round(co.h) : '—') + '</b></div>';
    html += '<div class="sk-kv"><span>中心坐标</span><b>' + (co ? co.x + ', ' + co.y : '—') + '</b></div>';
    html += '<div class="sk-kv"><span>源图</span><b>' + (co ? (co.naturalW ? co.naturalW + '×' + co.naturalH : '缺失') : '—') + '</b></div>';
    if (co && co.name) html += '<div class="hint" style="padding:6px 0">图片路径 <code>' + co.name + '</code></div>';
    if (!co) html += '<div class="hint">该部位当前没有挂附件，舞台上是空的。</div>';

    els.skDetail.innerHTML = html;
    els.skDetail.onclick = (e) => {
      const eye = e.target.closest('[data-a="eye"]');
      if (eye) { S.hidden[s.name] = !S.hidden[s.name]; renderAll(); return; }
      const opt = e.target.closest('.sk-opt');
      if (!opt || opt.dataset.skin == null) return;
      if (!opt.classList.contains('none') || opt.dataset.skin === '') setChoice(s.name, opt.dataset.skin);
      else U.toast('皮肤「' + opt.dataset.skin + '」没有「' + s.name + '」这个部位');
    };
  }

  /* ---------------- 选择 ---------------- */
  function setChoice(slot, skin) {
    const d = S.model;
    const s = d.slots.find((x) => x.name === slot);
    if (!s) return;
    if (skin && !s.options[skin]) return;
    S.choice[slot] = skin;
    if (skin) S.hidden[slot] = false;
    S.sel = slot;
    renderAll();
  }

  function applySet(sn) {
    const d = S.model;
    let changed = 0;
    d.slots.forEach((s) => {
      if (s.options[sn]) { if (S.choice[s.name] !== sn) changed++; S.choice[s.name] = sn; S.hidden[s.name] = false; }
    });
    renderAll();
    U.toast('整套切换 → ' + sn + (changed ? '（' + changed + ' 个部位）' : ''));
  }

  function randomize() {
    const d = S.model;
    d.slots.forEach((s) => {
      const av = availSkins(s);
      S.choice[s.name] = av.length ? av[Math.floor(Math.random() * av.length)] : '';
      S.hidden[s.name] = false;
    });
    renderAll();
    U.toast('已随机混搭');
  }
  function resetAll() {
    stopPlay();
    S.model.slots.forEach((s) => { S.choice[s.name] = firstSkinOf(s); S.hidden[s.name] = false; });
    renderAll();
    U.toast('已重置为第一套皮肤');
  }

  function renderAll() {
    renderView();
    renderDetail();
    renderStage().then(() => { highlightStage(); updateStat(); });
    updateStat();
  }

  /* ---------------- 舞台 ---------------- */
  function buildParts() {
    const d = S.model;
    if (!d) return [];
    const out = [];
    d.slots.forEach((s) => {
      const sn = S.choice[s.name];
      const o = sn ? s.options[sn] : null;
      if (!o) return;
      out.push({
        id: s.name + '::' + o.skin,
        slot: s.name,
        skin: o.skin,
        attachment: o.attachment,
        x: o.x, y: o.y, w: o.w, h: o.h,
        imgUrl: o.imgUrl,
        naturalW: o.naturalW, naturalH: o.naturalH,
        natW: o.naturalW, natH: o.naturalH,
        visible: !S.hidden[s.name] && !!o.imgUrl,
        dx: 0, dy: 0, sx: o.scaleX || 1, sy: o.scaleY || 1, rot: o.rot || 0,
        flipX: false, flipY: false, opacity: 1, tint: '#ffffff', fit: 'fill',
        bri: 1, sat: 1, hue: 0,
      });
    });
    return out;
  }

  async function renderStage() {
    const d = S.model;
    if (!d) return;
    S.parts = buildParts();
    const c = els.skCanvas;
    c.innerHTML = '';
    c.style.width = d.bbox.width + 'px';
    c.style.height = d.bbox.height + 'px';
    const f = document.createDocumentFragment();
    S.parts.forEach((p, i) => f.appendChild(R.makeEl(p, d.bbox, i)));
    c.appendChild(f);
    applyTransform();
    applyBg();
    highlightStage();
    try { await R.preload(S.parts); } catch (e) { /* 忽略单图加载失败 */ }
  }

  function highlightStage() {
    U.els('.part', els.skCanvas).forEach((e) => {
      const p = S.parts[+e.dataset.i];
      e.classList.toggle('sel', !!p && p.slot === S.sel);
    });
  }

  function applyTransform() {
    const d = S.model;
    if (!d) return;
    els.skCanvas.style.transform = 'scale(' + S.zoom + ')';
    els.skStage.style.width = (d.bbox.width * S.zoom) + 'px';
    els.skStage.style.height = (d.bbox.height * S.zoom) + 'px';
  }
  function applyBg() {
    const v = S.bg;
    els.skCanvas.className = 'canvas' + (v === 'dark' ? ' bg-dark' : v === 'light' ? ' bg-light' : v === 'grid' ? ' bg-grid' : '');
    if (v !== 'checker' && v !== 'dark' && v !== 'light' && v !== 'grid') {
      els.skCanvas.style.background = v;
      els.skCanvas.style.backgroundImage = 'none';
    } else {
      els.skCanvas.style.background = '';
      els.skCanvas.style.backgroundImage = '';
    }
  }
  function setZoom(z) {
    const d = S.model;
    if (!d) return;
    S.zoom = Math.max(0.05, Math.min(6, z));
    els.skZoom.value = Math.round(S.zoom * 100);
    els.skZoomV.textContent = Math.round(S.zoom * 100) + '%';
    applyTransform();
  }
  function fit() {
    const d = S.model;
    if (!d) return;
    const r = els.skScroll.getBoundingClientRect();
    const pad = 62;
    const z = Math.min((r.width - pad) / d.bbox.width, (r.height - pad) / d.bbox.height);
    setZoom(isFinite(z) && z > 0 ? z : 1);
  }
  function onWheel(e) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom(S.zoom * (e.deltaY < 0 ? 1.1 : 0.9));
  }

  function toCanvasXY(e) {
    const d = S.model;
    const r = els.skCanvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) / (r.width / d.bbox.width),
      y: (e.clientY - r.top) / (r.height / d.bbox.height),
    };
  }
  function onStageDown(e) {
    const d = S.model;
    if (!d || e.button !== 0) return;
    const pt = toCanvasXY(e);
    const i = R.hitTest(S.parts, d.bbox, pt.x, pt.y);
    if (i < 0) return;
    S.sel = S.parts[i].slot;
    renderView();
    renderDetail();
    highlightStage();
  }

  /* ---------------- 整套轮播 ---------------- */
  function togglePlay() {
    const btn = document.getElementById('skPlay');
    if (S.timer) { stopPlay(); return; }
    if (!S.model) return;
    let i = S.model.skinNames.indexOf(S.choice[S.model.slots[0].name]);
    if (i < 0) i = 0;
    S.timer = setInterval(() => {
      const d = S.model;
      i = (i + 1) % d.skinNames.length;
      d.slots.forEach((s) => { if (s.options[d.skinNames[i]]) { S.choice[s.name] = d.skinNames[i]; S.hidden[s.name] = false; } });
      renderView();
      renderDetail();
      renderStage().then(updateStat);
      updateStat();
    }, 700);
    btn.textContent = '⏸ 停止轮播';
    btn.classList.add('pri');
  }
  function stopPlay() {
    if (!S.timer) return;
    clearInterval(S.timer);
    S.timer = null;
    const btn = document.getElementById('skPlay');
    btn.textContent = '▶ 整套轮播';
    btn.classList.add('pri');
  }

  /* ---------------- 状态 ---------------- */
  function updateStat() {
    const d = S.model;
    if (!d) { els.skStat.textContent = '就绪'; return; }
    const base = d.skinNames[0];
    const diff = d.slots.filter((s) => S.choice[s.name] !== base && S.choice[s.name]).length;
    const empty = d.slots.filter((s) => !S.choice[s.name]).length;
    const hidden = d.slots.filter((s) => S.hidden[s.name]).length;
    const shown = S.parts.filter((p) => p.visible).length;
    els.skStat.textContent = d.id + ' · ' + d.skinNames.length + ' 套皮肤 / ' + d.slots.length + ' 部位 · ' +
      '显示 ' + shown + ' · ' + (diff ? '混搭 ' + diff + ' 处（相对 ' + base + '）' : '纯 ' + base + ' 一套') +
      (empty ? ' · 留空 ' + empty : '') + (hidden ? ' · 隐藏 ' + hidden : '');
  }

  /* ---------------- 导出 ---------------- */
  async function exportPng() {
    const d = S.model;
    if (!d) return;
    const scale = 2;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(d.bbox.width * scale));
    c.height = Math.max(1, Math.round(d.bbox.height * scale));
    const x = c.getContext('2d');
    await R.preload(S.parts);
    await R.drawTo(x, S.parts, d.bbox, scale);
    const a = document.createElement('a');
    a.href = c.toDataURL('image/png');
    a.download = U.sanitize(d.dir + '_' + (els.skMixName.value || 'mix')) + '.png';
    a.click();
    U.toast('PNG 已导出（' + c.width + '×' + c.height + '，透明背景）');
  }

  async function mergeExport() {
    const d = S.model;
    if (!d) return U.toast('先选一个皮肤模型');
    const name = (els.skMixName.value || '').trim() || 'mix';
    let r;
    try {
      r = await API.skinMerge({ id: d.id, choice: S.choice, skinName: name, asDefault: true });
    } catch (e) { return U.toast('导出失败：' + e.message); }
    const blob = new Blob([JSON.stringify(r.json, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = r.fileName;
    a.click();
    U.toast('已导出 ' + r.fileName + '：新皮肤「' + r.skinName + '」含 ' + r.attachments + ' 个部位' +
      (r.asDefault ? '，并同步写为 default' : ''));
  }

  /* ---------------- 混搭预设 ---------------- */
  function openSave() {
    const d = S.model;
    if (!d) return;
    const base = d.skinNames[0];
    const diff = d.slots.filter((s) => S.choice[s.name] !== base && S.choice[s.name]).length;
    els.skSaveName.value = diff ? (base + '+混搭' + diff) : (base + '整套');
    els.skSaveHint.innerHTML = '保存后可在「📂 混搭库」随时读回。存的是<b>部位→皮肤</b>这张表，不含图片，所以只要素材还在就能一直用。';
    document.getElementById('skSaveMask').classList.remove('hide');
  }
  async function doSave() {
    const d = S.model;
    document.getElementById('skSaveMask').classList.add('hide');
    const name = els.skSaveName.value.trim() || '未命名混搭';
    const o = {
      id: U.sanitize(d.dir + '_' + name + '_' + Date.now()),
      name, modelId: d.id, modelName: d.dir,
      skinNames: d.skinNames,
      choice: Object.assign({}, S.choice),
      hidden: Object.assign({}, S.hidden),
      createdAt: Date.now(),
    };
    try { await API.saveSkinMix(o); U.toast('混搭「' + name + '」已保存'); }
    catch (e) { U.toast('保存失败：' + e.message); }
  }

  async function openList() {
    let d;
    try { d = await API.skinMixes(); } catch (e) { return U.toast('读取失败：' + e.message); }
    const list = (d.mixes || []).filter((m) => !S.model || m.modelId === S.model.id);
    els.skPresetList.innerHTML = '';
    if (!list.length) {
      els.skPresetList.innerHTML = '<div class="empty">' +
        (S.model ? '这个模型还没存过混搭' : '还没有混搭') + '</div>';
    }
    list.forEach((m) => {
      const it = document.createElement('div');
      it.className = 'outfit-it';
      const diff = Object.keys(m.choice || {}).filter((k) => m.choice[k] !== (m.skinNames || [])[0]).length;
      it.innerHTML = '<div class="m"><b>' + (m.name || m.id) + '</b><span>' + (m.modelName || m.modelId) +
        ' · 覆盖 ' + Object.keys(m.choice || {}).length + ' 个部位' + (diff ? ' · 混搭 ' + diff + ' 处' : '') +
        ' · ' + (m.updatedAt ? new Date(m.updatedAt).toLocaleString('zh-CN') : '') + '</span></div>';
      const b1 = document.createElement('button'); b1.className = 'btn sm pri'; b1.textContent = '载入';
      b1.onclick = () => applyMix(m);
      const b2 = document.createElement('button'); b2.className = 'btn sm warn'; b2.textContent = '删除';
      b2.onclick = async () => { await API.delSkinMix(m.id); openList(); };
      const g = document.createElement('div'); g.style.cssText = 'display:flex;gap:6px';
      g.appendChild(b1); g.appendChild(b2);
      it.appendChild(g);
      els.skPresetList.appendChild(it);
    });
    document.getElementById('skListMask').classList.remove('hide');
  }
  function applyMix(m) {
    const d = S.model;
    if (!d) return;
    if (m.modelId !== d.id) { U.toast('这是「' + (m.modelName || m.modelId) + '」的混搭，当前模型不匹配'); return; }
    d.slots.forEach((s) => {
      const sn = (m.choice || {})[s.name];
      if (sn == null) return;
      S.choice[s.name] = (sn && s.options[sn]) ? sn : (sn === '' ? '' : S.choice[s.name]);
      S.hidden[s.name] = !!(m.hidden || {})[s.name];
    });
    document.getElementById('skListMask').classList.add('hide');
    renderAll();
    U.toast('已载入「' + (m.name || m.id) + '」');
  }

  /* ---------------- 给 app.js 用 ---------------- */
  function resize() {
    if (!S.model) return;
    applyTransform();
    setTimeout(fit, 30);
  }

  return { init, resize, refreshModels, S, fit, renderStage };
})();
