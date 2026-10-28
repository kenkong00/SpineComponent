/**
 * Spine 人物装配工坊 — 启动器
 *
 * 解决三个问题：
 *   1. 重复双击「启动.bat」不会再报 EADDRINUSE 崩溃 —— 检测到已有实例就直接开浏览器；
 *   2. 端口被"僵尸进程/别的程序"占用时，给出人话诊断，而不是甩 Node 异常栈；
 *   3. --restart 可以干净地杀掉旧实例再拉起新的（不误杀无关进程：只认本工坊的探针签名）。
 *
 * 用法：
 *   node launcher.js                 # 智能启动（已在运行则复用）
 *   node launcher.js --restart       # 杀掉旧实例后重启
 *   node launcher.js --port=5311     # 换端口
 *   node launcher.js --no-open       # 不自动开浏览器
 *   node launcher.js --status        # 只看状态，不启动
 */
'use strict';

const http = require('http');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const APP_ID = 'spine-assembly-workshop';

/* ---------------- 参数 ---------------- */
const argv = process.argv.slice(2);
const getArg = (name, def) => {
  const hit = argv.find((a) => a === '--' + name || a.startsWith('--' + name + '='));
  if (!hit) return def;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
};
const PORT = Number(getArg('port', process.env.PORT || 5310)) || 5310;
const WANT_RESTART = !!getArg('restart', false);
const WANT_OPEN = !getArg('no-open', false);
const STATUS_ONLY = !!getArg('status', false);
const URL_LOCAL = 'http://127.0.0.1:' + PORT;

/* ---------------- 工具 ---------------- */
function openBrowser(target) {
  try {
    spawn('cmd', ['/c', 'start', '', target], { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch (e) { return false; }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** GET 一个 JSON 接口，永不抛异常 */
function probe(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
        if (body.length > 8192) { req.destroy(); }
      });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(body); } catch (e) { /* 不是 JSON */ }
        resolve({ ok: true, status: res.statusCode, json: json, body: body.slice(0, 200) });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (err) => resolve({ ok: false, error: err }));
  });
}

/** 从 netstat 里找出监听指定端口的进程号（Windows 兜底手段） */
function findPortPids(port) {
  const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8' });
  if (out.error || !out.stdout) return [];
  const pids = new Set();
  const re = new RegExp('[:.]' + port + '\\s+\\S+\\s+LISTENING\\s+(\\d+)', 'i');
  for (const line of out.stdout.split(/\r?\n/)) {
    const m = line.match(re);
    if (m) pids.add(Number(m[1]));
  }
  pids.delete(process.pid);
  return [...pids];
}

/** 结束进程：taskkill 为主，PowerShell Stop-Process 兜底（个别机器组策略禁用其一） */
function killPid(pid) {
  const attempts = [
    ['taskkill', ['/PID', String(pid), '/F']],
    ['powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Stop-Process -Id ' + pid + ' -Force']],
  ];
  let last = null;
  for (const [cmd, args] of attempts) {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    if (!r.error && r.status === 0) return { ok: true };
    last = r.error || new Error(cmd + ' 退出码 ' + r.status + ' ' + String(r.stderr || '').trim());
  }
  return { ok: false, error: last };
}

/* ---------------- 主流程 ---------------- */
async function main() {
  const p = await probe(URL_LOCAL + '/api/ping', 1500);

  /* --- 情况 A：端口上确实是本工坊 --- */
  const isOurs = p.ok && p.status === 200 && p.json && p.json.app === APP_ID;
  if (isOurs) {
    const pid = p.json.pid;
    if (STATUS_ONLY) {
      console.log('  状态：运行中  pid=' + pid + '  端口=' + PORT + '  已运行 ' +
        Math.round((Date.now() - (p.json.startedAt || Date.now())) / 1000) + ' 秒');
      return 0;
    }
    if (!WANT_RESTART) {
      console.log('==============================================');
      console.log('  Spine 人物装配工坊 —— 已经在运行');
      console.log('  http://127.0.0.1:' + PORT + '   (pid ' + pid + ')');
      console.log('----------------------------------------------');
      console.log('  已直接为你打开浏览器，无需重复启动。');
      console.log('  想彻底重启：双击「重启.bat」');
      console.log('==============================================');
      if (WANT_OPEN) openBrowser(URL_LOCAL);
      return 0;
    }
    console.log('  [重启] 关闭旧实例 pid=' + pid + ' ...');
    const k = killPid(pid);
    await sleep(700);
    // 杀不掉也不一定失败（进程可能刚好自己退了），二次探测为准
    const again = await probe(URL_LOCAL + '/api/ping', 1200);
    if (again.ok && again.json && again.json.app === APP_ID) {
      console.error('  [重启失败] 旧实例仍在运行。');
      console.error('    ' + ((k.error && k.error.message) || '结束进程被系统拒绝'));
      console.error('    请在任务管理器里结束 pid=' + pid + ' 后重试。');
      return 3;
    }
    if (!k.ok) console.log('  [提示] 结束进程命令被拒，但端口已释放，继续启动。');
  }

  /* --- 情况 B：端口被别的东西占着（不是本工坊的探针） --- */
  if (p.ok && !isOurs && !WANT_RESTART) {
    console.error('==============================================');
    console.error('  [端口被占用] 127.0.0.1:' + PORT + ' 上的程序不是本工坊。');
    console.error('  探测结果：HTTP ' + p.status + '  ' + (p.json ? JSON.stringify(p.json) : p.body));
    console.error('----------------------------------------------');
    console.error('  可选做法：');
    console.error('    1) 换端口启动： node launcher.js --port=5311');
    console.error('    2) 强制接管：   双击「重启.bat」（会结束占用该端口的进程）');
    console.error('==============================================');
    return 3;
  }
  if (p.ok && !isOurs && WANT_RESTART) {
    for (const pid of findPortPids(PORT)) {
      console.log('  [重启] 强制结束占用端口的进程 pid=' + pid + ' ...');
      const k = killPid(pid);
      if (!k.ok) console.error('    ' + ((k.error && k.error.message) || '结束进程被系统拒绝'));
    }
    await sleep(700);
    const again = await probe(URL_LOCAL + '/api/ping', 1200);
    if (again.ok && !(again.json && again.json.app === APP_ID)) {
      console.error('  [重启失败] 端口 ' + PORT + ' 仍被占用，请手动处理后重试。');
      return 3;
    }
  }

  /* --- 情况 C：端口空闲（或刚被清理干净）→ 启动服务 --- */
  if (STATUS_ONLY) {
    console.log('  状态：未运行（端口 ' + PORT + ' 空闲）');
    return 0;
  }

  process.env.PORT = String(PORT);
  if (WANT_OPEN) process.env.SPINE_OPEN_URL = URL_LOCAL;

  require(path.join(__dirname, 'server.js'));
  return null; // 服务已接管进程，前台常驻
}

main().then((code) => {
  if (code !== null) process.exit(code);
}).catch((err) => {
  console.error('  [启动失败] ' + (err && err.stack || err));
  process.exit(1);
});
