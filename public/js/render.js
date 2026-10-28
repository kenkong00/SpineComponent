/* ============================================================
 * render.js — 核心渲染层
 * 把「源 JSON 的部件坐标」翻译成屏幕上的盒子 + 变换，
 * 同时支持 DOM 渲染（实时预览）与 Canvas 渲染（导出 / 命中检测）。
 *
 * 坐标约定
 *   - JSON 里 x,y 是部件中心，Y 轴向上（Spine 坐标）
 *   - 画布坐标 Y 轴向下，原点 = bbox 左上角
 *   - cx = x - bbox.x0 + dx          （画布坐标，中心）
 *     cy = bbox.y1 - y + dy          （画布坐标，中心）
 * ============================================================ */
window.R = (function () {

  /* ---------------- 图片缓存 ---------------- */
  const imgCache = new Map();
  const alphaCache = new Map();

  function getImage(url) {
    if (!url) return Promise.resolve(null);
    if (!imgCache.has(url)) {
      imgCache.set(url, new Promise((res, rej) => {
        const im = new Image();
        im.crossOrigin = 'anonymous';
        im.onload = () => res(im);
        im.onerror = () => rej(new Error('load fail: ' + url));
        im.src = url;
      }));
    }
    return imgCache.get(url);
  }

  /** 异步拿 alpha 数据（命中检测用），拿不到时返回 null 表示退化成矩形命中 */
  function getAlpha(url) {
    if (!url) return null;
    if (!alphaCache.has(url)) {
      alphaCache.set(url, null);
      getImage(url).then((el) => {
        if (!el.naturalWidth) return;
        try {
          const c = document.createElement('canvas');
          c.width = el.naturalWidth; c.height = el.naturalHeight;
          const x = c.getContext('2d', { willReadFrequently: true });
          x.drawImage(el, 0, 0);
          alphaCache.set(url, x.getImageData(0, 0, c.width, c.height));
        } catch (e) { alphaCache.set(url, false); }
      }).catch(() => alphaCache.set(url, false));
    }
    return alphaCache.get(url) || null;
  }

  /* ---------------- 布局计算 ---------------- */
  function layout(p, bbox) {
    const bw = p.w * (p.sx == null ? 1 : p.sx);
    const bh = p.h * (p.sy == null ? 1 : p.sy);
    const cx = p.x - bbox.x0 + (p.dx || 0);
    const cy = bbox.y1 - p.y + (p.dy || 0);
    return { left: cx - bw / 2, top: cy - bh / 2, w: bw, h: bh, cx, cy, rot: p.rot || 0 };
  }

  /**
   * 归一化盒子坐标 (u,v ∈ [0,1]) -> 源图像素坐标。
   * 处理 fit 模式（fill/contain/cover）与翻转。落在图外返回 null。
   */
  function uvToPixel(p, u, v, natW, natH, boxW, boxH) {
    if (p.flipX) u = 1 - u;
    if (p.flipY) v = 1 - v;
    const fit = p.fit || 'fill';
    const a = natW / natH, ba = boxW / boxH;
    if (fit === 'fill') {
      return { x: Math.round(u * natW), y: Math.round(v * natH) };
    }
    if (fit === 'contain') {
      let dw = boxW, dh = boxH;
      if (a > ba) dh = boxW / a; else dw = boxH * a;
      const ox = (boxW - dw) / 2, oy = (boxH - dh) / 2;
      const px = u * boxW - ox, py = v * boxH - oy;
      if (px < 0 || py < 0 || px > dw || py > dh) return null;
      return { x: Math.round((px / dw) * natW), y: Math.round((py / dh) * natH) };
    }
    // cover：图等比铺满盒子，超出被裁
    let cw, ch;
    if (a > ba) { ch = boxH; cw = boxH * a; } else { cw = boxW; ch = boxW / a; }
    const ox = (boxW - cw) / 2, oy = (boxH - ch) / 2;
    const px = u * boxW - ox, py = v * boxH - oy;
    if (px < 0 || py < 0 || px > cw || py > ch) return null;
    return { x: Math.round((px / cw) * natW), y: Math.round((py / ch) * natH) };
  }

  /* ---------------- 像素级命中检测 ---------------- */
  function hitTest(parts, bbox, px, py) {
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      if (!p.visible || p.locked || !p.imgUrl) continue;
      const L = layout(p, bbox);
      let dx = px - L.cx, dy = py - L.cy;
      if (L.rot) {
        const a = -L.rot * Math.PI / 180;
        const rx = dx * Math.cos(a) - dy * Math.sin(a);
        const ry = dx * Math.sin(a) + dy * Math.cos(a);
        dx = rx; dy = ry;
      }
      if (Math.abs(dx) > L.w / 2 || Math.abs(dy) > L.h / 2) continue;
      const natW = p.natW || p.naturalW || p.w, natH = p.natH || p.naturalH || p.h;
      const pt = uvToPixel(p, dx / L.w + 0.5, dy / L.h + 0.5, natW, natH, L.w, L.h);
      if (!pt) continue;
      const data = getAlpha(p.imgUrl);
      if (data && data.data) {
        const sx = Math.min(natW - 1, Math.max(0, pt.x));
        const sy = Math.min(natH - 1, Math.max(0, pt.y));
        if (data.data[(sy * data.width + sx) * 4 + 3] > 10) return i;
      } else {
        return i;
      }
    }
    return -1;
  }

  /* ---------------- DOM 渲染 ---------------- */
  function cssFilter(p) {
    const f = [];
    if (p.bri != null && p.bri !== 1) f.push('brightness(' + p.bri + ')');
    if (p.sat != null && p.sat !== 1) f.push('saturate(' + p.sat + ')');
    if (p.hue) f.push('hue-rotate(' + p.hue + 'deg)');
    return f.length ? f.join(' ') : '';
  }

  function makeEl(p, bbox, idx) {
    const L = layout(p, bbox);
    const el = document.createElement('div');
    el.className = 'part' + (p.locked ? ' locked' : '');
    el.dataset.i = idx;
    el.dataset.pid = p.id;
    el.style.left = L.left + 'px';
    el.style.top = L.top + 'px';
    el.style.width = L.w + 'px';
    el.style.height = L.h + 'px';
    el.style.opacity = p.opacity == null ? 1 : p.opacity;
    el.style.zIndex = String(idx + 1);
    el.style.isolation = 'isolate';
    if (L.rot) el.style.transform = 'rotate(' + L.rot + 'deg)';
    if (!p.visible) el.style.display = 'none';

    const flip = document.createElement('div');
    flip.style.cssText = 'position:absolute;inset:0;';
    if (p.flipX || p.flipY) {
      flip.style.transform = 'scale(' + (p.flipX ? -1 : 1) + ',' + (p.flipY ? -1 : 1) + ')';
    }

    const img = document.createElement('img');
    img.src = p.imgUrl;
    img.draggable = false;
    img.style.width = '100%';
    img.style.height = '100%';
    img.style.objectFit = (!p.fit || p.fit === 'fill') ? 'fill' : p.fit;
    const flt = cssFilter(p);
    if (flt) img.style.filter = flt;
    if (p.imgUrl && p.imgUrl.startsWith('data:')) {
      img.addEventListener('load', () => { p.natW = img.naturalWidth; p.natH = img.naturalHeight; });
    }
    flip.appendChild(img);

    if (p.tint && p.tint !== '#ffffff') {
      const t = document.createElement('i');
      t.style.cssText =
        'position:absolute;inset:0;pointer-events:none;mix-blend-mode:multiply;background:' + p.tint + ';' +
        '-webkit-mask-image:url("' + p.imgUrl + '");-webkit-mask-size:100% 100%;-webkit-mask-repeat:no-repeat;' +
        'mask-image:url("' + p.imgUrl + '");mask-size:100% 100%;mask-repeat:no-repeat;';
      flip.appendChild(t);
    }
    el.appendChild(flip);
    return el;
  }

  /* ---------------- Canvas 渲染（导出） ---------------- */
  async function preload(parts) {
    await Promise.all(parts.map((p) => (p.imgUrl ? getImage(p.imgUrl).catch(() => null) : null)));
  }

  const tintCache = new Map();
  async function tintedImage(url, tint) {
    const key = url + '|' + tint;
    if (tintCache.has(key)) return tintCache.get(key);
    const im = await getImage(url);
    const c = document.createElement('canvas');
    c.width = im.naturalWidth; c.height = im.naturalHeight;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(im, 0, 0);
    const id = x.getImageData(0, 0, c.width, c.height);
    const r = parseInt(tint.slice(1, 3), 16) / 255,
      g = parseInt(tint.slice(3, 5), 16) / 255,
      b = parseInt(tint.slice(5, 7), 16) / 255;
    const d = id.data;
    for (let i = 0; i < d.length; i += 4) {
      if (!d[i + 3]) continue;
      d[i] *= r; d[i + 1] *= g; d[i + 2] *= b;
    }
    x.putImageData(id, 0, 0);
    tintCache.set(key, c);
    return c;
  }

  /** 把部件按当前变换画到 ctx；bbox 用于坐标换算，scale 用于倍率 */
  async function drawTo(ctx, parts, bbox, scale) {
    scale = scale || 1;
    for (const p of parts) {
      if (p.visible === false || !p.imgUrl) continue;
      let im;
      try { im = await getImage(p.imgUrl); } catch (e) { continue; }
      const natW = im.naturalWidth, natH = im.naturalHeight;
      p.natW = natW; p.natH = natH;
      const L = layout(p, bbox);
      const src = (p.tint && p.tint !== '#ffffff') ? await tintedImage(p.imgUrl, p.tint) : im;

      const dw = L.w, dh = L.h;
      const fit = p.fit || 'fill';
      let sx = 0, sy = 0, sw = natW, sh = natH, dx = -dw / 2, dy = -dh / 2, ddx = dw, ddy = dh;
      if (fit === 'contain') {
        const a = natW / natH, ba = dw / dh;
        if (a > ba) { ddy = dw / a; dy = -ddy / 2; } else { ddx = dh * a; dx = -ddx / 2; }
      } else if (fit === 'cover') {
        const a = natW / natH, ba = dw / dh;
        if (a > ba) { sw = natH * ba; sx = (natW - sw) / 2; } else { sh = natW / ba; sy = (natH - sh) / 2; }
      }

      ctx.save();
      ctx.globalAlpha = p.opacity == null ? 1 : p.opacity;
      const flt = cssFilter(p);
      if (flt) ctx.filter = flt;
      ctx.translate(L.cx * scale, L.cy * scale);
      if (L.rot) ctx.rotate(L.rot * Math.PI / 180);
      ctx.scale((p.flipX ? -1 : 1) * scale, (p.flipY ? -1 : 1) * scale);
      ctx.drawImage(src, sx, sy, sw, sh, dx, dy, ddx, ddy);
      ctx.restore();
    }
  }

  return { layout, cssFilter, makeEl, hitTest, drawTo, preload, getImage, uvToPixel, tintedImage };
})();
