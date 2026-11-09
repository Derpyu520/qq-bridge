#!/usr/bin/env node
// 只停止**本仓库**这一个 qq-bridge 实例，供 `npm run restart` / `npm run stop` 使用。
//
// 背景（真实缺陷）：旧 Windows 启动器在全机匹配 `*start.bat*` / `*bridge.js*` 后强制结束进程。
// 这会把其他仓库同名的启动器、桥接实例，甚至无关的 `bridge.js` 应用一起杀掉；锁文件里的
// PID 也没有验证是不是本项目的 node 进程。
//
// 本脚本的所有权证据只有两种：
//   ① `state/bridge.lock` 里的 PID —— 该进程必须是 node，且入口解析到本仓库 src/bridge.js；
//   ② 控制台端口（config.json 的 consolePort）的监听者 —— 必须与 ① 是同一个 PID。
// 任何一条对不上就**拒绝结束**并返回非零，而不是“猜一个最像的进程杀掉”。
//
// 纯决策函数 `planStop()` 不碰真实进程，回归见 scripts/tests/offline/test-restart-instance.mjs。
import fs from 'node:fs';
import path from 'node:path';
import { resolveConfigPath } from '../../src/util/config-path.js';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_CONSOLE_PORT = 3100;
const THIS_FILE = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = path.dirname(path.dirname(path.dirname(THIS_FILE)));

