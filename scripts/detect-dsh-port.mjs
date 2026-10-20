// 启动前的 DSH 端口自愈：DSH 桌面版每次启动都会换一个本地端口，
// 而 config.json 里的 dsh.baseUrl 是静态的 —— 不更新就会出现「DSH 事件流 0 帧」。
//
// 步骤：
//   1. 用 tasklist 找出 DeepSeek Harness 的进程；
//   2. 用 netstat -ano 取这些进程在 127.0.0.1 上 LISTENING 的端口；
//   3. 用桥接自己的 NodeApiClient（离线铸造会话 Cookie）逐个试 settings.describe，
//      通了就是它；
//   4. 把 http://127.0.0.1:<port> 写回 config.json。
//
// 失败绝不阻塞启动：保持原 baseUrl，把原因打出来，让桥接自己报错。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NodeApiClient, unwrap } from '../src/dsh-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONFIG = path.join(ROOT, 'config.json');
const DSH_IMAGES = ['DeepSeek Harness.exe', 'dsh.exe'];

function log(msg) {
  console.log(`[dsh-port] ${msg}`);
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  return r.error ? '' : String(r.stdout ?? '');
}

function dshPids() {
  const pids = new Set();
  for (const image of DSH_IMAGES) {
    const out = run('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH']);
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^"([^"]+)","(\d+)"/);
      if (m && m[1].toLowerCase() === image.toLowerCase()) pids.add(Number(m[2]));
    }
  }
  return pids;
}

function listeningPorts(pidFilter) {
  const out = run('netstat', ['-ano']);
  const ports = new Map(); // port -> pid
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/);
    if (!m) continue;
    const [, host, port, pid] = m;
    if (!/^(127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\])$/.test(host)) continue;
    const n = Number(port);
    if (n < 1024 || n > 65535) continue;
    if (pidFilter && !pidFilter.has(Number(pid))) continue;
    ports.set(n, Number(pid));
  }
  return ports;
}

async function authenticated(port) {
  try {
    const api = new NodeApiClient(`http://127.0.0.1:${port}`);
    const desc = await Promise.race([
      api.settings.describe({}).then((v) => unwrap(v, 'settings.describe')),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2500)),
    ]);
    return Boolean(desc && typeof desc === 'object');
  } catch {
    return false;
  }
}

const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const current = String(cfg.dsh?.baseUrl ?? '').trim();
log(`config 当前: ${current || '(空)'}`);

const pids = dshPids();
log(`DeepSeek Harness 进程: ${[...pids].join(', ') || '未找到'}`);

let candidates = [...listeningPorts(pids).keys()];
if (!candidates.length) {
  // 兜底：进程名对不上时，扫本机所有监听端口（通常几十个，逐个用鉴权探测）。
  log('⚠️ 没匹配到 DSH 进程名，退化为扫描全部本机监听端口');
  candidates = [...listeningPorts(null).keys()];
}
log(`候选端口: ${candidates.join(', ') || '无'}`);

let picked = null;
for (const port of candidates) {
  if (await authenticated(port)) { picked = port; break; }
}

if (!picked) {
  log('⚠️ 没找到可用的 DSH 端口（DSH 可能没在运行），保持原 baseUrl');
  process.exit(0);
}

const next = `http://127.0.0.1:${picked}`;
if (next === current) {
  log(`已是最新: ${next}`);
  process.exit(0);
}

cfg.dsh = cfg.dsh ?? {};
cfg.dsh.baseUrl = next;
fs.writeFileSync(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
log(`✅ 已更新 baseUrl: ${current || '(空)'} -> ${next}`);
