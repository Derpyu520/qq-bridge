// state/ 目录权限收紧的「可提权」入口。
//
// 为什么需要单独一个文件：
//   Windows 上收紧 ACL 需要对该目录有 WRITE_DAC。**正常情况下目录属主本来就有**，
//   所以这个脚本只是"设一次就走"，不会每次启动都弹 UAC；只有当系统策略把属主权限也收走、
//   或目录属于别的账户时，才会用 Start-Process -Verb RunAs 提权重试一次。
//
// 设计原则（必须是"零 bug 风险"的那种实用主义）：
//   1) 失败即降级：拿不到权限就打印一条可复制的命令然后**以 0 退出**，绝不阻断桥接启动。
//   2) 不消费参数：桥接进程是 `node src/bridge.js`，这里绝不能碰 process.argv 的语义。
//   3) 输出给人看：中文、直白、给出下一步。
//
// ⚠️ 具体的 icacls 逻辑**不在本文件**，而是与桥接进程共用 `src/util/state-acl.js`。
// 这套逻辑曾经在这里和 src/bridge.js 里各写一份，两份带着同一个 bug：
// `icacls DIR /inheritance:r /grant:r "u:(OI)(CI)F" /T` 会把子文件 DACL 清空
// （(OI)(CI) 是目录专用标志，套到文件上失败，而 /inheritance:r 已经摘掉了继承 ACE），
// 加上回读自检被 Low 完整性标签行的 (I) 误判，导致**每次启动都重跑一次这个破坏性命令**。
// 合并成一份，从结构上杜绝再次漂移。
//
// 用法：node scripts/ops/harden-state-acl.mjs [--quiet]
//   --quiet 时只在真正做了事情/失败时输出（bridge-launcher 在 Windows 上用这个模式）。

import fs from 'node:fs';
import path from 'node:path';
import { resolveConfigPath } from '../../src/util/config-path.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hardenDir, hardenFile, isHardened, manualDirCommand } from '../../src/util/state-acl.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const STATE_DIR = path.join(ROOT, 'state');
const quiet = process.argv.includes('--quiet');
// 被自己提权拉起时不带 --quiet（子进程用的是 --elevated --quiet），带上这个标记可以
// 让提权后的这一次**不再尝试提权**，从结构上杜绝递归。
const isElevatedRun = process.argv.includes('--elevated');

function say(msg) { if (!quiet) console.log(msg); }
function sayAlways(msg) { console.log(msg); }

// state/ 之外的凭据文件：config.json 里是真实的 SnowLuma OneBot accessToken ——
// 拿到它等于拿到 QQ 账号的收发控制权。它跟 state/ 一样在仓库树里，继承来的 ACE 同样
// 对 BUILTIN\Users 可读，所以一并收紧。
// config/ 新布局与根目录旧布局都收：resolver 返回当前实际生效的那份。
const SECRET_FILES = [resolveConfigPath(ROOT)].filter((file) => fs.existsSync(file));

/** 用 UAC 提权跑一次自己，然后回读确认。返回 { ok, detail }。 */
function elevateAndRetry() {
  if (process.platform !== 'win32') return { ok: false, detail: '非 Windows 平台不需要提权' };
  const script = fileURLToPath(import.meta.url);
  // -Wait 让父进程等到子进程结束；用户点"否"时 Start-Process 会抛错，这里要吞掉。
  //
  // 路径经**环境变量**传入，不拼进 -Command 字符串：Node 安装路径或脚本路径里只要
  // 有一个双引号，字符串拼接就会被写出引号边界；反引号或 $(...) 更会直接在
  // **提权后**的 PowerShell 里执行。环境变量由 PowerShell 当普通字符串读取，
  // 从构造上消除了转义/注入面。
  const ps = [
    '$ErrorActionPreference = "Stop";',
    'try {',
    '  Start-Process -FilePath $env:DSH_HARDEN_NODE -ArgumentList @($env:DSH_HARDEN_SCRIPT,"--elevated","--quiet") -Verb RunAs -Wait -WindowStyle Hidden;',
    '  exit 0',
    '} catch { exit 2 }'
  ].join(' ');
  const res = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
    env: { ...process.env, DSH_HARDEN_NODE: process.execPath, DSH_HARDEN_SCRIPT: script }
  });
  if (res.error) return { ok: false, detail: `无法启动提权进程：${res.error.message}` };
  if (res.status === 2) return { ok: false, detail: '用户取消了 UAC 提权' };
  if (isHardened(STATE_DIR)) return { ok: true, detail: '提权后已收紧' };
  return { ok: false, detail: res.status === 0 ? '提权进程结束但权限仍未收紧' : `提权进程退出码 ${res.status}` };
}

/** 收紧凭据文件；返回仍未收紧的个数。 */
function hardenSecretFiles() {
  let stillOpen = 0;
  for (const file of SECRET_FILES) {
    const label = path.relative(ROOT, file);
    if (isHardened(file)) { say(`[harden-acl] ${label} 权限已收紧，无需处理`); continue; }
    const result = hardenFile(file);
    if (result.ok) sayAlways(`[harden-acl] ✅ 已收紧 ${label} 权限（只保留当前用户 / SYSTEM / Administrators）。`);
    else { stillOpen += 1; sayAlways(`[harden-acl] ⚠️ 未能收紧 ${label}（${result.detail}）。`); }
  }
  return stillOpen;
}

// 凭据文件放在所有 state/ 分支之前：这样即使 state/ 已经收紧、脚本原本会提前 exit，
// 它们也一定会被收一遍。
hardenSecretFiles();

if (!fs.existsSync(STATE_DIR)) {
  say(`[harden-acl] state/ 还不存在（首次启动时桥接会创建并自行收紧）：${STATE_DIR}`);
  process.exit(0);
}

if (isHardened(STATE_DIR)) {
  say(`[harden-acl] state/ 权限已收紧，无需处理：${STATE_DIR}`);
  process.exit(0);
}

sayAlways('[harden-acl] state/ 权限未收紧：其中的控制台令牌、SnowLuma 令牌、各会话令牌与 QQ 聊天记录，本机任何已登录用户都可能读到。');
sayAlways(`[harden-acl] 正在尝试收紧：${STATE_DIR}`);

let result = hardenDir(STATE_DIR);
if (!result.ok && !isElevatedRun) {
  sayAlways(`[harden-acl] 直接收紧失败（${result.detail}），改用管理员权限重试（会弹出 UAC 确认框）…`);
  result = elevateAndRetry();
}

if (result.ok) {
  sayAlways('[harden-acl] ✅ 已收紧 state/ 权限（只保留当前用户 / SYSTEM / Administrators）。');
  process.exit(0);
}

// 失败是**可接受**的：桥接照常启动，只是在控制台「访问与安全」页会显示告警。
sayAlways(`[harden-acl] ⚠️ 未能收紧（${result.detail}）。桥接仍会正常启动，但这台机器上的其他登录用户可能读到 state/ 里的令牌与聊天记录。`);
sayAlways('[harden-acl] 你可以手动执行下面这几条命令（管理员终端，一次即可）：');
sayAlways(`             ${manualDirCommand(STATE_DIR)}`);
process.exit(0);