/** 粗粒度拆分 Windows 命令行（只用于判断 node 的脚本入口，不追求完整 CRT 语义）。 */
function commandTokens(commandLine) {
  return (String(commandLine ?? '').match(/"[^"]*"|\S+/g) ?? [])
    .map((token) => token.replace(/^"|"$/g, ''));
}

function nodeScript(commandLine) {
  const tokens = commandTokens(commandLine);
  // tokens[0] 是 node 可执行文件；选项（--inspect 等）之后第一个非选项参数才是脚本。
  return tokens.slice(1).find((token) => !token.startsWith('-')) ?? '';
}

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

/** 命令行里是否真的以 bridge.js 作为 node 的脚本入口（排除把 bridge.js 当参数/数据的情况）。 */
export function isBridgeCommandLine(commandLine) {
  return /(^|[\\/])bridge\.js$/i.test(nodeScript(commandLine));
}

export function isBridgeProcess(proc, root = DEFAULT_ROOT) {
  if (!proc) return false;
  const name = String(proc.name ?? '').toLowerCase();
  if (name !== 'node.exe' && name !== 'node') return false;
  const script = nodeScript(proc.commandLine);
  if (!/(^|[\\/])bridge\.js$/i.test(script) || !path.isAbsolute(script)) return false;
  return samePath(script, path.join(root, 'src', 'bridge.js'));
}

/**
 * 守护进程：
 *   · 新形态：node 跑着 `scripts/ops/bridge-launcher.mjs start|restart`；
 *   · 旧形态（兼容）：cmd.exe 跑着 `start.bat`（2026-11 移除的是 .bat，但老窗口
 *     可能还在跑，停止逻辑要能认出并一起收掉，否则它 5 秒后会把旧实例拉回来）。
 * 传入 root 时还必须是本项目的绝对路径启动器。
 */
export function isGuardProcess(proc, root) {
  if (!proc) return false;
  const name = String(proc.name ?? '').toLowerCase();
  const cmd = String(proc.commandLine ?? '');
  if (name === 'cmd.exe' || name === 'cmd') {
    if (/restart\.bat/i.test(cmd)) return false;
    const script = commandTokens(cmd).find((token) => /(^|[\\/])start\.bat$/i.test(token));
    if (!script || (root && !path.isAbsolute(script))) return false;
    return !root || samePath(script, path.join(root, 'start.bat'));
  }
  if (name !== 'node.exe' && name !== 'node') return false;
  const script = nodeScript(cmd);
  if (!/(^|[\\/])bridge-launcher\.mjs$/i.test(script) || !path.isAbsolute(script)) return false;
  if (root && !samePath(script, path.join(root, 'scripts', 'ops', 'bridge-launcher.mjs'))) return false;
  return /(^|\s)(start|restart)(\s|$)/.test(cmd);
}

/**
 * 纯决策：给出要执行的动作，不执行任何系统调用。
 *
 * @param {object} input
 * @param {number} input.port 控制台端口
 * @param {string} input.root 当前仓库根目录
 * @param {number|null} input.lockPid state/bridge.lock 里的 PID（空/非法为 null）
 * @param {Array<{pid:number,parentPid:number,name:string,commandLine:string}>} input.processes
 * @param {number|null} input.listenerPid 控制台端口的 LISTENING PID
 * @returns {{action:'none'|'cleanup'|'stop'|'abort', reason:string, ...}}
 */
export function planStop({ port, root = DEFAULT_ROOT, lockPid = null, processes = [], listenerPid = null, launcherPid = null }) {
  const lockProcess = lockPid == null ? null : processes.find((p) => p && p.pid === lockPid) ?? null;
  const verified = isBridgeProcess(lockProcess, root);

  // 端口是最强的“这里确实有一个实例”的证据。只要它不是锁里那个已验证的 PID，
  // 就说明要么是本项目实例但锁已丢失（无法证明归属），要么端口被别的程序占了 —— 两种都不该杀。
  if (listenerPid != null && (!verified || listenerPid !== lockPid)) {
    return {
      action: 'abort',
      reason: `控制台端口 ${port} 被 PID ${listenerPid} 监听，但它不是锁文件里已验证的 qq-bridge 进程`,
      port, lockPid, listenerPid
    };
  }

  if (verified) {
    const parent = processes.find((p) => p && p.pid === lockProcess.parentPid) ?? null;
    // launcherPid 来自启动器自己写的 state/bridge.launcher.json：npm 用相对路径
    // 启动时 commandLine 不是绝对路径，但父进程关系 + 落盘 PID 仍能证明归属。
    const guard = parent && (parent.pid === launcherPid || isGuardProcess(parent, root)) ? parent : null;
    return {
      action: 'stop',
      reason: guard
        ? `已验证 PID ${lockPid} 是本项目 bridge.js；连同其守护窗口 PID ${guard.pid} 的进程树一起停止`
        : `已验证 PID ${lockPid} 是本项目 bridge.js；只停止该进程`,
      port, lockPid, listenerPid,
      bridgePid: lockPid,
      guardPid: guard ? guard.pid : null,
      killPid: guard ? guard.pid : lockPid
    };
  }

  if (lockPid != null) {
    const detail = !lockProcess
      ? `PID ${lockPid} 已不存在`
      : `PID ${lockPid} 是 ${lockProcess.name || '未知进程'}，不是本项目的 bridge.js`;
    // 锁失效但全机还有启动器守护进程：无法证明它是不是本仓库的。
    // 这时删锁并发起新守护，可能和旧守护同时拉起 node（双实例抢消息/覆盖 state）。
    // 宁可中止并让用户重试，也不按名字猜一个窗口去杀 —— 那正是本脚本要修的误杀。
    const guard = processes.find((p) => p && launcherPid != null && p.pid === launcherPid)
      ?? processes.find((p) => isGuardProcess(p));
    if (guard) {
      return {
        action: 'abort',
        reason: `锁文件已过期（${detail}），但仍检测到启动器守护进程 PID ${guard.pid}，无法证明归属；请等它把实例拉起来后重试，或手动关闭旧窗口`,
        port, lockPid, listenerPid
      };
    }
    return {
      action: 'cleanup',
      reason: `锁文件已过期（${detail}）；不能也不会按这个 PID 杀进程，只清理失效锁`,
      port, lockPid, listenerPid
    };
  }

  return { action: 'none', reason: '未发现本项目的运行实例与锁文件', port, lockPid, listenerPid };
}

export function parseNetstatListenerPid(stdout, port) {
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    if (!/\bLISTENING\b/i.test(line)) continue;
    const cols = line.trim().split(/\s+/);
    const local = cols[1] ?? '';
    if (!local.endsWith(`:${port}`)) continue;
    const pid = Number(cols[cols.length - 1]);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
}

/** Windows PowerShell 5.1 兼容：逐行输出 pid|ppid|name|base64(CommandLine)，避免 ConvertTo-Json 单元素退化。 */
const PROCESS_QUERY = [
  "$ErrorActionPreference = 'Stop'",
  "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -or $_.Name -eq 'node' -or $_.Name -eq 'cmd.exe' -or $_.Name -eq 'cmd' } | ForEach-Object {",
  "  $cmd = [string]$_.CommandLine",
  "  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($cmd))",
  "  '{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.ParentProcessId, $_.Name, $b64",
  '}'
].join('\n');

function run(cmd, args) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 8 * 1024 * 1024,
    // ss 在无权限看别人进程时会往 stderr 打无害提示，别让它污染启动器/重启输出。
    stdio: ['ignore', 'pipe', 'ignore']
  });
}

