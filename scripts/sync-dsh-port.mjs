// 本机补丁（非上游文件）：DSH 桌面端每次启动会随机挑一个 127.0.0.1 端口，
// 而 qq-bridge 的 config.json 里 dsh.baseUrl 是写死的。启动桥接前先跑一次本脚本，
// 把 baseUrl 同步成 DSH 当前实际监听的端口。
//
// 用法：node scripts/sync-dsh-port.mjs
// 退出码：0 = 已确认（可能未改动），1 = 没找到 DSH 端口（沿用原配置）

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = path.join(ROOT, 'config.json');
const PROCESS_NAMES = ['DeepSeek Harness.exe', 'DeepSeek Harness'];

function run(file, args) {
  try {
    return execFileSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  } catch {
    return '';
  }
}

function dshPids() {
  const pids = new Set();
  const csv = run('tasklist', ['/fo', 'csv', '/nh']);
  for (const line of csv.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cols = line.match(/"([^"]*)"/g)?.map((s) => s.slice(1, -1)) ?? [];
    if (cols.length < 2) continue;
    const [image, pid] = cols;
    if (PROCESS_NAMES.some((n) => n.toLowerCase() === String(image).toLowerCase())) {
      const n = Number(pid);
      if (Number.isInteger(n) && n > 0) pids.add(n);
    }
  }
  return pids;
}

function listeningPorts(pids) {
  const ports = [];
  const out = run('netstat', ['-ano', '-p', 'TCP']);
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
    if (!m) continue;
    const host = m[1];
    const port = Number(m[2]);
    const pid = Number(m[3]);
    if (!pids.has(pid)) continue;
    if (host !== '127.0.0.1' && host !== '[::1]') continue;
    ports.push({ port, pid });
  }
  return ports;
}

const pids = dshPids();
if (pids.size === 0) {
  console.error('[sync-dsh-port] 没有找到正在运行的 DSH（DeepSeek Harness.exe）');
  process.exit(1);
}

const ports = listeningPorts(pids);
if (ports.length === 0) {
  console.error(`[sync-dsh-port] DSH 进程在运行（pid ${[...pids].join(',')}），但没有找到 127.0.0.1 监听端口`);
  process.exit(1);
}

// 多个监听端口时优先 3080/8913，否则取最小端口号（通常是主 Web 服务）
ports.sort((a, b) => a.port - b.port);
const picked = ports.find((p) => p.port === 3080) ?? ports.find((p) => p.port === 8913) ?? ports[0];
const baseUrl = `http://127.0.0.1:${picked.port}`;

let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
} catch (error) {
  console.error(`[sync-dsh-port] config.json 读取/解析失败：${error.message}`);
  process.exit(1);
}

const old = String(cfg?.dsh?.baseUrl ?? '');
if (old === baseUrl) {
  console.log(`[sync-dsh-port] DSH 端口无需改动：${baseUrl}`);
  process.exit(0);
}

cfg.dsh = { ...(cfg.dsh ?? {}), baseUrl };
fs.writeFileSync(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
console.log(`[sync-dsh-port] dsh.baseUrl: ${old || '(空)'} -> ${baseUrl}`);
