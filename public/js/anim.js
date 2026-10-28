/* ============================================================
 * anim.js — 动画台（官方 Spine 3.8 运行时）
 * 加载 spine/<角色>/export 目录里的 json + atlas + png，播放动作、调速、线框、截图，
 * 并从 json 里读出每个动作的「参数」（时长 / 时间轴条数 / 关键帧数）。
 * ============================================================ */
window.Anim = (function () {
  const S = { exp: null, player: null, json: null, stats: {}, anim: null, playing: true, loop: true, speed: 1, bg: '#1b2030', uiScale: 1, debug: false };
  const els = {};

  function init() {
    ['animList', 'actionList', 'animParam', 'playerHost', 'animStat', 'animFileInfo',
      'animSpeed', 'animSpeedV', 'animScale', 'animScaleV', 'animBg', 'chkDebug'].forEach((k) => {
        els[k] = document.getElementById(k);
      });
    document.getElementById('btnPlay').onclick = togglePlay;
    document.getElementById('btnPlayLoop').onclick = () => {
      S.loop = !S.loop;
      document.getElementById('btnPlayLoop').classList.toggle('on', S.loop);
      if (S.player) S.player.config.loop = S.loop;
      U.toast(S.loop ? '循环播放' : '播完停止');
    };
    document.getElementById('btnPlayLoop').classList.add('on');
    els.animSpeed.oninput = () => {
      S.speed = parseFloat(els.animSpeed.value);
      els.animSpeedV.textContent = S.speed.toFixed(2) + '×';
      if (S.player && S.player.animationState) S.player.animationState.timeScale = S.speed;
    };
    els.animScale.oninput = () => {
      S.uiScale = parseFloat(els.animScale.value);
      els.animScaleV.textContent = S.uiScale.toFixed(2) + '×';
      applyUiScale();
    };
    els.animBg.onchange = () => { S.bg = els.animBg.value; els.playerHost.style.background = S.bg; };
    els.chkDebug.onchange = () => { S.debug = els.chkDebug.checked; applyDebug(); };
    document.getElementById('btnShot').onclick = shot;
    document.getElementById('btnAnimReload').onclick = () => App.reloadChars();
  }

  /** 3.8 播放器每帧从 config.debug 读取线框开关（skeletonDebugRenderer） */
  function applyDebug() {
    const p = S.player;
    if (!p || !p.config) return;
    const d = p.config.debug || (p.config.debug = {});
    d.bones = S.debug;      // 骨骼
    d.meshes = S.debug;     // 网格三角
    d.hulls = S.debug;      // 网格外壳
    d.regions = false;      // 区域贴图框（太吵，关掉）
    d.bounds = false;
    d.clipping = false;
    d.paths = false;
  }

  function applyUiScale() {
    const c = els.playerHost.querySelector('canvas');
    if (c) { c.style.transform = 'scale(' + S.uiScale + ')'; c.style.transformOrigin = 'center center'; }
  }

  /* ---------------- 导出版列表 ---------------- */
  function refresh(charDoc) {
    S.exp = null; S.json = null; S.stats = {};
    disposePlayer();
    const list = els.animList;
    list.innerHTML = '';
    const exps = (charDoc && charDoc.exports) || [];
    if (!exps.length) {
      list.innerHTML = '<div class="empty">该角色没有导出文件夹<br><span style="font-size:11px">需要 <code>export/</code> 下有 .json + .atlas + .png</span></div>';
      els.actionList.innerHTML = '';
      els.animParam.innerHTML = '';
      els.animStat.textContent = '该角色无导出版';
      els.animFileInfo.textContent = '';
      return;
    }
    exps.forEach((e, i) => {
      const it = document.createElement('div');
      it.className = 'anim-item';
      it.innerHTML = '<b>' + e.label + '</b><span class="chip">' + e.animations.length + ' 动作</span>' +
        '<i>' + U.bytes(e.bytes.json) + '</i>';
      it.title = e.dirRel + '\nSpine ' + e.spineVersion + '\n骨骼 ' + e.boneCount + ' / 槽位 ' + e.slotCount;
      it.onclick = () => loadExport(e, i);
      list.appendChild(it);
    });
    loadExport(exps[0], 0);
  }

  async function loadExport(e, i) {
    S.exp = e;
    U.els('.anim-item', els.animList).forEach((x, k) => x.classList.toggle('on', k === i));
    els.animStat.textContent = '正在加载 ' + e.label + ' …';
    try {
      const r = await fetch(e.jsonUrl);
      S.json = await r.json();
      S.stats = computeStats(S.json);
    } catch (err) {
      S.json = null; S.stats = {};
      U.toast('读取动画参数失败：' + err.message);
    }
    renderActions();
    buildPlayer();
    els.animFileInfo.textContent = e.label + ' · Spine ' + e.spineVersion + ' · 骨骼 ' + e.boneCount +
      ' · 槽位 ' + e.slotCount + ' · json ' + U.bytes(e.bytes.json);
  }

  function computeStats(j) {
    const out = {};
    const anims = (j && j.animations) || {};
    for (const name in anims) {
      const a = anims[name] || {};
      let keys = 0, maxT = 0, tracks = 0, dur = 0;
      const eat = (arr) => {
        if (!Array.isArray(arr)) return;
        tracks++;
        for (const k of arr) {
          keys++;
          if (k && typeof k.time === 'number') maxT = Math.max(maxT, k.time);
        }
      };
      if (a.bones) for (const b in a.bones) for (const t in a.bones[b]) eat(a.bones[b][t]);
      if (a.slots) for (const s in a.slots) for (const t in a.slots[s]) eat(a.slots[s][t]);
      if (a.deform) for (const sk in a.deform) for (const s in a.deform[sk]) for (const at in a.deform[sk][s]) eat(a.deform[sk][s][at]);
      out[name] = { keys, tracks, duration: maxT };
    }
    return out;
  }

  /* ---------------- 动作列表 ---------------- */
  function renderActions() {
    const box = els.actionList;
    box.innerHTML = '';
    const anims = S.exp ? S.exp.animations : [];
    anims.forEach((n) => {
      const b = document.createElement('button');
      b.className = 'act' + (n === S.anim ? ' on' : '');
      b.textContent = n;
      b.onclick = () => setAnim(n);
      box.appendChild(b);
    });
    const first = S.anim && anims.includes(S.anim) ? S.anim : anims[0];
    if (first) setAnim(first);
  }

  function setAnim(name) {
    S.anim = name;
    U.els('.act', els.actionList).forEach((b) => b.classList.toggle('on', b.textContent === name));
    if (S.player) {
      try {
        S.player.setAnimation(name);
        S.player.animationState.timeScale = S.speed;
        if (S.playing) S.player.play(); else S.player.pause();
      } catch (e) { U.toast('切动作失败：' + e.message); }
    }
    renderParam();
  }

  function renderParam() {
    const st = S.stats[S.anim];
    const n = els.animParam;
    if (!st) { n.innerHTML = '<div class="hint">没有读到该动作的参数</div>'; return; }
    const fps = (S.json && S.json.skeleton && S.json.skeleton.fps) || 30;
    n.innerHTML =
      '<div class="kv"><span>动作名</span><b>' + S.anim + '</b></div>' +
      '<div class="kv"><span>时长</span><b>' + st.duration.toFixed(3) + ' s</b></div>' +
      '<div class="kv"><span>约合帧数</span><b>' + Math.round(st.duration * fps) + ' 帧 @ ' + fps + 'fps</b></div>' +
      '<div class="kv"><span>时间轴（轨道）</span><b>' + st.tracks + ' 条</b></div>' +
      '<div class="kv"><span>关键帧</span><b>' + st.keys + ' 个</b></div>' +
      '<div class="hint">这些数字直接来自导出的 <code>' + (S.exp ? S.exp.jsonUrl.split('/').pop() : '') + '</code>，就是引擎里会读到的动作参数。</div>';
    els.animStat.textContent = '动作：' + S.anim + ' · ' + st.duration.toFixed(2) + 's · ' + st.tracks + ' 轨道 / ' + st.keys + ' 关键帧';
  }

  function disposePlayer() {
    if (S.player && S.player.dispose) { try { S.player.dispose(); } catch (e) { } }
    S.player = null;
  }

  /** 页签从 display:none 切回来时，容器尺寸从 0 恢复，需要让播放器重新计算视口 */
  function resize() {
    setTimeout(() => {
      try {
        window.dispatchEvent(new Event('resize'));
        applyUiScale();
      } catch (e) { }
    }, 60);
  }

  /* ---------------- 播放器 ---------------- */
  function buildPlayer() {
    const host = els.playerHost;
    disposePlayer();
    host.innerHTML = '';
    if (!window.spine || !window.spine.SpinePlayer) {
      host.innerHTML = '<div class="empty" style="color:#9aa4bb;padding:30px">未找到 spine-player 运行时（vendor/spine-player.js）</div>';
      return;
    }
    const cfg = {
      jsonUrl: S.exp.jsonUrl,
      atlasUrl: S.exp.atlasUrl,
      animation: S.anim || undefined,
      showControls: false,
      backgroundColor: S.bg,
      alpha: true,
      premultipliedAlpha: false,
      viewport: { debugRender: false, transitionTime: 0.15 },
      success: (p) => {
        S.player = p;
        if (p.animationState) p.animationState.timeScale = S.speed;
        p.config.loop = S.loop;
        applyUiScale();
        applyDebug();
        els.animStat.textContent = '已加载 ' + S.exp.label;
        setTimeout(applyUiScale, 60);
      },
      error: (p, msg) => {
        els.animStat.textContent = '加载失败';
        host.innerHTML = '<div class="empty" style="color:#ff9a9a;padding:30px">Spine 运行时错误：' + msg + '</div>';
      },
    };
    try {
      S.player = new spine.SpinePlayer(host, cfg);
    } catch (e) {
      host.innerHTML = '<div class="empty" style="color:#ff9a9a;padding:30px">初始化失败：' + e.message + '</div>';
    }
  }
  function reload() { if (S.exp) buildPlayer(); }

  function togglePlay() {
    S.playing = !S.playing;
    const b = document.getElementById('btnPlay');
    b.textContent = S.playing ? '⏸ 暂停' : '▶ 播放';
    b.classList.toggle('pri', S.playing);
    if (S.player) { if (S.playing) S.player.play(); else S.player.pause(); }
  }

  function shot() {
    if (!S.player || !S.player.canvas) return U.toast('还没有播放器');
    try {
      if (S.player.drawFrame) S.player.drawFrame(false);
      const url = S.player.canvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = url;
      a.download = U.sanitize((S.exp ? S.exp.label + '_' + (S.anim || 'frame') : 'spine_frame')) + '.png';
      a.click();
      U.toast('已截图（若为空白请先暂停到想要的瞬间再截）');
    } catch (e) { U.toast('截图失败：' + e.message); }
  }

  return { init, refresh, resize, S };
})();