export function listProcesses() {
  if (process.platform === 'win32') {
    const out = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PROCESS_QUERY]);
    const processes = [];
    for (const line of out.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [pidRaw, ppidRaw, name, b64] = line.split('|');
      const pid = Number(pidRaw);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      const commandLine = b64 ? Buffer.from(b64, 'base64').toString('utf8') : '';
      processes.push({ pid, parentPid: Number(ppidRaw) || 0, name: String(name ?? ''), commandLine });
    }
    return processes;
  }
  // POSIX：`ps -o comm` 在 Linux 上可能返回线程名（Node 实测是 "MainThread"），
  // 所以不用 comm，改从 args 的第一个 token 推可执行文件名。
  const out = run('ps', ['-A', '-o', 'pid=,ppid=,args=']);
  const processes = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const commandLine = m[3] ?? '';
    const first = commandLine.trim().split(/\s+/)[0]?.replace(/^"|"$/g, '') ?? '';
    processes.push({
      pid,
      parentPid: Number(m[2]) || 0,
      name: path.basename(first),
      commandLine
    });
  }
  return processes;
}

export function getListenerPid(port) {
  if (process.platform === 'win32') {
    const out = run('netstat', ['-ano', '-p', 'TCP']);
    return parseNetstatListenerPid(out, port);
  }
  // Linux/macOS：优先 ss（iproute2），再 lsof，最后 netstat；都拿不到就返回 null。
  try {
    const out = run('ss', ['-ltnp', `sport = :${port}`]);
    const m = /pid=(\d+)/.exec(out);
    if (m) return Number(m[1]);
  } catch {}
  try {
    const out = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
    const pid = Number(String(out).trim().split(/\s+/)[0]);
    if (Number.isInteger(pid) && pid > 0) return pid;
  } catch {}
  try {
    const out = run('netstat', ['-ltnp']);
    for (const line of String(out).split(/\r?\n/)) {
      if (!/\bLISTEN\b/.test(line)) continue;
      if (!new RegExp(`:${port}\\s`).test(line)) continue;
      const m = /\s(\d+)\/\S+\s*$/.exec(line);
      if (m) return Number(m[1]);
    }
  } catch {}
  return null;
}

export function readConsolePort(root) {
  try {
    const cfg = JSON.parse(fs.readFileSync(resolveConfigPath(root), 'utf8').replace(/^\uFEFF/, ''));
    const port = Number(cfg?.consolePort);
    if (Number.isInteger(port) && port > 0 && port < 65536) return port;
  } catch {}
  return DEFAULT_CONSOLE_PORT;
}

