/* ============================================================
 * app.js — 启动 + 页签 + 角色切换
 * ============================================================ */
window.App = (function () {
  const S = { chars: [], cur: null };
  const els = {};

  async function boot() {
    ['tabs', 'charSel'].forEach((k) => els[k] = document.getElementById(k));
    els.charSel.onchange = () => selectChar(els.charSel.value);
    document.getElementById('btnReload').onclick = reloadChars;

    U.els('.tabbtn', els.tabs).forEach((b) => {
      b.onclick = () => switchTab(b.dataset.tab);
    });

    Compose.init();
    Anim.init();
    Parts.init();
    Cutter.init();
    Skin.init();
    ActSkin.init();

    // 说明页：停止 AI 服务
    const btnAiStop = document.getElementById('btnAiStop');
    if (btnAiStop) btnAiStop.onclick = async () => {
      const r = await fetch('/api/ai/stop', { method: 'POST' }).then((x) => x.json()).catch(() => null);
      U.toast(r && r.status === 'stopped' ? 'AI 服务已停止' : 'AI 服务没有在运行');
    };

    await reloadChars();
  }

  function switchTab(name) {
    U.els('.tabbtn', els.tabs).forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    ['compose', 'anim', 'cutter', 'parts', 'skin', 'actskin', 'about'].forEach((t) => {
      const el = document.getElementById('tab-' + t);
      if (el) el.classList.toggle('hide', t !== name);
    });
    if (name === 'parts') Parts.refresh();
    if (name === 'compose') setTimeout(() => Compose.refresh(), 30);
    if (name === 'anim') Anim.resize();
    if (name === 'cutter') setTimeout(() => Cutter.resize(), 30);
    if (name === 'skin') setTimeout(() => Skin.resize(), 30);
    if (name === 'actskin') setTimeout(() => ActSkin.resize(), 30);
  }

  async function reloadChars() {
    const d = await API.characters(true);
    S.chars = d.characters;
    els.charSel.innerHTML = '';
    S.chars.forEach((c) => {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.id + (c.exportCount ? '  🎬' + c.exports[0].animations.length : '') ;
      els.charSel.appendChild(o);
    });
    if (!S.chars.length) { U.toast('spine/ 目录里没扫到角色'); return; }
    await selectChar(S.chars[0].id);
  }

  async function selectChar(id) {
    const c = S.chars.find((x) => x.id === id);
    if (!c) return;
    S.cur = c;
    els.charSel.value = id;
    document.title = 'Spine 人物装配工坊 · ' + id;
    const doc = await Compose.load(id);
    Anim.refresh(doc);
    Parts.renderSlots();
    Parts.renderPool();
  }

  /** 切换到指定角色（切割工坊导出后调用；会真正重新加载部件表） */
  function setChar(id) { return selectChar(id); }

  window.addEventListener('DOMContentLoaded', boot);
  return { switchTab, reloadChars, setChar, S };
})();
