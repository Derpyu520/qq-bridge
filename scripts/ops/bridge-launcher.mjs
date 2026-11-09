#!/usr/bin/env node
// 跨平台桥接启动器（替代 start.bat / restart.bat）。
//
//   npm start            守护循环：桥接崩溃自动重启（等价旧 start.bat）
//   npm run restart      先验证停止本仓库实例，再进入守护循环（等价旧 restart.bat）
//   npm run start:once   只跑一次，不做守护（旧 npm start 行为）
//   npm run stop         只执行验证式停止（等价 restart.bat 的停止部分）
//
// Windows / Linux 差异：
//   · Windows 启动前调用 harden-state-acl（收紧 state/ 的 ACL，保护令牌与聊天记录），
//     非 Windows 平台跳过（DSH 沙箱/文件权限不依赖 ACL）；
//   · 信号：Ctrl+C 时先转发给子进程，再退出，不触发「5 秒后自动重启」；
//   · 桥接以退出码 2 退出表示「已有实例在运行」，启动器不重启、直接退出 2。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BRIDGE = path.join(ROOT, 'src', 'bridge.js');
const STOP = path.join(ROOT, 'scripts', 'ops', 'stop-bridge-instance.mjs');
const HARDEN = path.join(ROOT, 'scripts', 'ops', 'harden-state-acl.mjs');
const RESTART_DELAY_MS = 5000;
// 守护进程的 PID 落盘：stop-bridge-instance 用它把「父进程」证明成启动器，
// 即使 npm 用相对路径启动（`node scripts/ops/bridge-launcher.mjs`）也能收掉整棵树。
const STATE_DIR = path.join(ROOT, 'state');
const GUARD_FILE = path.join(STATE_DIR, 'bridge.launcher.json');
const SELF = fileURLToPath(import.meta.url);

function writeGuardFile() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(GUARD_FILE, `${JSON.stringify({ pid: process.pid, script: SELF, startedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
  } catch (error) {
    console.error(`[launcher] 写守护 PID 文件失败：${error?.message ?? error}（stop 可能只能停 bridge）`);
  }
}

function clearGuardFile() {
  try {
    const current = JSON.parse(fs.readFileSync(GUARD_FILE, 'utf8'));
    if (current?.pid === process.pid) fs.unlinkSync(GUARD_FILE);
  } catch {}
}
process.on('exit', clearGuardFile);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const platform = process.platform === 'win32' ? 'Windows' : process.platform;
let child = null;
let stopping = false;

function onSignal(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[launcher] 收到 ${signal}，正在停止桥接…`);
  try { child?.kill(signal); } catch {}
  // 子进程卡住时别让启动器一直挂着。
  setTimeout(() => process.exit(0), 3000).unref();
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => onSignal(signal));

function hardenAclOnWindows() {
  if (process.platform !== 'win32') {
    console.log(`[launcher] 平台 ${platform}：跳过 Windows ACL 收紧（由文件权限/沙箱负责）。`);
    return;
  }
  console.log('[launcher] Windows：先收紧 state/ 的 ACL…');
  const result = spawnSync(process.execPath, [HARDEN, '--quiet'], { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`[launcher] ACL 收紧助手退出码 ${result.status}；按设计不阻断启动，继续。`);
  }
}

function stopOldInstance() {
  console.log('[launcher] 验证并停止本仓库的旧实例…');
  const result = spawnSync(process.execPath, [STOP], { cwd: ROOT, stdio: 'inherit' });
  return result.status === 0;
}

function runOnce() {
  return new Promise((resolve) => {
    child = spawn(process.execPath, [BRIDGE], { cwd: ROOT, stdio: 'inherit' });
    child.once('error', (error) => {
      console.error(`[launcher] 无法启动桥接：${error?.message ?? error}`);
      child = null;
      resolve(-1);
    });
    child.once('close', (code) => {
      child = null;
      resolve(code ?? 1);
    });
  });
}

async function main() {
  const mode = process.argv[2] || 'start';
  if (!['start', 'restart'].includes(mode)) {
    console.error(`用法：node ${path.relative(ROOT, fileURLToPath(import.meta.url))} <start|restart>`);
    process.exit(2);
  }
  if (mode === 'restart' && !stopOldInstance()) {
    console.error('[launcher] 无法证明/停止旧实例，已中止重启（不会盲目按进程名杀进程）。');
    process.exit(1);
  }
  hardenAclOnWindows();
  writeGuardFile();
  console.log(`[launcher] 平台 ${platform}，启动桥接（${path.relative(ROOT, BRIDGE)}）…`);
  for (;;) {
    const code = await runOnce();
    if (stopping) process.exit(typeof code === 'number' ? code : 0);
    if (code === 2) {
      console.log('[launcher] 已有桥接实例在运行（退出码 2），不再重启。');
      process.exit(2);
    }
    console.log(`[launcher] 桥接退出（退出码 ${code}），${RESTART_DELAY_MS / 1000} 秒后自动重启…（Ctrl+C 取消）`);
    await sleep(RESTART_DELAY_MS);
    if (stopping) process.exit(0);
  }
}

await main();