export function readLauncherPid(root) {
  try {
    const file = path.join(root, 'state', 'bridge.launcher.json');
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const pid = Number(j?.pid);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function readLockPid(lockFile) {
  try {
    const raw = fs.readFileSync(lockFile, 'utf8').trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

async function killTree(pid) {
  if (process.platform !== 'win32') {
    try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
    // 给启动器/桥接一点时间优雅退出；还不走就 SIGKILL。
    for (let i = 0; i < 30 && pidAlive(pid); i += 1) await new Promise((r) => setTimeout(r, 100));
    if (pidAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    return;
  }
  try {
    run('taskkill', ['/PID', String(pid), '/T', '/F']);
  } catch (error) {
    // 进程已经退出时 taskkill 会返回非零；是否成功由后面的存活探测判定。
    if (pidAlive(pid)) throw error;
  }
}

/** 只有锁文件仍是 **这个** PID 时才删除，避免误删新实例刚写入的锁。 */
function removeLockIfOwner(lockFile, pid) {
  if (readLockPid(lockFile) !== pid) return false;
  try { fs.unlinkSync(lockFile); return true; } catch { return false; }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntilStopped(pid, port, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let alive = false;
    try { alive = pidAlive(pid); } catch {}
    let busy = null;
    try { busy = getListenerPid(port); } catch { busy = 'unknown'; }
    if (!alive && busy === null) return { ok: true };
    if (Date.now() >= deadline) return { ok: false, alive, busy };
    await sleep(250);
  }
}

function printPlan(plan) {
  console.log(`[stop-bridge] ${plan.reason}`);
  console.log(JSON.stringify(plan, null, 2));
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('用法: node scripts/ops/stop-bridge-instance.mjs [--dry-run] [--root <仓库目录>]');
    return 0;
  }
  const dryRun = argv.includes('--dry-run');
  const rootIndex = argv.indexOf('--root');
  const root = path.resolve(
    rootIndex >= 0 && argv[rootIndex + 1]
      ? argv[rootIndex + 1].replace(/[\\/]+$/, '')
      : path.dirname(path.dirname(path.dirname(THIS_FILE)))
  );
  const lockFile = path.join(root, 'state', 'bridge.lock');
  const port = readConsolePort(root);
  const lockPid = readLockPid(lockFile);
  const launcherPid = readLauncherPid(root);

  let processes;
  let listenerPid;
  try {
    processes = listProcesses();
    listenerPid = getListenerPid(port);
  } catch (error) {
    console.error(`[stop-bridge] 无法枚举进程/端口，拒绝在信息不完整时结束任何进程：${error?.message ?? error}`);
    console.error('[stop-bridge] 请在普通终端（非受限沙箱）重跑 npm run restart。');
    return 1;
  }

  const plan = planStop({ port, root, lockPid, processes, listenerPid, launcherPid });
  printPlan(plan);

  if (dryRun) {
    console.log('[stop-bridge] --dry-run：未执行任何停止/删除操作。');
    return 0;
  }

  if (plan.action === 'abort') {
    console.error('[stop-bridge] 已中止：不结束未经验证的进程。');
    return 1;
  }

  if (plan.action === 'stop') {
    await killTree(plan.killPid);
    const stopped = await waitUntilStopped(plan.bridgePid, port);
    if (!stopped.ok) {
      console.error(`[stop-bridge] 停止失败：PID ${plan.bridgePid} 仍然存活或端口 ${port} 仍被监听（alive=${stopped.alive}, listener=${stopped.busy}）。`);
      return 1;
    }
    // 停掉旧实例的瞬间，别的守护可能已经拉起新实例并改写锁；此时不能再启动第二个守护。
    const replacementPid = readLockPid(lockFile);
    if (replacementPid != null && replacementPid !== plan.bridgePid) {
      console.error(`[stop-bridge] 旧实例已停止，但锁文件已被新实例 PID ${replacementPid} 接管；为避免双实例，已中止本次重启。`);
      return 1;
    }
    removeLockIfOwner(lockFile, plan.bridgePid);
    if (plan.guardPid != null && !pidAlive(plan.guardPid)) {
      try { fs.unlinkSync(path.join(root, 'state', 'bridge.launcher.json')); } catch {}
    }
    console.log(`[stop-bridge] 已停止本项目的 bridge（PID ${plan.bridgePid}${plan.guardPid ? `，守护窗口 PID ${plan.guardPid}` : ''}）。`);
    return 0;
  }

  // cleanup / none：没有可验证的活实例。端口已在 planStop 里确认空闲，清理失效锁是安全的。
  if (lockPid != null && removeLockIfOwner(lockFile, lockPid)) {
    console.log(`[stop-bridge] 已清理失效锁（PID ${lockPid}）。`);
  }
  return 0;
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(THIS_FILE)) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.error(`[stop-bridge] 未预期错误：${error?.stack ?? error}`);
    process.exitCode = 1;
  });
}
