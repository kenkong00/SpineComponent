/**
 * 切割工坊 · 引擎   （window.CutterEngine）
 * 只管数据与算法，不碰 DOM；UI 层在 cutter.js
 *
 * 坐标系约定（导出时使用）：
 *   原图：左上原点，Y 向下，尺寸 W×H
 *   导出 JSON：原点 = 原图左下角，Y 向上
 *     x = bx + bw/2            （部件中心距左边缘）
 *     y = H - (by + bh/2)      （部件中心距下边缘）
 *   与装配台的相对渲染（bbox 归一化）无关原点，故拖进 Spine 后相对位置一致。
 */
window.CutterEngine = (function () {
  'use strict';
  const M = window.CMask;

  const S = {
    ready: false,
    name: '',            // 源文件名（不含扩展名）
    w: 0, h: 0,
    data: null,          // Uint8ClampedArray RGBA
    parts: [],           // [{id,name,mask,visible,color,area,bbox}]
    order: [],           // 部件 id 顺序 = 导出层级
    seq: 0,
    sourceName: '',
  };

  const PALETTE = ['#e0563c', '#e08a3c', '#d9b62a', '#4ba24b', '#2f9e8f',
    '#3a8fd9', '#5a63d8', '#8b5ad8', '#c75aa8', '#8a8f9e'];

  /* ---------------- 载入 ---------------- */
  /** @param {HTMLImageElement} img @param {string} name */
  function loadImage(img, name) {
    const w = img.naturalWidth, h = img.naturalHeight;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.clearRect(0, 0, w, h);
    g.drawImage(img, 0, 0);
    const imgData = g.getImageData(0, 0, w, h);
    S.w = w; S.h = h; S.data = imgData.data;
    S.name = name || 'char';
    S.parts = []; S.order = []; S.seq = 0;
    S.ready = true;
    return { w, h };
  }

  function reset() {
    S.ready = false; S.w = 0; S.h = 0; S.data = null;
    S.parts = []; S.order = []; S.seq = 0;
  }

  /** 只清部件，保留原图（AI 重新识别时用） */
  function clearParts() {
    S.parts = []; S.order = []; S.seq = 0;
  }

  /* ---------------- 部件 ---------------- */
  function makePart(mask, name) {
    const b = M.bounds(mask, S.w, S.h);
    const c = M.centroid(mask, S.w, S.h);
    S.seq++;
    const p = {
      id: 'p' + S.seq + '_' + Math.random().toString(36).slice(2, 6),
      name: name || ('part_' + String(S.seq).padStart(2, '0')),
      mask,
      visible: true,
      color: PALETTE[(S.seq - 1) % PALETTE.length],
      bbox: b || { x: 0, y: 0, w: 0, h: 0 },
      area: c ? c.n : 0,
    };
    S.parts.push(p);
    S.order.push(p.id);
    return p;
  }

  const byId = (id) => S.parts.find((p) => p.id === id);
  /** 按导出顺序返回部件 */
  const orderedParts = () => S.order.map(byId).filter(Boolean);

  function removePart(id) {
    const i = S.parts.findIndex((p) => p.id === id);
    if (i >= 0) S.parts.splice(i, 1);
    const j = S.order.indexOf(id);
    if (j >= 0) S.order.splice(j, 1);
  }

  function renamePart(id, name) { const p = byId(id); if (p) p.name = name; }
  function togglePart(id) { const p = byId(id); if (p) p.visible = !p.visible; return p && p.visible; }

  /** 上移 = 往上层（order 数组尾部为上层） */
  function movePart(id, dir) {
    const i = S.order.indexOf(id);
    if (i < 0) return false;
    const j = i + (dir === 'up' ? 1 : -1);
    if (j < 0 || j >= S.order.length) return false;
    const t = S.order[i]; S.order[i] = S.order[j]; S.order[j] = t;
    return true;
  }

  /** 合并：把多个部件的 mask 并成一个 */
  function mergeParts(ids) {
    const list = ids.map(byId).filter(Boolean);
    if (list.length < 2) return null;
    let m = M.create(S.w, S.h);
    for (const p of list) m = M.combine(m, p.mask, 'add');
    const first = list[0];
    const merged = makePart(m, first.name + '_merged');
    for (const p of list) removePart(p.id);
    // 合并后放到原第一个部件的位置
    const i = S.order.indexOf(merged.id);
    S.order.splice(i, 1);
    S.order.splice(Math.min(S.order.length, 0), 0, merged.id);
    return merged;
  }

  /** 拆分：把一个部件的多个连通块拆成独立部件 */
  function splitPart(id, minArea) {
    const p = byId(id);
    if (!p) return [];
    const list = M.splitComponents(p.mask, S.w, S.h, minArea || 1);
    if (list.length < 2) return [];
    removePart(id);
    const made = [];
    for (let i = 0; i < list.length; i++) {
      made.push(makePart(list[i].mask, p.name + '_' + String(i + 1).padStart(2, '0')));
    }
    return made;
  }

  /* ---------------- 自动切分策略 ---------------- */
  /**
   * @param {'alpha'|'bgcolor'|'grid'} strategy
   * @param {object} o 参数
   * @returns {{parts:number, note:string}}
   */
  function autoSplit(strategy, o) {
    if (!S.ready) return { parts: 0, note: '未载入图片' };
    const opt = o || {};
    S.parts = []; S.order = []; S.seq = 0;
    const w = S.w, h = S.h, data = S.data;

    if (strategy === 'alpha') {
      const aThr = opt.alphaThreshold != null ? opt.alphaThreshold : 8;
      const base = M.create(w, h);
      for (let i = 0; i < w * h; i++) if (data[i * 4 + 3] > aThr) base[i] = 255;
      const list = M.splitComponents(base, w, h, opt.minArea || 0);
      for (const c of list) makePart(c.mask);
      return { parts: list.length, note: '透明区域切分：' + list.length + ' 块（alpha>' + aThr + '）' };
    }

    if (strategy === 'bgcolor') {
      const tol = opt.tolerance != null ? opt.tolerance : 24;
      const fg = M.removeBackground(data, w, h, tol);
      let base = fg;
      if (opt.closeRadius > 0) base = M.close(base, w, h, opt.closeRadius);
      const list = M.splitComponents(base, w, h, opt.minArea || 0);
      for (const c of list) makePart(c.mask);
      return { parts: list.length, note: '背景去除切分：' + list.length + ' 块（容差 ' + tol + '）' };
    }

    if (strategy === 'grid') {
      const cols = Math.max(1, opt.cols || 4), rows = Math.max(1, opt.rows || 4);
      const cw = Math.floor(w / cols), ch = Math.floor(h / rows);
      const aThr = opt.alphaThreshold != null ? opt.alphaThreshold : 8;
      let n = 0;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const m = M.create(w, h);
          let any = 0;
          for (let y = r * ch; y < (r + 1) * ch; y++) {
            for (let x = c * cw; x < (c + 1) * cw; x++) {
              const i = y * w + x;
              if (data[i * 4 + 3] > aThr) { m[i] = 255; any++; }
            }
          }
          if (any >= (opt.minArea || 1)) { makePart(m, 'frame_r' + (r + 1) + '_c' + (c + 1)); n++; }
        }
      }
      return { parts: n, note: '网格切分：' + cols + '×' + rows + '，有效格 ' + n + ' 个' };
    }

    return { parts: 0, note: '未知策略' };
  }

  /* ---------------- 从选区生成/编辑部件 ---------------- */
  /** 用选区新建部件 */
  function partFromSelection(sel, name) {
    const b = M.bounds(sel, S.w, S.h);
    if (!b) return null;
    return makePart(M.clone(sel), name);
  }

  /** 把选区并入某部件（add/sub） */
  function applySelectionToPart(id, sel, mode) {
    const p = byId(id);
    if (!p) return false;
    p.mask = M.combine(p.mask, sel, mode === 'sub' ? 'sub' : 'add');
    const b = M.bounds(p.mask, S.w, S.h);
    const c = M.centroid(p.mask, S.w, S.h);
    p.bbox = b || { x: 0, y: 0, w: 0, h: 0 };
    p.area = c ? c.n : 0;
    return true;
  }

  /* ---------------- 渲染辅助 ---------------- */
  /** 把部件按 mask 抠出来画到 ctx（用于预览/缩略图） */
  function drawPart(ctx, p, dx, dy) {
    const b = p.bbox;
    if (!b || b.w <= 0 || b.h <= 0) return;
    const tmp = document.createElement('canvas');
    tmp.width = b.w; tmp.height = b.h;
    const tg = tmp.getContext('2d', { willReadFrequently: true });
    const out = new ImageData(b.w, b.h);
    const sd = S.data, od = out.data;
    for (let y = 0; y < b.h; y++) {
      for (let x = 0; x < b.w; x++) {
        const si = ((b.y + y) * S.w + (b.x + x)) * 4;
        const oi = (y * b.w + x) * 4;
        const mv = p.mask[(b.y + y) * S.w + (b.x + x)];
        od[oi] = sd[si]; od[oi + 1] = sd[si + 1]; od[oi + 2] = sd[si + 2];
        od[oi + 3] = Math.round(Math.min(255, mv) * (sd[si + 3] / 255));
      }
    }
    tg.putImageData(out, 0, 0);
    ctx.drawImage(tmp, dx || 0, dy || 0);
  }

  /** 部件缩略图 dataURL */
  function partThumb(p, size) {
    const b = p.bbox;
    const s = size || 44;
    const cv = document.createElement('canvas');
    cv.width = s; cv.height = s;
    const g = cv.getContext('2d');
    if (!b || b.w <= 0 || b.h <= 0) return cv.toDataURL();
    const tmp = document.createElement('canvas');
    tmp.width = b.w; tmp.height = b.h;
    const tg = tmp.getContext('2d', { willReadFrequently: true });
    const out = new ImageData(b.w, b.h);
    const sd = S.data, od = out.data;
    for (let y = 0; y < b.h; y++) {
      for (let x = 0; x < b.w; x++) {
        const si = ((b.y + y) * S.w + (b.x + x)) * 4;
        const oi = (y * b.w + x) * 4;
        const mv = p.mask[(b.y + y) * S.w + (b.x + x)];
        od[oi] = sd[si]; od[oi + 1] = sd[si + 1]; od[oi + 2] = sd[si + 2];
        od[oi + 3] = Math.min(255, mv * (sd[si + 3] / 255));
      }
    }
    tg.putImageData(out, 0, 0);
    const k = Math.min(s / b.w, s / b.h);
    const dw = b.w * k, dh = b.h * k;
    g.drawImage(tmp, (s - dw) / 2, (s - dh) / 2, dw, dh);
    return cv.toDataURL();
  }

  /* ---------------- 导出 ---------------- */
  /**
   * 生成 Spine（PhotoshopToSpine）格式资源
   * @param {object} o {padding:number, trim:boolean}
   * @returns {{parts:[{name,dataUrl,w,h}], skeleton:object}}
   */
  function buildExport(o) {
    const opt = o || {};
    const pad = opt.padding != null ? opt.padding : 1;
    const trim = opt.trim !== false;
    const W = S.w, H = S.h;
    const list = orderedParts().filter((p) => p.visible && p.area > 0);
    const slots = [], skin = {}, out = [];
    const used = new Set();

    for (const p of list) {
      // 文件名与 attachment 名必须完全一致，所以在这里统一清理 + 去重
      let name = String(p.name || '').replace(/[\\/:*?"<>|]/g, '_').trim();
      if (!name) name = 'part_' + (out.length + 1);
      let dup = 1;
      while (used.has(name.toLowerCase())) name = name.replace(/_\d+$/, '') + '_' + (++dup);
      used.add(name.toLowerCase());
      let bx = p.bbox.x, by = p.bbox.y, bw = p.bbox.w, bh = p.bbox.h;
      if (!trim) { bx = 0; by = 0; bw = W; bh = H; }
      // 裁剪出部件图（带 padding 白边留 0，透明即可）
      const cw = bw + pad * 2, chh = bh + pad * 2;
      const cv = document.createElement('canvas');
      cv.width = cw; cv.height = chh;
      const g = cv.getContext('2d', { willReadFrequently: true });
      const img = new ImageData(cw, chh);
      const sd = S.data, od = img.data;
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          const si = ((by + y) * W + (bx + x)) * 4;
          const oi = ((y + pad) * cw + (x + pad)) * 4;
          const mv = p.mask[(by + y) * W + (bx + x)];
          od[oi] = sd[si]; od[oi + 1] = sd[si + 1]; od[oi + 2] = sd[si + 2];
          od[oi + 3] = Math.round(Math.min(255, mv) * (sd[si + 3] / 255));
        }
      }
      g.putImageData(img, 0, 0);
      slots.push({ name, bone: 'root', attachment: name });
      skin[name] = {
        [name]: {
          x: +(bx + bw / 2).toFixed(2),
          y: +(H - (by + bh / 2)).toFixed(2),
          width: bw, height: bh,
        },
      };
      out.push({ name, dataUrl: cv.toDataURL('image/png'), w: cw, h: chh });
    }

    const skeleton = {
      skeleton: { images: './images/' },
      PhotoshopToSpine: { scale: 1, padding: pad, trim },
      bones: [{ name: 'root' }],
      slots,
      skins: { default: skin },
      animations: {},
    };
    return { parts: out, skeleton };
  }

  return {
    S, loadImage, reset, clearParts, autoSplit, byId, orderedParts, removePart, renamePart,
    togglePart, movePart, mergeParts, splitPart, partFromSelection, applySelectionToPart,
    drawPart, partThumb, buildExport, makePart,
  };
})();
