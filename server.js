/**
 * Spine 人物装配工坊 — 本地服务
 * 零依赖 Node（http + fs），负责：
 *   1. 静态托管 public / vendor / spine / data/uploads
 *   2. 扫描 spine/ 目录，解析 PhotoshopToSpine 导出的源 JSON，输出「可换装部件表」
 *   3. 上传替换部件、保存/读取套装
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { spawn } = require('child_process');

const ROOT = __dirname;
const SPINE_DIR = path.join(ROOT, 'spine');
const PUBLIC_DIR = path.join(ROOT, 'public');
const VENDOR_DIR = path.join(ROOT, 'vendor');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const OUTFIT_DIR = path.join(DATA_DIR, 'outfits');
const MODEL_DIR = path.join(DATA_DIR, 'models');
const SKINMIX_DIR = path.join(DATA_DIR, 'skins');
const PORT = Number(process.env.PORT) || 5310;

/** 用于「端口上跑的到底是不是本工坊」的识别签名，launcher.js 靠它判断能否复用 */
const APP_ID = 'spine-assembly-workshop';

[UPLOAD_DIR, OUTFIT_DIR, MODEL_DIR, SKINMIX_DIR].forEach((d) => fs.mkdirSync(d, { recursive: true }));

const START_TS = Date.now();

const IMG_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.atlas': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.spine': 'application/octet-stream',
};

/* ---------------------------------- 工具 ---------------------------------- */

function send(res, code, body, headers) {
  const h = Object.assign({ 'Cache-Control': 'no-store' }, headers || {});
  res.writeHead(code, h);
  res.end(body);
}

function sendJson(res, code, obj) {
  send(res, code, JSON.stringify(obj, null, 2), { 'Content-Type': 'application/json; charset=utf-8' });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    return null;
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return [];
  }
}

function enc(p) {
  // 把本地相对路径转为可用的 URL（逐段编码）
  return p.split(/[\\/]/).map(encodeURIComponent).join('/');
}

function readBody(req, limit = 40 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* ------------------------------ AI 智能切分网关 ------------------------------
 * 真正的推理在 ai/ai_server.py（常驻 Python，端口 5311，加载 SAM3 + YOLOv8-pose）。
 * 这里只负责：健康探测、惰性拉起、请求转发。 */

const AI_CONFIG_PATH = path.join(ROOT, 'ai', 'config.json');
let _aiCfg = null;
function aiCfg() {
  if (!_aiCfg) {
    try { _aiCfg = JSON.parse(fs.readFileSync(AI_CONFIG_PATH, 'utf8')); }
    catch (e) { _aiCfg = {}; }
  }
  return _aiCfg;
}
const aiPort = () => Number(aiCfg().port) || 5311;

function aiRequest(pathname, method, body, timeoutMs) {
  return new Promise((resolve) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const rq = http.request({
      host: '127.0.0.1', port: aiPort(), path: pathname, method: method || 'GET',
      headers: payload
        ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
        : {},
      timeout: timeoutMs || 15000,
    }, (rs) => {
      const chunks = [];
      rs.on('data', (c) => chunks.push(c));
      rs.on('end', () => {
        let data = null;
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { /* 忽略 */ }
        resolve({ status: rs.statusCode, data });
      });
    });
    rq.on('timeout', () => { rq.destroy(); resolve({ status: 0, data: null }); });
    rq.on('error', () => resolve({ status: 0, data: null }));
    if (payload) rq.write(payload);
    rq.end();
  });
}

