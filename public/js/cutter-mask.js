/**
 * 切割工坊 · 位图 mask 算法库   （window.CMask）
 *
 * 约定：mask 是长度 w*h 的 Uint8Array，0 = 未选中，非 0 = 选中。
 * 所有函数都是纯数据运算，不碰 DOM，方便单独跑验证。
 */
window.CMask = (function () {
  'use strict';

  /* ---------------- 基础 ---------------- */
  const create = (w, h) => new Uint8Array(w * h);
  const clone = (m) => new Uint8Array(m);

  /** 包围盒；全空返回 null */
  function bounds(m, w, h) {
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        if (m[row + x]) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return null;
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  const count = (m) => { let n = 0; for (let i = 0; i < m.length; i++) if (m[i]) n++; return n; };

  /** 质心（像素加权） */
  function centroid(m, w, h) {
    let sx = 0, sy = 0, n = 0;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) if (m[row + x]) { sx += x; sy += y; n++; }
    }
    return n ? { x: sx / n, y: sy / n, n: n } : null;
  }

  /* ---------------- 布尔运算 ---------------- */
  /** mode: add(并) / sub(差) / intersect(交) / replace */
  function combine(a, b, mode) {
    const n = a.length, out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const va = a[i], vb = b[i];
      out[i] = mode === 'sub' ? (va && !vb ? 255 : 0)
        : mode === 'intersect' ? (va && vb ? 255 : 0)
          : (va || vb ? 255 : 0);
    }
    return out;
  }
  const invert = (m) => { const o = new Uint8Array(m.length); for (let i = 0; i < m.length; i++) o[i] = m[i] ? 0 : 255; return o; };

  /* ---------------- 几何光栅化 ---------------- */
  function fillRect(m, w, h, x0, y0, x1, y1) {
    const xa = Math.max(0, Math.min(x0, x1)), xb = Math.min(w - 1, Math.max(x0, x1));
    const ya = Math.max(0, Math.min(y0, y1)), yb = Math.min(h - 1, Math.max(y0, y1));
    for (let y = ya; y <= yb; y++) m.fill(255, y * w + xa, y * w + xb + 1);
    return m;
  }

  function fillEllipse(m, w, h, x0, y0, x1, y1) {
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const rx = Math.abs(x1 - x0) / 2, ry = Math.abs(y1 - y0) / 2;
    if (rx < 0.5 || ry < 0.5) return m;
    const ya = Math.max(0, Math.floor(cy - ry)), yb = Math.min(h - 1, Math.ceil(cy + ry));
    for (let y = ya; y <= yb; y++) {
      const dy = (y + 0.5 - cy) / ry;
      if (dy < -1 || dy > 1) continue;
      const dx = Math.sqrt(Math.max(0, 1 - dy * dy)) * rx;
      const xa = Math.max(0, Math.round(cx - dx)), xb = Math.min(w - 1, Math.round(cx + dx));
      if (xb >= xa) m.fill(255, y * w + xa, y * w + xb + 1);
    }
    return m;
  }

  /** 多边形扫描线填充（even-odd） */
  function fillPolygon(m, w, h, pts) {
    const n = pts.length;
    if (n < 3) return m;
    let y0 = Infinity, y1 = -Infinity;
    for (const p of pts) { if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
    y0 = Math.max(0, Math.floor(y0)); y1 = Math.min(h - 1, Math.ceil(y1));
    const xs = [];
    for (let y = y0; y <= y1; y++) {
      xs.length = 0;
      const sy = y + 0.5;
      for (let i = 0; i < n; i++) {
        const a = pts[i], b = pts[(i + 1) % n];
        if ((a.y <= sy && b.y > sy) || (b.y <= sy && a.y > sy)) {
          xs.push(a.x + (sy - a.y) / (b.y - a.y) * (b.x - a.x));
        }
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const xa = Math.max(0, Math.round(xs[k])), xb = Math.min(w - 1, Math.round(xs[k + 1]));
        if (xb >= xa) m.fill(255, y * w + xa, y * w + xb + 1);
      }
    }
    return m;
  }

  /** 圆形笔刷（画笔/橡皮），会把笔画到 mask 上，返回 true 表示有改动 */
  function brush(m, w, h, cx, cy, r, value) {
    const r2 = r * r; let hit = false;
    const ya = Math.max(0, Math.floor(cy - r)), yb = Math.min(h - 1, Math.ceil(cy + r));
    const xa = Math.max(0, Math.floor(cx - r)), xb = Math.min(w - 1, Math.ceil(cx + r));
    for (let y = ya; y <= yb; y++) {
      const dy = y + 0.5 - cy;
      for (let x = xa; x <= xb; x++) {
        const dx = x + 0.5 - cx;
        if (dx * dx + dy * dy <= r2) { m[y * w + x] = value; hit = true; }
      }
    }
    return hit;
  }

  /** 两点之间插值落笔（避免快速拖动断点）；返回是否改动 */
  function brushLine(m, w, h, x0, y0, x1, y1, r, value) {
    const d = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(d / Math.max(0.5, r * 0.35)));
    let hit = false;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      if (brush(m, w, h, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, r, value)) hit = true;
    }
    return hit;
  }

  /* ---------------- 魔棒：容差泛洪 ---------------- */
  /**
   * @param {Uint8ClampedArray} data RGBA 像素
   * @param {number} sx,sy 种子点
   * @param {number} tol 容差 0-255（RGBA 四维欧氏距离，含 alpha）
   * @param {boolean} contiguous 是否只取连通区域
   */
  function magicWand(data, w, h, sx, sy, tol, contiguous) {
    sx = Math.max(0, Math.min(w - 1, Math.round(sx)));
    sy = Math.max(0, Math.min(h - 1, Math.round(sy)));
    const si = (sy * w + sx) * 4;
    const sr = data[si], sg = data[si + 1], sb = data[si + 2], sa = data[si + 3];
    const t2 = tol * tol * 4;

    const match = (i) => {
      const o = i * 4;
      if (data[o + 3] === 0) return sa === 0;         // 透明区单独判定
      const dr = data[o] - sr, dg = data[o + 1] - sg, db = data[o + 2] - sb, da = data[o + 3] - sa;
      return dr * dr + dg * dg + db * db + da * da <= t2;
    };

    const out = create(w, h);
    if (!contiguous) {
      for (let i = 0; i < w * h; i++) if (match(i)) out[i] = 255;
      return out;
    }
    // 显式栈 DFS，避免递归爆栈；visited 用 Uint8Array 省内存
    const stack = new Int32Array(w * h);
    let sp = 0;
    const visited = new Uint8Array(w * h);
    stack[sp++] = sy * w + sx;
    while (sp > 0) {
      const i = stack[--sp];
      if (visited[i]) continue;
      visited[i] = 1;
      if (!match(i)) continue;
      out[i] = 255;
      const x = i % w, y = (i / w) | 0;
      if (x > 0) stack[sp++] = i - 1;
      if (x < w - 1) stack[sp++] = i + 1;
      if (y > 0) stack[sp++] = i - w;
      if (y < h - 1) stack[sp++] = i + w;
    }
    return out;
  }

  /** 背景去除：从四边取样背景色，容差泛洪后取反（保留主体） */
  function removeBackground(data, w, h, tol) {
    const bg = create(w, h);
    const seeds = [];
    const step = Math.max(1, Math.floor(Math.min(w, h) / 12));
    for (let x = 0; x < w; x += step) { seeds.push([x, 0], [x, h - 1]); }
    for (let y = 0; y < h; y += step) { seeds.push([0, y], [w - 1, y]); }
    for (const [sx, sy] of seeds) {
      const m = magicWand(data, w, h, sx, sy, tol, true);
      for (let i = 0; i < m.length; i++) if (m[i]) bg[i] = 255;
    }
    const out = create(w, h);
    for (let i = 0; i < w * h; i++) out[i] = (data[i * 4 + 3] > 8 && !bg[i]) ? 255 : 0;
    return out;
  }

  /* ---------------- 连通域 ---------------- */
  /**
   * 标记连通域（4 邻域 BFS）
   * @returns {{labels:Int32Array, comps:Array}} comps 按面积降序
   */
  function components(src, w, h) {
    const n = w * h;
    const labels = new Int32Array(n).fill(-1);
    const queue = new Int32Array(n);
    const comps = [];
    let head = 0, tail = 0;
    for (let i = 0; i < n; i++) {
      if (!src[i] || labels[i] !== -1) continue;
      const id = comps.length;
      head = 0; tail = 0;
      queue[tail++] = i; labels[i] = id;
      let area = 0, sx = 0, sy = 0;
      let x0 = w, y0 = h, x1 = -1, y1 = -1;
      while (head < tail) {
        const p = queue[head++];
        const px = p % w, py = (p / w) | 0;
        area++; sx += px; sy += py;
        if (px < x0) x0 = px; if (px > x1) x1 = px;
        if (py < y0) y0 = py; if (py > y1) y1 = py;
        if (px > 0 && src[p - 1] && labels[p - 1] === -1) { labels[p - 1] = id; queue[tail++] = p - 1; }
        if (px < w - 1 && src[p + 1] && labels[p + 1] === -1) { labels[p + 1] = id; queue[tail++] = p + 1; }
        if (py > 0 && src[p - w] && labels[p - w] === -1) { labels[p - w] = id; queue[tail++] = p - w; }
        if (py < h - 1 && src[p + w] && labels[p + w] === -1) { labels[p + w] = id; queue[tail++] = p + w; }
      }
      comps.push({ id, area, cx: sx / area, cy: sy / area, bbox: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } });
    }
    comps.sort((a, b) => b.area - a.area);
    return { labels, comps };
  }

  /** 只保留面积 >= minArea 的连通域，返回新 mask */
  function dropSmall(src, w, h, minArea) {
    const { labels, comps } = components(src, w, h);
    const ok = new Uint8Array(comps.length);
    for (const c of comps) if (c.area >= minArea) ok[c.id] = 1;
    const out = create(w, h);
    for (let i = 0; i < labels.length; i++) if (labels[i] >= 0 && ok[labels[i]]) out[i] = 255;
    return out;
  }

  /** 把连通域拆成多个 mask（用于「拆分」按钮） */
  function splitComponents(src, w, h, minArea) {
    const { labels, comps } = components(src, w, h);
    return comps.filter((c) => c.area >= minArea).map((c) => {
      const m = create(w, h);
      for (let i = 0; i < labels.length; i++) if (labels[i] === c.id) m[i] = 255;
      return { mask: m, ...c };
    });
  }

  /* ---------------- 形态学 ---------------- */
  function dilate(src, w, h, r) {
    if (r <= 0) return clone(src);
    const out = create(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let hit = 0;
        const ya = Math.max(0, y - r), yb = Math.min(h - 1, y + r);
        const xa = Math.max(0, x - r), xb = Math.min(w - 1, x + r);
        for (let j = ya; j <= yb && !hit; j++) for (let i = xa; i <= xb; i++) if (src[j * w + i]) { hit = 1; break; }
        if (hit) out[y * w + x] = 255;
      }
    }
    return out;
  }
  const erode = (src, w, h, r) => invert(dilate(invert(src), w, h, r));
  /** 闭运算：填小缝（先膨胀后腐蚀） */
  const close = (src, w, h, r) => erode(dilate(src, w, h, r), w, h, r);
  /** 开运算：去小刺 */
  const open = (src, w, h, r) => dilate(erode(src, w, h, r), w, h, r);
  /** 边界：取 mask 外沿 n 像素 */
  const border = (src, w, h, n) => combine(src, erode(src, w, h, n), 'sub');
  /** 平滑：闭+开 */
  const smooth = (src, w, h, r) => open(close(src, w, h, r), w, h, r);

  /* ---------------- 羽化（可分离盒状模糊，横竖两趟） ---------------- */
  function feather(src, w, h, r) {
    if (r <= 0) return clone(src);
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    const win = r * 2 + 1;
    for (let y = 0; y < h; y++) {
      const row = y * w; let sum = 0;
      for (let i = -r; i <= r; i++) { const x = Math.min(w - 1, Math.max(0, i)); sum += src[row + x]; }
      for (let x = 0; x < w; x++) {
        tmp[row + x] = sum / win;
        const add = row + Math.min(w - 1, x + r + 1), sub = row + Math.max(0, x - r);
        sum += src[add] - src[sub];
      }
    }
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let i = -r; i <= r; i++) { const y = Math.min(h - 1, Math.max(0, i)); sum += tmp[y * w + x]; }
      for (let y = 0; y < h; y++) {
        out[y * w + x] = sum / win;
        const add = Math.min(h - 1, y + r + 1) * w + x, sub = Math.max(0, y - r) * w + x;
        sum += tmp[add] - tmp[sub];
      }
    }
    // 归一化，保证完全选中区域仍是 255
    let max = 0;
    for (let i = 0; i < out.length; i++) if (out[i] > max) max = out[i];
    const k = max > 0 ? 255 / max : 0;
    const res = new Uint8Array(w * h);
    for (let i = 0; i < out.length; i++) res[i] = Math.round(out[i] * k);
    return res;
  }

  /* ---------------- 输出辅助 ---------------- */
  /** mask → RGBA(黑, alpha=mask) 的 ImageData，用于 destination-in 抠图 */
  function toAlphaImageData(mask, w, h) {
    const img = new ImageData(w, h);
    const d = img.data;
    for (let i = 0, o = 0; i < mask.length; i++, o += 4) {
      d[o] = d[o + 1] = d[o + 2] = 0;
      d[o + 3] = mask[i];
    }
    return img;
  }

  /** mask → 游程合并的 Path2D（用于 ctx.clip，避免逐像素建路径） */
  function toClipPath(mask, w, h) {
    const p = new Path2D(); let any = false;
    for (let y = 0; y < h; y++) {
      const row = y * w; let x = 0;
      while (x < w) {
        if (mask[row + x]) {
          let x2 = x;
          while (x2 < w && mask[row + x2]) x2++;
          p.rect(x, y, x2 - x, 1); any = true; x = x2;
        } else x++;
      }
    }
    return any ? p : null;
  }

  /** 取 mask 边缘像素（蚂蚁线用）：四邻域有 0 即为边 */
  function edge(mask, w, h) {
    const out = create(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!mask[i]) continue;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
          !mask[i - 1] || !mask[i + 1] || !mask[i - w] || !mask[i + w]) out[i] = 255;
      }
    }
    return out;
  }

  return {
    create, clone, bounds, count, centroid, combine, invert,
    fillRect, fillEllipse, fillPolygon, brush, brushLine,
    magicWand, removeBackground,
    components, dropSmall, splitComponents,
    dilate, erode, close, open, border, smooth, feather,
    toAlphaImageData, toClipPath, edge,
  };
})();
