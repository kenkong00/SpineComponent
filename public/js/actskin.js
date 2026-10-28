/* ============================================================
 * actskin.js — 🎭 动画换装：会动、绑了骨骼的角色，逐部位自由混搭皮肤
 *
 * 素材：Spine 「导出」目录（json + atlas + 一张整合的 png）。
 * 它和「切换演示」的区别是——图片被打包进一张图，且角色是骨骼驱动的、会动。
 *
 * Spine 运行时只支持「整套 setSkin(skinName)」或「一次性套用某套」。但本模块用
 *   skeleton.setSkin( 自建的 mix 皮肤 )
 * 把每个槽位各自挑一套皮肤里的 attachment 塞进同一个 Skin，于是可以「头用 02、身用 01」。
 * 因为该角色的动画只动骨骼、不动 attachment（已验证 animation 只有 bones 时间线），
 * mix 皮肤一旦设好就稳定保持，动画照常播放 —— 等于在不动 Spine 的前提下，单部件任意换。
 * ============================================================ */
window.ActSkin = (function () {
  const S = {
    models: [],
    id: null,
    model: null,       // 服务端返回的 export 元信息
    json: null,        // 客户端读到的骨架 JSON（拿皮肤名/槽位名）
    skeleton: null,    // player.skeleton
    player: null,
    skins: [],         // 皮肤名数组 ['01','02','03']
    slots: [],         // 槽位名数组
    choice: {},        // slot名 -> 皮肤名（'' = 该部位不挂附件）
    hidden: {},        // slot名 -> true 隐藏
    thumbs: {},        // thumbs[皮肤名][slot名] = dataURL（从烘焙 atlas 裁出来的部件图）
    sel: null,
    view: 'game',
    playing: true,
    loop: true,
    speed: 1,
    anim: null,
    zoom: 1,          // 画面缩放（基于动作自适应视口）
    baseViewport: null, // setAnimation 算出的原始视口，缩放围绕它的中心
  };
  const els = {};

  function init() {
    ['akModel', 'akNote', 'akQuick', 'akMatrix', 'akGame', 'akViewGame', 'akViewMatrix',
      'akFoot', 'akPlayerHost', 'akScroll', 'akStat', 'akDetail', 'akBadge', 'akCover',
      'akAnim', 'akSpeed', 'akSpeedV', 'akBg', 'akSaveName', 'akSaveHint', 'akPresetList',
      'akZoom', 'akZoomV']
      .forEach((k) => els[k] = document.getElementById(k));

    document.getElementById('akReload').onclick = () => refreshModels(true);
    els.akModel.onchange = () => loadModel(els.akModel.value);
    document.getElementById('akPlay').onclick = togglePlay;
    document.getElementById('akLoop').onclick = toggleLoop;
    els.akSpeed.oninput = () => {
      S.speed = parseFloat(els.akSpeed.value);
      els.akSpeedV.textContent = S.speed.toFixed(2) + '×';
      if (S.player && S.player.animationState) S.player.animationState.timeScale = S.speed;
    };
    els.akAnim.onchange = () => setAnim(els.akAnim.value);
    els.akBg.onchange = applyBg;
    els.akZoom.oninput = () => setZoom(parseFloat(els.akZoom.value));
    // 画面上滚轮缩放
    els.akPlayerHost.addEventListener('wheel', (e) => {
      if (!S.player) return;
      e.preventDefault();
      setZoom(S.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
    }, { passive: false });
    document.getElementById('akReset').onclick = resetAll;
    document.getElementById('akRandom').onclick = () => { randomize(); U.toast('已随机混搭'); };
    document.getElementById('akShot').onclick = shot;
    document.getElementById('akShowAll').onclick = () => { S.hidden = {}; renderAll(); };
    document.getElementById('akSave').onclick = openSave;
    document.getElementById('akList').onclick = openList;
    document.getElementById('akSaveCancel').onclick = () => document.getElementById('akSaveMask').classList.add('hide');
    document.getElementById('akSaveOk').onclick = doSave;
    document.getElementById('akListCancel').onclick = () => document.getElementById('akListMask').classList.add('hide');

    // 视图切换（记住上次选择）
    let savedView = 'game';
    try { savedView = localStorage.getItem('akView') || 'game'; } catch (e) { /* 忽略 */ }
    setView(savedView === 'matrix' ? 'matrix' : 'game');
    els.akViewGame.onclick = () => setView('game');
    els.akViewMatrix.onclick = () => setView('matrix');

    refreshModels();
  }

  /* ---------------- 模型列表 ---------------- */
  async function refreshModels(force) {
    let d;
    try { d = await API.actSkins(force); } catch (e) { d = { models: [] }; }
    S.models = d.models || [];
    els.akModel.innerHTML = '';
    S.models.forEach((m) => {
      const o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.label + '  (' + m.skinCount + ' 套皮肤 / ' + m.slotCount + ' 部位 / ' + m.animations.length + ' 动作)';
      els.akModel.appendChild(o);
    });
    if (!S.models.length) {
      els.akNote.innerHTML = '没有扫到「带皮肤的动画导出」。<br>需要 <code>spine/&lt;角色&gt;/&lt;导出目录&gt;/</code> 下有 json+atlas+png，且 <b>皮肤 &gt; 1 套 + 有动画</b>。';
      els.akQuick.innerHTML = ''; els.akMatrix.innerHTML = '<div class="empty">暂无</div>'; els.akGame.innerHTML = '<div class="empty">暂无</div>';
      els.akDetail.innerHTML = '<div class="empty">—</div>';
      return;
    }
    await loadModel(S.models[0].id);
  }

  async function loadModel(id) {
    const m = S.models.find((x) => x.id === id);
    if (!m) return;
    S.id = id; S.model = m; S.skeleton = null; S.player = null;
    S.baseViewport = null;
    els.akModel.value = id;
    // 先读骨架 JSON 拿皮肤名 / 槽位名（与运行时解耦，渲染列表用）
    try {
      const r = await fetch(m.jsonUrl);
      S.json = await r.json();
    } catch (e) { S.json = null; U.toast('读取骨架失败：' + e.message); }
    S.skins = (S.json && Array.isArray(S.json.skins)) ? S.json.skins.map((s) => s.name) : (m.spineVersion ? [] : []);
    S.slots = (S.json && Array.isArray(S.json.slots)) ? S.json.slots.map((s) => s.name) : [];
    if (!S.skins.length) { els.akNote.innerHTML = '该导出没有多套皮肤'; return; }

    els.akNote.innerHTML = '<code>' + m.label + '</code> · Spine ' + m.spineVersion +
      ' · 皮肤 <b>' + S.skins.join(' / ') + '</b> · 部位 <b>' + S.slots.length + '</b> · 动作 <b>' + m.animations.join(' / ') + '</b>';

    S.choice = {}; S.hidden = {}; S.thumbs = {};
    S.slots.forEach((s) => { S.choice[s] = S.skins[0]; });
    S.sel = S.slots.length ? S.slots[0] : null;

    // 动作下拉
    els.akAnim.innerHTML = '';
    m.animations.forEach((nm) => {
      const o = document.createElement('option'); o.value = nm; o.textContent = nm; els.akAnim.appendChild(o);
    });
    S.anim = m.animations[0];

    renderQuick();
    buildPlayer(m);
  }

  /* ---------------- 缩略图：从烘焙 atlas 裁部件 ----------------
   * 图片都打包在一张 png 里，但运行时的每个 attachment.region 记录了它在图集里的
   * 精确矩形（x/y/宽/高/degrees）。rotate:true（degrees=90）时页内矩形宽高互换、
   * 顺时针转 90° 才是原方向（对照运行时 RegionAttachment.setRegion 的角点映射推导）。
   * 裁出来转 dataURL，三个视图（游戏式行 / 矩阵格 / 右侧详情）都用它当小图。 */
  function buildThumbs() {
    S.thumbs = {};
    if (!S.skeleton || !spine || !spine.TextureAtlasRegion) return;
    const data = S.skeleton.data;
    data.skins.forEach((sk) => {
      if (!sk.getAttachments) return;
      sk.getAttachments().forEach((e) => {
        const att = e.attachment;
        const reg = att && att.region;
        if (!reg || !(reg instanceof spine.TextureAtlasRegion) || !reg.texture) return;
        let img = null;
        try { img = reg.texture.getImage(); } catch (err) { /* 忽略 */ }
        if (!img || !img.width) return;
        const url = cropRegion(img, reg);
        if (!url) return;
        (S.thumbs[sk.name] = S.thumbs[sk.name] || {})[data.slots[e.slotIndex].name] = { url, w: reg.width, h: reg.height };
      });
    });
  }
  function cropRegion(img, reg) {
    const w = Math.max(1, Math.round(reg.width)), h = Math.max(1, Math.round(reg.height));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    try {
      if (reg.degrees === 90) {
        // 页内矩形是 (x, y, h, w)，顺时针转 90° 还原
        ctx.translate(w, 0);
        ctx.rotate(Math.PI / 2);
        ctx.drawImage(img, reg.x, reg.y, h, w, 0, 0, h, w);
      } else {
        ctx.drawImage(img, reg.x, reg.y, w, h, 0, 0, w, h);
      }
      return c.toDataURL('image/png');
    } catch (e) { return null; }
  }
  function thumbOf(slot, skin) {
    return (S.thumbs[skin] || {})[slot] || null;
  }

  /* ---------------- 渲染：quick 整套按钮 ---------------- */
  function renderQuick() {
    const d = S.model; if (!d) return;
    els.akQuick.innerHTML = '<span class="lb" style="align-self:center">整套切换</span>';
    S.skins.forEach((sn) => {
      const b = document.createElement('button');
      b.className = 'btn sm'; b.textContent = sn; b.title = '整套换成皮肤 ' + sn;
      b.onclick = () => applySet(sn);
      els.akQuick.appendChild(b);
    });
    const b2 = document.createElement('button');
    b2.className = 'btn sm'; b2.textContent = '∅ 全部留空';
    b2.title = '把所有槽位都摘掉附件';
    b2.onclick = () => { S.slots.forEach((s) => { S.choice[s] = ''; S.hidden[s] = false; }); applyMix(); renderAll(); };
    els.akQuick.appendChild(b2);
  }

  /* ---------------- 渲染：游戏式 / 矩阵 ---------------- */
  function partSeq(slot) {
    const av = availSkins(slot);
    return av.concat(['']);    // 留空永远在最后
  }
  function availSkins(slot) {
    if (!S.skeleton) return S.skins.slice();
    const idx = S.skeleton.findSlotIndex(slot);
    return S.skins.filter((sn) => {
      const sk = S.skeleton.data.findSkin(sn);
      return sk && !!sk.getAttachment(idx, slot);
    });
  }
  function cyclePart(slot, dir) {
    const seq = partSeq(slot);
    let i = seq.indexOf(S.choice[slot]);
    i = i < 0 ? (dir > 0 ? 0 : seq.length - 1) : (i + dir + seq.length) % seq.length;
    setChoice(slot, seq[i]);
  }
  function renderView() { if (S.view === 'game') renderGame(); else renderMatrix(); }
  function setView(v) {
    S.view = v;
    try { localStorage.setItem('akView', v); } catch (e) { }
    els.akViewGame.classList.toggle('on', v === 'game');
    els.akViewMatrix.classList.toggle('on', v === 'matrix');
    els.akGame.classList.toggle('hide', v !== 'game');
    els.akMatrix.classList.toggle('hide', v !== 'matrix');
    renderView();
  }

  function renderGame() {
    els.akGame.innerHTML = '';
    S.slots.forEach((slot) => {
      const cur = S.choice[slot];
      const seq = partSeq(slot);
      const th = thumbOf(slot, cur);
      const row = document.createElement('div');
      row.className = 'sk-g' + (S.sel === slot ? ' sel' : '') + (S.hidden[slot] ? ' off' : '');
      row.dataset.slot = slot;
      row.innerHTML =
        '<button class="mini" data-a="eye" title="显示 / 隐藏">' + (S.hidden[slot] ? '🚫' : '👁') + '</button>' +
        '<span class="nm" data-a="sel" title="' + slot + '（点我看详情）">' + slot + '</span>' +
        '<span class="th" data-a="sel" title="当前：' + (cur || '留空') + '">' +
          (th ? '<img src="' + th.url + '" alt="">' : '<i>' + (cur || '∅') + '</i>') + '</span>' +
        '<button class="arr" data-a="prev" title="上一套">◀</button>' +
        '<select class="gv" data-a="pick">' +
          seq.map((sn) => '<option value="' + sn + '"' + (cur === sn ? ' selected' : '') + '>' + (sn || '∅ 留空') + '</option>').join('') +
        '</select>' +
        '<button class="arr" data-a="next" title="下一套">▶</button>';
      row.onclick = (e) => {
        const a = e.target.closest('[data-a]'); if (!a) return;
        const act = a.dataset.a;
        if (act === 'eye') { S.hidden[slot] = !S.hidden[slot]; renderAll(); return; }
        if (act === 'prev') { cyclePart(slot, -1); return; }
        if (act === 'next') { cyclePart(slot, +1); return; }
        if (act === 'sel') { S.sel = slot; renderGame(); renderDetail(); }
      };
      row.querySelector('[data-a="pick"]').onchange = (e) => setChoice(slot, e.target.value);
      els.akGame.appendChild(row);
    });
  }

  function renderMatrix() {
    const N = S.skins;
    const cols = '96px repeat(' + N.length + ',minmax(44px,1fr))';
    els.akMatrix.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'sk-row sk-head';
    head.style.gridTemplateColumns = cols;
    head.innerHTML = '<div class="sk-slot"><span class="nm">部位 \\ 皮肤</span></div>' +
      N.map((sn) => '<div class="sk-cell" style="cursor:default">' + sn + '</div>').join('');
    els.akMatrix.appendChild(head);

    S.slots.forEach((slot) => {
      const cur = S.choice[slot];
      const row = document.createElement('div');
      row.className = 'sk-row' + (S.sel === slot ? ' sel' : '') + (S.hidden[slot] ? ' off' : '');
      row.dataset.slot = slot;
      row.style.gridTemplateColumns = cols;
      row.innerHTML =
        '<div class="sk-slot" title="' + slot + '">' +
        '<button class="mini" data-a="eye">' + (S.hidden[slot] ? '🚫' : '👁') + '</button>' +
        '<span class="nm">' + slot + '</span><i>' + (cur || '空') + '</i></div>' +
        N.map((sn) => {
          const on = cur === sn;
          const th = thumbOf(slot, sn);
          return '<div class="sk-cell' + (on ? ' on' : '') + '" data-skin="' + sn + '">' +
            (th ? '<img src="' + th.url + '" alt="" loading="lazy">' : sn) + '</div>';
        }).join('');
      row.onclick = (e) => {
        const eye = e.target.closest('[data-a="eye"]');
        if (eye) { S.hidden[slot] = !S.hidden[slot]; renderAll(); return; }
        const cell = e.target.closest('.sk-cell');
        if (cell && cell.dataset.skin != null) { setChoice(slot, cell.dataset.skin); }
        else { S.sel = slot; renderMatrix(); renderDetail(); }
      };
      els.akMatrix.appendChild(row);
    });
  }

  /* ---------------- 右侧详情 ---------------- */
  function renderDetail() {
    const slot = S.sel;
    els.akBadge.textContent = slot || '—';
    if (!slot) { els.akDetail.innerHTML = '<div class="empty">在左侧选一个部位</div>'; return; }
    const cur = S.choice[slot];
    // 当前 attachment 的区域名（贴图在 atlas 里的名字）
    let regionName = '—';
    if (S.skeleton && cur) {
      const idx = S.skeleton.findSlotIndex(slot);
      const sk = S.skeleton.data.findSkin(cur);
      const att = sk && sk.getAttachment(idx, slot);
      if (att && att.region) regionName = att.region.name;
    }
    const bone = (S.json && S.json.slots.find((s) => s.name === slot) || {}).bone || '—';

    let html = '<div class="sec">' + slot + '</div>';
    html += '<div class="sk-opts">';
    S.skins.forEach((sn) => {
      const th = thumbOf(slot, sn);
      html += '<div class="sk-opt' + (cur === sn ? ' on' : '') + (th ? '' : ' none') + '" data-skin="' + sn + '">' +
        '<div class="im">' + (th ? '<img src="' + th.url + '" alt="">' : '<span style="color:var(--tx3);font-weight:700">' + sn + '</span>') + '</div>' +
        '<div class="nm">' + sn + '</div>' +
        '<div class="sub">' + (th ? th.w + '×' + th.h : '无此部位') + '</div></div>';
    });
    html += '<div class="sk-opt' + (cur === '' ? ' on' : '') + '" data-skin="">' +
      '<div class="im"><span style="color:var(--tx3);font-size:22px">∅</span></div>' +
      '<div class="nm">留空</div><div class="sub">不挂附件</div></div>';
    html += '</div>';

    html += '<div class="fld-row"><label>显示</label>' +
      '<button class="btn sm tgl' + (S.hidden[slot] ? '' : ' on') + '" data-a="eye">' +
      (S.hidden[slot] ? '已隐藏' : '显示中') + '</button></div>';

    html += '<div class="sec">信息</div>';
    html += '<div class="sk-kv"><span>骨骼</span><b>' + bone + '</b></div>';
    html += '<div class="sk-kv"><span>当前皮肤</span><b>' + (cur || '留空') + '</b></div>';
    html += '<div class="sk-kv"><span>贴图区域</span><b>' + regionName + '</b></div>';
    html += '<div class="hint" style="padding:6px 0">小图是从烘焙的 atlas 整图里按区域裁出来的；' +
      '右侧这个<b>会动的角色</b>就是实时预览，换一个部位立刻看效果。</div>';

    els.akDetail.innerHTML = html;
    els.akDetail.onclick = (e) => {
      const eye = e.target.closest('[data-a="eye"]');
      if (eye) { S.hidden[slot] = !S.hidden[slot]; renderAll(); return; }
      const opt = e.target.closest('.sk-opt');
      if (!opt || opt.dataset.skin == null) return;
      setChoice(slot, opt.dataset.skin);
    };
  }

  /* ---------------- 选择 / 应用 ---------------- */
  function setChoice(slot, skin) {
    if (skin && !availSkins(slot).includes(skin)) {
      U.toast('皮肤「' + skin + '」没有「' + slot + '」这个部位');
      return;
    }
    S.choice[slot] = skin;
    if (skin) S.hidden[slot] = false;
    S.sel = slot;
    applyMix();
    renderAll();
  }
  function applySet(sn) {
    S.slots.forEach((s) => { if (availSkins(s).includes(sn)) { S.choice[s] = sn; S.hidden[s] = false; } });
    applyMix(); renderAll();
    U.toast('整套切换 → ' + sn);
  }
  function randomize() {
    S.slots.forEach((s) => {
      const av = availSkins(s);
      S.choice[s] = av.length ? av[Math.floor(Math.random() * av.length)] : '';
      S.hidden[s] = false;
    });
    applyMix(); renderAll(); U.toast('已随机混搭');
  }
  function resetAll() {
    S.slots.forEach((s) => { S.choice[s] = S.skins[0]; S.hidden[s] = false; });
    applyMix(); renderAll(); U.toast('已重置为 ' + S.skins[0]);
  }

  /* 核心：把逐部位选择合并成一个自定义 Skin，套到会动的骨架上 */
  function buildMix() {
    const data = S.skeleton.data;
    const mix = new spine.Skin('mix_' + Date.now());
    for (const slot of S.slots) {
      const sn = S.choice[slot];
      if (!sn) continue;                       // '' = 该部位留空
      const srcSkin = data.findSkin(sn);
      if (!srcSkin) continue;
      const idx = S.skeleton.findSlotIndex(slot);
      const att = srcSkin.getAttachment(idx, slot);   // 附件名 == 槽位名
      if (att) mix.setAttachment(idx, slot, att);
    }
    return mix;
  }
  function applyMix() {
    if (!S.skeleton) return;
    const mix = buildMix();
    S.skeleton.setSkin(mix);
    S.skeleton.setSlotsToSetupPose();
    // 隐藏：把隐藏的槽位直接摘掉附件
    S.slots.forEach((slot) => {
      if (S.hidden[slot]) { const sl = S.skeleton.findSlot(slot); if (sl) sl.attachment = null; }
    });
    updateStat();
  }

  function renderAll() {
    renderView();
    renderDetail();
    updateStat();
  }

  /* ---------------- Spine 播放器 ---------------- */
  function buildPlayer(m) {
    const host = els.akPlayerHost;
    disposePlayer();
    host.innerHTML = '';
    if (!window.spine || !window.spine.SpinePlayer) {
      host.innerHTML = '<div class="empty" style="color:#9aa4bb;padding:30px">未找到 spine-player 运行时</div>';
      return;
    }
    const cfg = {
      jsonUrl: m.jsonUrl,
      atlasUrl: m.atlasUrl,
      animation: S.anim || undefined,
      showControls: false,
      backgroundColor: '#1b2030',
      alpha: true,
      premultipliedAlpha: false,
      viewport: { debugRender: false, transitionTime: 0.15 },
      success: (p) => {
        S.player = p;
        S.skeleton = p.skeleton;
        S.playing = true; S.loop = true;
        document.getElementById('akPlay').textContent = '⏸ 暂停';
        document.getElementById('akPlay').classList.add('pri');
        document.getElementById('akLoop').classList.add('on');
        if (p.animationState) p.animationState.timeScale = S.speed;
        p.config.loop = true;
        applyBg();
        applyMix();
        S.baseViewport = null;   // 以本动作的自适应视口为缩放基准
        applyZoom();
        buildThumbs();           // 从烘焙 atlas 裁出每个部件的小图
        renderAll();
        els.akStat.textContent = '已加载 ' + m.label;
        setTimeout(() => { try { window.dispatchEvent(new Event('resize')); } catch (e) { } }, 60);
      },
      error: (p, msg) => {
        els.akStat.textContent = '加载失败';
        host.innerHTML = '<div class="empty" style="color:#ff9a9a;padding:30px">Spine 运行时错误：' + msg + '</div>';
      },
    };
    try {
      S.player = new spine.SpinePlayer(host, cfg);
      // 官方播放器加载时会画一个大大的 Spine logo（LoadingScreen）——
      // 它只是运行时的展示图，跟素材无关，直接不画。
      if (S.player && S.player.loadingScreen) S.player.loadingScreen.draw = function () { };
    }
    catch (e) { host.innerHTML = '<div class="empty" style="color:#ff9a9a;padding:30px">初始化失败：' + e.message + '</div>'; }
  }
  function disposePlayer() {
    if (S.player && S.player.dispose) { try { S.player.dispose(); } catch (e) { } }
    S.player = null; S.skeleton = null;
  }

  function setAnim(name) {
    S.anim = name;
    if (S.player) {
      try {
        S.player.setAnimation(name);
        if (S.playing) S.player.play(); else S.player.pause();
        S.baseViewport = null;   // 新动作 → 新基准视口，保持当前缩放倍率
        applyZoom();
      } catch (e) { U.toast('切动作失败：' + e.message); }
    }
  }
  function setZoom(k) {
    S.zoom = Math.min(3, Math.max(0.4, k));
    els.akZoom.value = S.zoom;
    applyZoom();
  }
  /* 缩放 = 把运行时的 currentViewport 围绕中心收缩为 1/k。
     drawFrame 每帧按 currentViewport 算相机（zoom = viewport宽/适配宽 ≈ 1），
     所以直接改这个对象即可，动画照播、混搭不受影响。 */
  function applyZoom() {
    const p = S.player;
    if (!p || !p.currentViewport) return;
    if (!S.baseViewport) S.baseViewport = Object.assign({}, p.currentViewport);
    const b = S.baseViewport, k = S.zoom;
    const w = b.width / k, h = b.height / k;
    p.currentViewport.x = b.x + (b.width - w) / 2;
    p.currentViewport.y = b.y + (b.height - h) / 2;
    p.currentViewport.width = w;
    p.currentViewport.height = h;
    els.akZoomV.textContent = k.toFixed(2) + '×';
  }
  function togglePlay() {
    S.playing = !S.playing;
    const b = document.getElementById('akPlay');
    b.textContent = S.playing ? '⏸ 暂停' : '▶ 播放';
    b.classList.toggle('pri', S.playing);
    if (S.player) { if (S.playing) S.player.play(); else S.player.pause(); }
  }
  function toggleLoop() {
    S.loop = !S.loop;
    document.getElementById('akLoop').classList.toggle('on', S.loop);
    if (S.player) S.player.config.loop = S.loop;
  }
  function applyBg() {
    const v = els.akBg.value;
    const host = els.akPlayerHost;
    if (v === 'checker') {
      host.style.background = 'repeating-conic-gradient(#e9ecf3 0 25%,#fff 0 50%) 0 0/22px 22px';
    } else {
      host.style.background = v;
    }
    if (S.player && S.player.config) S.player.config.backgroundColor = v === 'checker' ? '#00000000' : v;
  }
  function shot() {
    if (!S.player || !S.player.canvas) return U.toast('还没有播放器');
    try {
      if (S.player.drawFrame) S.player.drawFrame(false);
      const url = S.player.canvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = url; a.download = U.sanitize(S.model ? S.model.label + '_' + (S.anim || 'frame') : 'frame') + '.png';
      a.click();
      U.toast('已截图');
    } catch (e) { U.toast('截图失败：' + e.message); }
  }

  /* ---------------- 状态 ---------------- */
  function updateStat() {
    if (!S.model) { els.akStat.textContent = '就绪'; return; }
    const base = S.skins[0];
    const shown = S.slots.filter((s) => S.choice[s] && !S.hidden[s]).length;
    const diff = S.slots.filter((s) => S.choice[s] !== base && S.choice[s]).length;
    const empty = S.slots.filter((s) => !S.choice[s]).length;
    const hidden = S.slots.filter((s) => S.hidden[s]).length;
    let uniq = Array.from(new Set(S.slots.map((s) => S.choice[s]).filter(Boolean)));
    els.akStat.textContent = S.model.label + ' · ' + S.skins.length + ' 套 / ' + S.slots.length + ' 部位 · 显示 ' + shown +
      (diff ? ' · 混搭 ' + diff + ' 处（相对 ' + base + '）' : ' · 纯 ' + base) +
      (empty ? ' · 留空 ' + empty : '') + (hidden ? ' · 隐藏 ' + hidden : '') +
      ' · 皮肤构成 [' + uniq.join(',') + ']';
  }

  /* ---------------- 保存 / 换装库 ---------------- */
  function openSave() {
    if (!S.model) return;
    const base = S.skins[0];
    const diff = S.slots.filter((s) => S.choice[s] !== base && S.choice[s]).length;
    els.akSaveName.value = diff ? (base + '+混搭' + diff) : (base + '整套');
    els.akSaveHint.innerHTML = '保存的是<b>部位→皮肤</b>这张表；以后在「📂 换装库」随时读回，重新套到这个会动的角色上。';
    document.getElementById('akSaveMask').classList.remove('hide');
  }
  async function doSave() {
    document.getElementById('akSaveMask').classList.add('hide');
    const name = els.akSaveName.value.trim() || '未命名换装';
    const o = {
      id: U.sanitize(S.id + '_' + name + '_' + Date.now()),
      name, modelId: S.id, modelName: S.model.label,
      skinNames: S.skins, choice: Object.assign({}, S.choice), hidden: Object.assign({}, S.hidden),
      createdAt: Date.now(),
    };
    try { await API.saveSkinMix(o); U.toast('换装「' + name + '」已保存'); }
    catch (e) { U.toast('保存失败：' + e.message); }
  }
  async function openList() {
    let d;
    try { d = await API.skinMixes(); } catch (e) { return U.toast('读取失败：' + e.message); }
    const list = (d.mixes || []).filter((m) => !S.model || m.modelId === S.id);
    els.akPresetList.innerHTML = '';
    if (!list.length) { els.akPresetList.innerHTML = '<div class="empty">' + (S.model ? '这个角色还没存过换装' : '还没有换装') + '</div>'; }
    list.forEach((m) => {
      const it = document.createElement('div'); it.className = 'outfit-it';
      const diff = Object.keys(m.choice || {}).filter((k) => m.choice[k] !== (m.skinNames || [])[0]).length;
      it.innerHTML = '<div class="m"><b>' + (m.name || m.id) + '</b><span>' + (m.modelName || m.modelId) +
        ' · 覆盖 ' + Object.keys(m.choice || {}).length + ' 个部位' + (diff ? ' · 混搭 ' + diff + ' 处' : '') + '</span></div>';
      const b1 = document.createElement('button'); b1.className = 'btn sm pri'; b1.textContent = '载入';
      b1.onclick = () => applyMixPreset(m);
      const b2 = document.createElement('button'); b2.className = 'btn sm warn'; b2.textContent = '删除';
      b2.onclick = async () => { await API.delSkinMix(m.id); openList(); };
      const g = document.createElement('div'); g.style.cssText = 'display:flex;gap:6px';
      g.appendChild(b1); g.appendChild(b2); it.appendChild(g);
      els.akPresetList.appendChild(it);
    });
    document.getElementById('akListMask').classList.remove('hide');
  }
  function applyMixPreset(m) {
    S.slots.forEach((s) => {
      const sn = (m.choice || {})[s];
      if (sn == null) return;
      S.choice[s] = (sn && availSkins(s).includes(sn)) ? sn : (sn === '' ? '' : S.choice[s]);
      S.hidden[s] = !!(m.hidden || {})[s];
    });
    document.getElementById('akListMask').classList.add('hide');
    applyMix(); renderAll(); U.toast('已载入「' + (m.name || m.id) + '」');
  }

  /* ---------------- 给 app.js ---------------- */
  function resize() {
    setTimeout(() => {
      try {
        window.dispatchEvent(new Event('resize'));
        if (S.player && S.playing) S.player.play();
      } catch (e) { }
    }, 80);
  }

  return { init, resize, S };
})();