let _aiStarting = false;
function ensureAi() {
  if (_aiStarting) return { started: true, already: false, note: '已在启动中' };
  _aiStarting = true;
  setTimeout(() => { _aiStarting = false; }, 5000);
  const cfg = aiCfg();
  const photon = cfg.photonRoot || '';
  const py = cfg.python || '.venv\\Scripts\\python.exe';
  const pyAbs = path.isAbsolute(py) ? py : path.join(photon, py);
  const script = path.join(ROOT, 'ai', 'ai_server.py');
  if (!fs.existsSync(pyAbs)) return { started: false, error: 'Python 解释器不存在：' + pyAbs + '（检查 ai/config.json）' };
  if (!fs.existsSync(script)) return { started: false, error: '缺少 ' + script };
  try {
    const child = spawn(pyAbs, [script], {
      cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
    return { started: true, pid: child.pid };
  } catch (e) {
    return { started: false, error: String(e.message || e) };
  }
}

/* ------------------------------ 素材索引（大小写不敏感） ------------------------------ */

function buildImageIndex(charDir) {
  const imagesDir = path.join(charDir, 'images');
  const map = new Map(); // lowerName(no ext) -> absolute path
  const all = [];
  for (const ent of listDir(imagesDir)) {
    if (!ent.isFile()) continue;
    const ext = path.extname(ent.name).toLowerCase();
    if (!IMG_EXT.includes(ext)) continue;
    const abs = path.join(imagesDir, ent.name);
    const base = ent.name.slice(0, ent.name.length - ext.length);
    map.set(base.toLowerCase(), abs);
    all.push({ name: ent.name, base, ext, abs, size: safeSize(abs) });
  }
  // 角色根目录里也允许放图片
  for (const ent of listDir(charDir)) {
    if (!ent.isFile()) continue;
    const ext = path.extname(ent.name).toLowerCase();
    if (!IMG_EXT.includes(ext)) continue;
    const abs = path.join(charDir, ent.name);
    const base = ent.name.slice(0, ent.name.length - ext.length);
    if (!map.has(base.toLowerCase())) map.set(base.toLowerCase(), abs);
    all.push({ name: ent.name, base, ext, abs, size: safeSize(abs) });
  }
  return { map, all };
}

let PNG_DIM_CACHE = new Map();
function safeSize(p) {
  try { return fs.statSync(p).size; } catch (e) { return 0; }
}

/** 从 PNG/JPG 头读取宽高（用于前端无需额外请求即可布局） */
function imageSize(file) {
  if (PNG_DIM_CACHE.has(file)) return PNG_DIM_CACHE.get(file);
  let out = null;
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, 65536, 0);
    fs.closeSync(fd);
    const ext = path.extname(file).toLowerCase();
    if (ext === '.png' && n > 24 && buf.toString('ascii', 1, 4) === 'PNG') {
      out = { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    } else if (ext === '.gif') {
      out = { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    } else {
      // JPEG 逐段扫描
      let i = 2;
      while (i + 9 < n) {
        if (buf[i] !== 0xff) { i++; continue; }
        const m = buf[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          out = { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
          break;
        }
        const len = buf.readUInt16BE(i + 2);
        if (len <= 0) break;
        i += 2 + len;
      }
    }
  } catch (e) { out = null; }
  PNG_DIM_CACHE.set(file, out);
  return out;
}

/* ------------------------------ 角色扫描 / 解析 ------------------------------ */

function isExportJson(obj) {
  // 导出版：skeleton.spine 有版本号，且 skins 为数组
  return !!(obj && obj.skeleton && obj.skeleton.spine && Array.isArray(obj.skins));
}

function isSourceJson(obj) {
  return !!(obj && obj.skins && !Array.isArray(obj.skins) && obj.skins.default);
}

/**
 * 「皮肤型」源 JSON：PSD 用「皮肤」模式导出，skins 里是多套并列的皮肤
 * （如 { "01":{...}, "02":{...}, "03":{...} }），而不是单套 default。
 * 判定：不是导出版 + skins 是对象 + 皮肤数 > 1（或压根没有 default）。
 */
function isSkinSourceJson(obj) {
  if (!obj || isExportJson(obj) || !obj.skins || Array.isArray(obj.skins)) return false;
  const keys = Object.keys(obj.skins);
  if (!keys.length) return false;
  return keys.length > 1 || !obj.skins.default;
}

/**
 * 深层图片索引：把角色目录（含 images / [skin]images / 皮肤子目录）里的图
 * 按「末尾 1~3 段相对路径」建索引，这样 "01/arm_right_up" 这种带皮肤前缀的
 * 附件名也能命中 [skin]images/01/arm_right_up.png。
 */
function buildDeepImageIndex(dir, maxDepth) {
  maxDepth = maxDepth || 5;
  const byPath = new Map();   // 末尾N段路径(小写) -> 绝对路径
  const byBase = new Map();   // 文件名(小写,无扩展) -> [{abs, relPath}]
  const walk = (d, depth, relParts) => {
    if (depth > maxDepth) return;
    for (const e of listDir(d)) {
      if (e.isDirectory()) { walk(path.join(d, e.name), depth + 1, relParts.concat(e.name)); continue; }
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (!IMG_EXT.includes(ext)) continue;
      const abs = path.join(d, e.name);
      const base = e.name.slice(0, e.name.length - ext.length).toLowerCase();
      const rel = relParts.concat(base);
      for (let k = 1; k <= Math.min(3, rel.length); k++) {
        const key = rel.slice(-k).join('/').toLowerCase();
        if (!byPath.has(key)) byPath.set(key, abs);
      }
      if (!byBase.has(base)) byBase.set(base, []);
      byBase.get(base).push({ abs, relPath: rel.join('/').toLowerCase() });
    }
  };
  walk(dir, 0, []);
  return { byPath, byBase };
}

/** 附件名 -> 图片绝对路径；优先精确路径，再按皮肤名目录兜底，最后退回同名文件 */
function resolveSkinImage(idx, attName, skinName) {
  const norm = (s) => String(s || '').replace(/\\/g, '/').replace(/^\.?\//, '')
    .replace(/\.[^./]+$/, '').toLowerCase();
  const n = norm(attName);
  const parts = n.split('/').filter(Boolean);
  const base = parts.length ? parts[parts.length - 1] : n;
  const sn = String(skinName == null ? '' : skinName).toLowerCase();
  const cands = [n];
  if (sn) cands.push(sn + '/' + base);
  cands.push(base);
  for (const c of cands) {
    if (c && idx.byPath.has(c)) return idx.byPath.get(c);
  }
  const arr = idx.byBase.get(base);
  if (arr && arr.length) {
    const hit = sn ? arr.find((x) => x.relPath.split('/').indexOf(sn) >= 0) : null;
    return (hit || arr[0]).abs;
  }
  return null;
}

const SKIN_CACHE = new Map();

/** 扫描 spine/ 下所有「皮肤型」源 JSON（目录内 + 一级子目录） */
function scanSkinModels(force) {
  if (!force && SKIN_CACHE.size) return Array.from(SKIN_CACHE.values());
  SKIN_CACHE.clear();
  for (const ent of listDir(SPINE_DIR)) {
    if (!ent.isDirectory()) continue;
    const charDir = path.join(SPINE_DIR, ent.name);
    const files = [];
    for (const e of listDir(charDir)) {
      const p = path.join(charDir, e.name);
      if (e.isFile() && e.name.toLowerCase().endsWith('.json')) { files.push({ rel: e.name, abs: p }); continue; }
      if (!e.isDirectory()) continue;
      for (const f of listDir(p)) {
        if (f.isFile() && f.name.toLowerCase().endsWith('.json')) {
          files.push({ rel: e.name + '/' + f.name, abs: path.join(p, f.name) });
        }
      }
    }
    for (const f of files) {
      const obj = readJson(f.abs);
      if (!isSkinSourceJson(obj)) continue;
      const skinNames = Object.keys(obj.skins);
      let optCount = 0;
      for (const sn of skinNames) {
        const sk = obj.skins[sn] || {};
        for (const k of Object.keys(sk)) optCount += Object.keys(sk[k] || {}).length;
      }
      const id = ent.name + '/' + f.rel.replace(/\.json$/i, '');
      SKIN_CACHE.set(id, {
        id,
        dir: ent.name,
        file: f.rel,
        skinNames,
        slotCount: (obj.slots || []).length,
        optionCount: optCount,
        animations: Object.keys(obj.animations || {}),
        bytes: safeSize(f.abs),
      });
    }
  }
  return Array.from(SKIN_CACHE.values());
}

function findSkinModelFile(id) {
  const m = scanSkinModels().find((x) => x.id === id);
  if (!m) return null;
  return { meta: m, abs: path.join(SPINE_DIR, m.dir, m.file.split('/').join(path.sep)) };
}

/** 解析皮肤型源 JSON -> 「部位 × 皮肤」选项矩阵 */
function parseSkinModel(id) {
  const f = findSkinModelFile(id);
  if (!f) return null;
  const doc = readJson(f.abs);
  if (!doc) return null;
  const charDir = path.join(SPINE_DIR, f.meta.dir);
  const idx = buildDeepImageIndex(charDir);
  const skinNames = Object.keys(doc.skins);
  const slotsDecl = doc.slots || [];

  const slotOrder = slotsDecl.map((s) => s.name);
  for (const sn of skinNames) {
    for (const k of Object.keys(doc.skins[sn] || {})) if (!slotOrder.includes(k)) slotOrder.push(k);
  }

  const slots = [];
  const missing = {};
  skinNames.forEach((s) => { missing[s] = []; });

  for (const slotName of slotOrder) {
    const decl = slotsDecl.find((s) => s.name === slotName) || null;
    const options = {};
    for (const sn of skinNames) {
      const atts = (doc.skins[sn] || {})[slotName];
      if (!atts || !Object.keys(atts).length) { options[sn] = null; missing[sn].push(slotName); continue; }
      const attKey = (decl && decl.attachment && atts[decl.attachment]) ? decl.attachment : Object.keys(atts)[0];
      const r = atts[attKey] || {};
      const imgAbs = resolveSkinImage(idx, r.name || attKey, sn);
      const dim = imgAbs ? imageSize(imgAbs) : null;
      options[sn] = {
        skin: sn,
        attachment: attKey,
        name: r.name || attKey,
        x: r.x, y: r.y,
        w: Math.round(r.width || 0), h: Math.round(r.height || 0),
        rot: r.rotation || 0,
        scaleX: r.scaleX == null ? 1 : r.scaleX,
        scaleY: r.scaleY == null ? 1 : r.scaleY,
        hasImage: !!imgAbs,
        imgUrl: imgAbs ? '/spine/' + enc(rel(imgAbs)).replace(/^spine\//, '') : null,
        naturalW: dim ? dim.w : null,
        naturalH: dim ? dim.h : null,
      };
    }
    slots.push({
      name: slotName,
      bone: (decl && decl.bone) || 'root',
      defaultAttachment: (decl && decl.attachment) || null,
      options,
    });
  }

  // 包围盒取「所有皮肤 × 所有部位」的并集 —— 切换皮肤时画面不会跳
  const xs = [], ys = [];
  for (const s of slots) {
    for (const sn of skinNames) {
      const o = s.options[sn];
      if (!o) continue;
      xs.push(o.x - o.w / 2, o.x + o.w / 2);
      ys.push(o.y - o.h / 2, o.y + o.h / 2);
    }
  }
  const pad = doc.PhotoshopToSpine && doc.PhotoshopToSpine.padding != null ? doc.PhotoshopToSpine.padding : 1;
  const bbox = {
    x0: Math.floor(Math.min(...xs)) - pad,
    x1: Math.ceil(Math.max(...xs)) + pad,
    y0: Math.floor(Math.min(...ys)) - pad,
    y1: Math.ceil(Math.max(...ys)) + pad,
  };
  bbox.width = bbox.x1 - bbox.x0;
  bbox.height = bbox.y1 - bbox.y0;

  return {
    id: f.meta.id,
    dir: f.meta.dir,
    file: f.meta.file,
    jsonUrl: '/spine/' + enc(rel(f.abs)).replace(/^spine\//, ''),
    skinNames,
    slots,
    missing,
    bbox,
    animations: f.meta.animations,
    scale: (doc.PhotoshopToSpine && doc.PhotoshopToSpine.scale) || 1,
    trim: !!(doc.PhotoshopToSpine && doc.PhotoshopToSpine.trim),
  };
}

function rel(abs) {
  return path.relative(ROOT, abs).split(path.sep).join('/');
}

/** 列出某角色的导出版（用于动画台） */
function findExports(charDir) {
  const found = [];
  const visit = (dir, depth) => {
    if (depth > 2) return;
    const ents = listDir(dir);
    const jsons = ents.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.json'));
    for (const j of jsons) {
      const obj = readJson(path.join(dir, j.name));
      if (!isExportJson(obj)) continue;
      const base = j.name.slice(0, -5);
      const atlas = ents.find((e) => e.isFile() && e.name.toLowerCase() === (base + '.atlas').toLowerCase());
      if (!atlas) continue;
      const pngName = (() => {
        const txt = fs.readFileSync(path.join(dir, atlas.name), 'utf8');
        const line = txt.split(/\r?\n/).map((s) => s.trim()).find((s) => /\.(png|jpg|webp)$/i.test(s));
        return line || null;
      })();
      found.push({
        label: rel(dir).replace(/^spine\//, '').replace(/^[^/]+\//, '') || 'export',
        dirRel: rel(dir),
        jsonUrl: '/spine/' + enc(rel(path.join(dir, j.name))).replace(/^spine\//, ''),
        atlasUrl: '/spine/' + enc(rel(path.join(dir, atlas.name))).replace(/^spine\//, ''),
        pngUrl: pngName ? '/spine/' + enc(rel(path.join(dir, pngName))).replace(/^spine\//, '') : null,
        spineVersion: obj.skeleton.spine,
        animations: Object.keys(obj.animations || {}),
        skinCount: Array.isArray(obj.skins) ? obj.skins.length : (obj.skins ? Object.keys(obj.skins).length : 0),
        boneCount: (obj.bones || []).length,
        slotCount: (obj.slots || []).length,
        bbox: { x: obj.skeleton.x, y: obj.skeleton.y, width: obj.skeleton.width, height: obj.skeleton.height },
        bytes: { json: safeSize(path.join(dir, j.name)), atlas: safeSize(path.join(dir, atlas.name)) },
      });
    }
    for (const e of ents) {
      if (e.isDirectory()) visit(path.join(dir, e.name), depth + 1);
    }
  };
  visit(charDir, 0);
  return found;
}

/** 扫描「带皮肤的动画导出」：用于「动画换装」栏目。
 *  条件：是导出版 + 皮肤数 > 1 + 有动画。 */
function scanActSkins(force) {
  const out = [];
  const seen = new Set();
  const chars = scanCharacters(force);
  for (const c of chars) {
    for (const e of (c.exports || [])) {
      if (e.skinCount > 1 && (e.animations || []).length) {
        const key = e.dirRel + '|' + e.label;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          id: e.dirRel,
          label: e.label,
          dirRel: e.dirRel,
          jsonUrl: e.jsonUrl,
          atlasUrl: e.atlasUrl,
          pngUrl: e.pngUrl,
          spineVersion: e.spineVersion,
          animations: e.animations,
          skinCount: e.skinCount,
          boneCount: e.boneCount,
          slotCount: e.slotCount,
        });
      }
    }
  }
  return out;
}

const CHAR_CACHE = new Map();

function scanCharacters(force) {
  if (!force && CHAR_CACHE.size) return Array.from(CHAR_CACHE.values());
  CHAR_CACHE.clear();
  for (const ent of listDir(SPINE_DIR)) {
    if (!ent.isDirectory()) continue;
    const charDir = path.join(SPINE_DIR, ent.name);
    const id = ent.name;
    const jsons = listDir(charDir).filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.json'));

    // 选主源文件：优先与文件夹同名的
    let srcFile = jsons.find((j) => j.name.toLowerCase().replace(/\.json$/, '').toLowerCase() === id.toLowerCase());
    const others = [];
    for (const j of jsons) {
      const obj = readJson(path.join(charDir, j.name));
      if (isSourceJson(obj)) {
        others.push({ name: j.name, slots: (obj.slots || []).length });
        if (!srcFile) srcFile = j;
      }
    }
    const exports_ = findExports(charDir);
    if (!srcFile && !exports_.length) continue;

    CHAR_CACHE.set(id, {
      id,
      name: id,
      hasSource: !!srcFile,
      sourceFile: srcFile ? srcFile.name : null,
      otherSources: others.filter((o) => !srcFile || o.name !== srcFile.name),
      exports: exports_,
      exportCount: exports_.length,
    });
  }
  return Array.from(CHAR_CACHE.values());
}

/** 解析源 JSON -> 可换装部件表 */
function parseCharacter(id) {
  const charDir = path.join(SPINE_DIR, id);
  if (!fs.existsSync(charDir)) return null;
  const meta = scanCharacters().find((c) => c.id === id);
  if (!meta || !meta.sourceFile) return null;

  const jsonPath = path.join(charDir, meta.sourceFile);
  const doc = readJson(jsonPath);
  if (!doc) return null;
  const skin = doc.skins.default || {};
  const slots = doc.slots || [];
  const idx = buildImageIndex(charDir);

  const slotOrder = slots.map((s) => s.name);
  // skins 里可能存在 slots 未声明的项 -> 追加
  for (const k of Object.keys(skin)) if (!slotOrder.includes(k)) slotOrder.push(k);

  const parts = [];
  const usedFiles = new Set();
  let z = 0;
  for (const slotName of slotOrder) {
    const slotDecl = slots.find((s) => s.name === slotName);
    const atts = skin[slotName];
    if (!atts) continue;
    const attNames = Object.keys(atts);
    // 关键：Spine 里 slot 没写 attachment 就是「默认不显示」——
    // PSD 里导出的侧身/闭眼/备用部件都属于这一类，必须默认隐藏，否则还原出来是错的。
    const activeName = slotDecl && slotDecl.attachment ? slotDecl.attachment : null;
    for (const attName of attNames) {
      const r = atts[attName] || {};
      const w = Math.round(r.width || 0);
      const h = Math.round(r.height || 0);
      const imgAbs = idx.map.get(attName.toLowerCase()) || idx.map.get(slotName.toLowerCase()) || null;
      if (imgAbs) usedFiles.add(path.basename(imgAbs).toLowerCase());
      const dim = imgAbs ? imageSize(imgAbs) : null;
      parts.push({
        id: `${slotName}::${attName}`,
        slot: slotName,
        attachment: attName,
        x: r.x, y: r.y, w, h,
        bone: (slotDecl && slotDecl.bone) || 'root',
        active: activeName ? attName === activeName : false,
        variant: !activeName,
        hasImage: !!imgAbs,
        imgUrl: imgAbs ? '/spine/' + enc(rel(imgAbs)).replace(/^spine\//, '') : null,
        naturalW: dim ? dim.w : null,
        naturalH: dim ? dim.h : null,
        z: z++,
      });
    }
  }

  // 未被引用的图片 -> 「备用素材」，可手动挂到任意槽位
  const extras = idx.all
    .filter((f) => !usedFiles.has(f.name.toLowerCase()))
    .map((f) => ({
      name: f.name,
      imgUrl: '/spine/' + enc(rel(f.abs)).replace(/^spine\//, ''),
      naturalW: (imageSize(f.abs) || {}).w || null,
      naturalH: (imageSize(f.abs) || {}).h || null,
    }));

  const actives = parts.filter((p) => p.active);
  const boxes = actives.length ? actives : parts;
  const xs = [], ys = [];
  for (const p of boxes) {
    xs.push(p.x - p.w / 2, p.x + p.w / 2);
    ys.push(p.y - p.h / 2, p.y + p.h / 2);
  }
  const pad = doc.PhotoshopToSpine && doc.PhotoshopToSpine.padding != null ? doc.PhotoshopToSpine.padding : 1;
  const bbox = {
    x0: Math.floor(Math.min(...xs)) - pad,
    x1: Math.ceil(Math.max(...xs)) + pad,
    y0: Math.floor(Math.min(...ys)) - pad,
    y1: Math.ceil(Math.max(...ys)) + pad,
  };
  bbox.width = bbox.x1 - bbox.x0;
  bbox.height = bbox.y1 - bbox.y0;

  return {
    id,
    name: id,
    sourceFile: meta.sourceFile,
    jsonUrl: '/spine/' + enc(rel(jsonPath)).replace(/^spine\//, ''),
    scale: (doc.PhotoshopToSpine && doc.PhotoshopToSpine.scale) || 1,
    trim: !!(doc.PhotoshopToSpine && doc.PhotoshopToSpine.trim),
    bones: (doc.bones || []).map((b) => b.name),
    parts,
    extras,
    bbox,
    exports: meta.exports,
    others: meta.otherSources,
  };
}

/* --------------------------------- 启动 --------------------------------- */

function serveStatic(res, absPath) {
  fs.stat(absPath, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
    const ext = path.extname(absPath).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ext === '.html' || ext === '.js' || ext === '.css' ? 'no-cache' : 'public, max-age=3600',
    };
    if (ext === '.atlas' || ext === '.txt' || ext === '.json') {
      headers['Content-Type'] += '';
    }
    res.writeHead(200, headers);
    fs.createReadStream(absPath).pipe(res);
  });
}

function safeJoin(base, relPath) {
  const p = path.resolve(base, '.' + path.sep + relPath.replace(/^[\\/]+/, ''));
  if (!p.startsWith(path.resolve(base))) return null;
  return p;
}

const server = http.createServer(async (req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(url.parse(req.url).pathname);
  } catch (e) {
    return send(res, 400, 'Bad Request');
  }
  const q = url.parse(req.url, true).query;

  try {
    /* ---------- API ---------- */
    if (pathname.startsWith('/api/')) {
      // 探针：launcher 用它识别「端口上是否已是本工坊实例」，并拿到 pid 以便重启
      if (pathname === '/api/ping') {
        return sendJson(res, 200, {
          app: APP_ID, pid: process.pid, port: PORT,
          startedAt: START_TS, root: ROOT,
        });
      }
      /* ============ AI 智能切分网关（代理到 127.0.0.1:5311 常驻 Python 服务）============
       * 模型（SAM3 1.7GB + YOLOv8-pose）加载一次常驻内存，Node 只做转发与拉起。 */
      if (pathname === '/api/ai/health') {
        const r = await aiRequest('/health', 'GET', null, 4000);
        return sendJson(res, 200, r.data || { status: 'stopped' });
      }
      if (pathname === '/api/ai/start' && req.method === 'POST') {
        const probe = await aiRequest('/health', 'GET', null, 2500);
        if (probe.data) return sendJson(res, 200, { ok: true, already: true, health: probe.data });
        const st = ensureAi();
        return sendJson(res, 200, { ok: !!st.started, ...st });
      }
      if (pathname === '/api/ai/stop' && req.method === 'POST') {
        const r = await aiRequest('/shutdown', 'POST', {}, 4000);
        return sendJson(res, 200, { ok: !!r.data, status: r.data ? 'stopped' : 'no-response' });
      }
      if (pathname === '/api/ai/segment' && req.method === 'POST') {
        const body = await readBody(req, 120 * 1024 * 1024);
        let payload;
        try { payload = JSON.parse(body.toString('utf8')); } catch (e) {
          return sendJson(res, 400, { ok: false, error: 'JSON 解析失败' });
        }
        const r = await aiRequest('/segment', 'POST', payload, 600000);
        if (!r.data) return sendJson(res, 502, { ok: false, error: 'AI 服务无响应（可能未启动或仍在加载）' });
        return sendJson(res, r.status || 200, r.data);
      }
      // 列表
      if (pathname === '/api/characters') {
        return sendJson(res, 200, { characters: scanCharacters(q.refresh === '1') });
      }
      // 单个角色部件表
      let m = pathname.match(/^\/api\/character\/([^/]+)$/);
      if (m) {
        const d = parseCharacter(m[1]);
        if (!d) return sendJson(res, 404, { error: 'character not found: ' + m[1] });
        return sendJson(res, 200, d);
      }

      /* ===== 皮肤型模型（多皮肤源 JSON）===== */
      if (pathname === '/api/skinmodels') {
        return sendJson(res, 200, { models: scanSkinModels(q.refresh === '1') });
      }
      // 带皮肤的动画导出（用于动画换装栏目）
      if (pathname === '/api/actskins') {
        return sendJson(res, 200, { models: scanActSkins(q.refresh === '1') });
      }
      if (pathname === '/api/skinmodel') {
        const d = parseSkinModel(q.id || '');
        if (!d) return sendJson(res, 404, { error: 'skin model not found: ' + (q.id || '') });
        return sendJson(res, 200, d);
      }
      // 把「逐部位混搭」的结果合成一个新皮肤，写回 JSON 供 Spine 直接导入
      if (pathname === '/api/skin/merge' && req.method === 'POST') {
        let payload;
        try { payload = JSON.parse((await readBody(req)).toString('utf8')); }
        catch (e) { return sendJson(res, 400, { error: 'JSON 解析失败' }); }
        const f = findSkinModelFile(String(payload.id || ''));
        if (!f) return sendJson(res, 404, { error: 'skin model not found' });
        const doc = readJson(f.abs);
        if (!doc) return sendJson(res, 404, { error: '源 JSON 读取失败' });
        const skinName = String(payload.skinName || 'mix').trim() || 'mix';
        const choice = payload.choice || {};
        const mix = {};
        let n = 0;
        for (const slotName of Object.keys(choice)) {
          const sn = choice[slotName];
          if (!sn) continue;                       // '' = 该部位不挂附件
          const src = (doc.skins[sn] || {})[slotName];
          if (!src) continue;
          mix[slotName] = JSON.parse(JSON.stringify(src));
          n++;
        }
        doc.skins[skinName] = mix;
        // 原 JSON 没有 default 皮肤时，顺带复制一份为 default，
        // 这样 Spine 导入后 setup pose 直接就是混搭结果，不用再手动选皮肤。
        let asDefault = false;
        if (payload.asDefault !== false && !doc.skins.default) {
          doc.skins.default = JSON.parse(JSON.stringify(mix));
          asDefault = true;
        }
        const base = f.meta.file.replace(/^.*\//, '').replace(/\.json$/i, '');
        return sendJson(res, 200, {
          ok: true, skinName, asDefault, attachments: n,
          fileName: base + '_' + skinName + '.json',
          json: doc,
        });
      }
      // 混搭预设
      if (pathname === '/api/skinmix' && req.method === 'GET') {
        const files = listDir(SKINMIX_DIR).filter((e) => e.isFile() && e.name.endsWith('.json'));
        const list = files.map((fn) => readJson(path.join(SKINMIX_DIR, fn.name)) || {})
          .filter((o) => o && o.id)
          .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        return sendJson(res, 200, { mixes: list });
      }
      if (pathname === '/api/skinmix' && req.method === 'POST') {
        let o;
        try { o = JSON.parse((await readBody(req)).toString('utf8')); }
        catch (e) { return sendJson(res, 400, { error: 'JSON 解析失败' }); }
        if (!o || !o.id) return sendJson(res, 400, { error: 'id required' });
        o.updatedAt = Date.now();
        fs.writeFileSync(
          path.join(SKINMIX_DIR, String(o.id).replace(/[\\/:*?"<>|]+/g, '_') + '.json'),
          JSON.stringify(o, null, 2), 'utf8');
        return sendJson(res, 200, { ok: true, id: o.id });
      }
      m = pathname.match(/^\/api\/skinmix\/(.+)$/);
      if (m) {
        const f = path.join(SKINMIX_DIR, path.basename(m[1]) + '.json');
        if (req.method === 'GET') {
          if (!fs.existsSync(f)) return sendJson(res, 404, { error: 'not found' });
          return sendJson(res, 200, readJson(f));
        }
        if (req.method === 'DELETE') {
          if (fs.existsSync(f)) fs.unlinkSync(f);
          return sendJson(res, 200, { ok: true });
        }
      }
      // 部件库
      if (pathname === '/api/parts' && req.method === 'GET') {
        const files = listDir(UPLOAD_DIR).filter((e) => e.isFile() && IMG_EXT.includes(path.extname(e.name).toLowerCase()));
        const parts = files.map((f) => {
          const abs = path.join(UPLOAD_DIR, f.name);
          const dim = imageSize(abs) || {};
          return {
            name: f.name,
            url: '/data/uploads/' + encodeURIComponent(f.name),
            w: dim.w, h: dim.h, size: safeSize(abs),
            mtime: fs.statSync(abs).mtimeMs,
          };
        }).sort((a, b) => b.mtime - a.mtime);
        return sendJson(res, 200, { parts });
      }
      /* 切割工坊：把切好的部件 + 骨架 JSON 落盘成 spine/<角色>/ 角色目录 */
      if (pathname === '/api/cutter/export' && req.method === 'POST') {
        const _t0 = Date.now();
        const body = await readBody(req, 120 * 1024 * 1024);
        const _t1 = Date.now();
        const payload = JSON.parse(body.toString('utf8'));
        const id = String(payload.id || '').trim();
        if (!/^[A-Za-z0-9_\-]+$/.test(id)) {
          return sendJson(res, 400, { error: '角色 ID 只能包含字母、数字、下划线、连字符' });
        }
        const list = Array.isArray(payload.parts) ? payload.parts : [];
        if (!list.length) return sendJson(res, 400, { error: '没有可导出的部件' });

        const dir = path.join(SPINE_DIR, id);
        const imgDir = path.join(dir, 'images');
        if (fs.existsSync(dir) && !payload.overwrite) {
          return sendJson(res, 409, { error: '角色「' + id + '」已存在，勾选「允许覆盖」后重试' });
        }
        // 旧文件不在这里删：删除操作在部分环境（杀软/审计钩子）下会阻塞十几秒，
        // 改为「先覆盖写，响应后再异步清理」，保证导出始终秒回。
        const hadDir = fs.existsSync(imgDir);
        const oldFiles = hadDir
          ? fs.readdirSync(imgDir).filter((f) => f.toLowerCase().endsWith('.png'))
          : [];
        const _tMk = Date.now();
        fs.mkdirSync(imgDir, { recursive: true });

        let n = 0;
        const written = new Set();
        for (const p of list) {
          // 允许中文；只拦路径分隔符与控制字符（前端已清理并去重，这里兜底）
          const name = String(p.name || ('part_' + (n + 1))).replace(/[\\/:*?"<>|]/g, '_').trim();
          if (!name || name.length > 80 || /[\x00-\x1f]/.test(name)) {
            return sendJson(res, 400, { error: '部件名非法：' + name });
          }
          const mm = /^data:image\/png;base64,(.*)$/.exec(String(p.dataUrl || ''));
          if (!mm) return sendJson(res, 400, { error: '部件图不是 PNG dataURL：' + name });
          const file = name + '.png';
          fs.writeFileSync(path.join(imgDir, file), Buffer.from(mm[1], 'base64'));
          written.add(file.toLowerCase());
          n++;
        }
        const _t2 = Date.now();
        const json = payload.skeleton && typeof payload.skeleton === 'object' ? payload.skeleton : {};
        fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(json, null, 1), 'utf8');
        const _t3 = Date.now();
        console.log('  [cutter/export] ' + id + ': 收包 ' + (_t1 - _t0) + 'ms(' +
          (body.length / 1048576).toFixed(2) + 'MB) · 写PNG ' + (_t2 - _tMk) + 'ms · 写JSON ' +
          (_t3 - _t2) + 'ms · ' + n + ' 个部件');
        const clean = sendJson(res, 200, {
          ok: true, id, files: n, cleaned: 0,
          dir: path.relative(ROOT, dir).replace(/\\/g, '/'),
        });
        // 响应之后再清理改名留下的旧 PNG，失败静默
        setTimeout(() => {
          let gone = 0;
          for (const f of oldFiles) {
            if (written.has(f.toLowerCase())) continue;
            try { fs.unlinkSync(path.join(imgDir, f)); gone++; } catch (e) { /* 忽略 */ }
          }
          if (gone) console.log('  [cutter/export] ' + id + ': 已清理 ' + gone + ' 个旧部件图');
        }, 600);
        return clean;
      }
      if (pathname === '/api/parts/upload' && req.method === 'POST') {
        const body = await readBody(req);
        const { name, dataUrl, charFolder } = JSON.parse(body.toString('utf8'));
        if (!name || !dataUrl) return sendJson(res, 400, { error: 'name/dataUrl required' });
        const mm = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
        if (!mm) return sendJson(res, 400, { error: 'bad dataUrl' });
        let ext = ('.' + (mm[1].split('/')[1] || 'png')).replace('.jpeg', '.jpg').replace('.svg+xml', '.svg');
        if (!IMG_EXT.includes(ext) && ext !== '.svg') ext = '.png';
        const safeName = String(name).replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
        const base = safeName.toLowerCase().endsWith(ext) ? safeName : safeName + ext;
        let target = path.join(UPLOAD_DIR, base);
        if (fs.existsSync(target)) {
          target = path.join(UPLOAD_DIR, base.slice(0, base.length - ext.length) + '_' + Date.now() + ext);
        }
        fs.writeFileSync(target, Buffer.from(mm[2], 'base64'));
        const dim = imageSize(target) || {};
        return sendJson(res, 200, {
          ok: true, name: path.basename(target),
          url: '/data/uploads/' + encodeURIComponent(path.basename(target)),
          w: dim.w, h: dim.h,
          folder: charFolder || null,
        });
      }
      m = pathname.match(/^\/api\/parts\/(.+)$/);
      if (m && req.method === 'DELETE') {
        const f = path.join(UPLOAD_DIR, path.basename(m[1]));
        if (fs.existsSync(f)) fs.unlinkSync(f);
        return sendJson(res, 200, { ok: true });
      }
      // 套装
      if (pathname === '/api/outfits' && req.method === 'GET') {
        const files = listDir(OUTFIT_DIR).filter((e) => e.isFile() && e.name.endsWith('.json'));
        const list = files.map((f) => {
          const o = readJson(path.join(OUTFIT_DIR, f.name)) || {};
          return { id: o.id || f.name.replace(/\.json$/, ''), name: o.name, charId: o.charId, updatedAt: o.updatedAt, thumb: o.thumb || null, parts: (o.parts || []).length };
        }).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        return sendJson(res, 200, { outfits: list });
      }
      if (pathname === '/api/outfits' && req.method === 'POST') {
        const body = await readBody(req);
        const o = JSON.parse(body.toString('utf8'));
        if (!o || !o.id) return sendJson(res, 400, { error: 'id required' });
        o.updatedAt = Date.now();
        const f = path.join(OUTFIT_DIR, String(o.id).replace(/[\\/:*?"<>|]/g, '_') + '.json');
        fs.writeFileSync(f, JSON.stringify(o, null, 2), 'utf8');
        return sendJson(res, 200, { ok: true, id: o.id, file: rel(f) });
      }
      m = pathname.match(/^\/api\/outfits\/(.+)$/);
      if (m && req.method === 'GET') {
        const f = path.join(OUTFIT_DIR, path.basename(m[1]) + '.json');
        if (!fs.existsSync(f)) return sendJson(res, 404, { error: 'not found' });
        return sendJson(res, 200, readJson(f));
      }
      if (m && req.method === 'DELETE') {
        const f = path.join(OUTFIT_DIR, path.basename(m[1]) + '.json');
        if (fs.existsSync(f)) fs.unlinkSync(f);
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 404, { error: 'no such api' });
    }

    /* ---------- 静态资源 ---------- */
    if (pathname === '/' || pathname === '') return serveStatic(res, path.join(PUBLIC_DIR, 'index.html'));

    const mounts = [
      ['/spine/', SPINE_DIR],
      ['/data/uploads/', UPLOAD_DIR],
      ['/data/outfits/', OUTFIT_DIR],
      ['/vendor/', VENDOR_DIR],
      ['/public/', PUBLIC_DIR],
    ];
    for (const [prefix, base] of mounts) {
      if (pathname.startsWith(prefix)) {
        const abs = safeJoin(base, pathname.slice(prefix.length));
        if (!abs) return send(res, 403, 'Forbidden');
        return serveStatic(res, abs);
      }
    }
    // public 根
    return serveStatic(res, safeJoin(PUBLIC_DIR, pathname) || path.join(PUBLIC_DIR, 'index.html'));
  } catch (err) {
    console.error('[ERR]', pathname, err && err.message);
    return sendJson(res, 500, { error: String((err && err.message) || err) });
  }
});

/** 打开系统默认浏览器 */
function openBrowser(target) {
  try {
    require('child_process').spawn('cmd', ['/c', 'start', '', target], {
      detached: true, stdio: 'ignore',
    }).unref();
    return true;
  } catch (e) { return false; }
}

// 端口被占用时不要抛未捕获异常（以前会甩一大段 Events 栈，看着像"没找到 node"）
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error('');
    console.error('  [端口被占用] 127.0.0.1:' + PORT + ' 已经被别的程序监听。');
    console.error('    · 如果是本工坊的旧实例：双击「重启.bat」强制重启');
    console.error('    · 如果是其它程序占用：换端口启动，如  node launcher.js --port=5311');
    console.error('');
    process.exit(3);
  }
  console.error('  [启动失败] ' + (err && err.message));
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  const chars = scanCharacters(true);
  console.log('==============================================');
  console.log('  Spine 人物装配工坊');
  console.log('  http://127.0.0.1:' + PORT);
  console.log('----------------------------------------------');
  console.log('  扫描到角色 ' + chars.length + ' 个：');
  for (const c of chars) {
    console.log('   · ' + c.id.padEnd(10) + ' 源JSON:' + (c.hasSource ? '有' : '无') +
      '  导出版:' + c.exportCount + (c.exportCount ? ' (' + c.exports.map(e => e.animations.length + '动作').join(', ') + ')' : ''));
  }
  console.log('==============================================');
  console.log('  关掉这个窗口 = 停止服务');
  console.log('==============================================');

  // 由 launcher 通过环境变量指定要打开的地址；直接 node server.js 时认 --open
  const target = process.env.SPINE_OPEN_URL ||
    (process.argv.includes('--open') ? 'http://127.0.0.1:' + PORT : '');
  if (target) openBrowser(target);
});

