// state/ 目录 ACL 收紧的**唯一实现**。
//
// 为什么单独成模块：这套逻辑原本在桥接进程（`src/bridge.js` 的 hardenStateDirAcl）和
// 安装脚本（`scripts/harden-state-acl.mjs`）里各写了一份，两份带着**同一个** bug：
//
//   icacls DIR /inheritance:r /grant:r "u:(OI)(CI)F" /grant:r ... /T /C
//
// `(OI)(CI)` 是**目录专用**的继承标志。icacls 把它套到 `/T` 展开出来的**文件**上会失败，
// 而同一句里的 `/inheritance:r` 已经把文件原有的继承 ACE 摘掉了 —— 净结果是**子文件
// DACL 被清空，连属主自己都读不了**。实测后果：state/ 下 50 个子文件变成空 DACL，
// 桥接读不到自己的控制台令牌（"Access to the path ... is denied"），而启动日志只报
// 「未能收紧权限」，完全看不出已经造成了破坏。
//
// 第二个 bug 让第一个 bug 反复发生：回读自检用 `/\(I\)/.test(整段输出)` 判断「继承链是否
// 断干净」。但 DSH 的 ACL 沙箱会把工作区（含 state/）标记为 Low 完整性，而
// `Mandatory Label\Low Mandatory Level:(I)(OI)(CI)(NW)` 这一行**永远**带 (I) ——
// 于是「已收紧」被误判成「未收紧」，**每次启动都重跑一遍那个破坏性命令**。
//
// 合并成一份实现，从结构上杜绝两份逻辑再次漂移。
//
// 正确顺序：先为每个条目补显式授权，再断继承并补目录的可继承授权，
// 最后按 SID 删除宽松主体。任何时候都不能先清空仅靠继承得到的 DACL。
// 最后自检由调用方按需做（{@link isHardened}）。

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

// Authenticated Users=S-1-5-11, BUILTIN\Users=S-1-5-32-545, Everyone=S-1-1-0
const PERMISSIVE_SIDS = ['*S-1-5-11', '*S-1-5-32-545', '*S-1-1-0'];

/** icacls 的可执行封装（统一超时与隐藏窗口）。 */
export function icacls(args, timeout = 30000) {
  return spawnSync('icacls', args, { encoding: 'utf8', timeout, windowsHide: true });
}

/**
 * icacls 输出里是否还有**继承来的权限** ACE。
 *
 * 必须排除 Mandatory Label 行：那不是权限，而且 DSH 沙箱打过 Low 标签后它永远带 (I)。
 * 用全文 `/\(I\)/` 扫描会把「已收紧」判成「未收紧」，进而让调用方反复重跑破坏性命令。
 */
export function hasInheritedPermissionAce(icaclsOutput) {
  return String(icaclsOutput ?? '')
    .split(/\r?\n/)
    .filter((line) => !/Mandatory Label/i.test(line))
    .some((line) => /\(I\)/.test(line));
}

/** 是否还有本机任意用户可读的宽松主体授权。 */
export function hasPermissiveTrustee(icaclsOutput) {
  return /Authenticated Users|BUILTIN\\Users|\bEveryone\b|\bS-1-5-11\b|\bS-1-5-32-545\b|\bS-1-1-0\b/i.test(String(icaclsOutput ?? ''));
}

/** 空 DACL/仅完整性标签不属于「已收紧」：至少要存在一条实际 allow 权限。 */
export function hasPermissionGrant(icaclsOutput) {
  return String(icaclsOutput ?? '').split(/\r?\n/).some((line) => {
    if (/Mandatory Label|\(DENY\)/i.test(line)) return false;
    // 必须是 trustee 冒号后的 ACE，路径名里的「(F)」不是授权。
    const ace = /:((?:\((?:I|OI|CI|IO|NP)\))*)\((?:F|M|RX|R|W|D|RC|WDAC|WO|RD|WD|AD|REA|WEA|X|DC|RA|WA)(?:,[A-Z]+)*\)/.exec(line);
    // (IO) 只对子项生效，不能证明当前目录/文件自己仍有可用权限。
    return ace !== null && !ace[1].includes('(IO)');
  });
}

function icaclsFailure(res) {
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  if (res.error) return res.error.message;
  if (res.status !== 0) return `icacls 退出码 ${res.status}：${out.trim()}`;
  // 修改命令不使用 /C：遇错立即停止，主要依靠与系统语言无关的退出码判定。
  // 失败汇总和常见本地化错误仅作为额外兜底。
  if (/access is denied|拒绝访问|拒絕存取|Failed processing\s+[1-9]\d*\s+files|处理\s*[1-9]\d*\s*个文件(?:时)?失败/i.test(out)) {
    return out.split('\n').filter(Boolean).slice(-3).join(' / ');
  }
  return '';
}

function verifyAcl(target, { hardened = false } = {}) {
  const res = icacls([target], 10000);
  const failure = icaclsFailure(res);
  if (failure) return { ok: false, detail: failure };
  const out = res.stdout ?? '';
  if (!hasPermissionGrant(out)) return { ok: false, detail: 'ACL 中没有可用的显式或继承授权，拒绝继续修改' };
  if (hardened && (hasInheritedPermissionAce(out) || hasPermissiveTrustee(out))) {
    return { ok: false, detail: 'ACL 回读仍有继承权限或宽松主体，未确认收紧成功' };
  }
  return { ok: true, detail: 'icacls' };
}

/**
 * 目标路径的权限是否已收紧：既没有继承来的权限 ACE，也没有宽松主体。
 * @param {string} target - 目录或文件路径。
 */
export function isHardened(target) {
  if (process.platform !== 'win32') {
    try { return (fs.statSync(target).mode & 0o077) === 0; } catch { return false; }
  }
  return verifyAcl(target, { hardened: true }).ok;
}

/**
 * 收紧一个**目录**及其整棵子树的权限。
 * @param {string} dir - 目标目录。
 * @returns {{ok: boolean, detail: string}}
 */
export function hardenDir(dir) {
  if (process.platform !== 'win32') {
    try { fs.chmodSync(dir, 0o700); return { ok: true, detail: 'chmod 700' }; }
    catch (error) { return { ok: false, detail: error?.message ?? String(error) }; }
  }
  const user = process.env.USERNAME;
  if (!user) return { ok: false, detail: '无法确定当前用户名（%USERNAME% 为空）' };
  const steps = [
    [dir, '/T', '/Q', '/grant', `${user}:F`, '/grant', '*S-1-5-18:F', '/grant', '*S-1-5-32-544:F'],
    [dir, '/inheritance:r', '/Q', '/grant', `${user}:(OI)(CI)F`, '/grant', '*S-1-5-18:(OI)(CI)F', '/grant', '*S-1-5-32-544:(OI)(CI)F'],
    [dir, '/remove:g', ...PERMISSIVE_SIDS, '/T', '/Q']
  ];
  for (const [index, args] of steps.entries()) {
    const res = icacls(args);
    const failure = icaclsFailure(res);
    if (failure) return { ok: false, detail: failure };
    const verified = verifyAcl(dir, { hardened: index === steps.length - 1 });
    if (!verified.ok) return verified;
  }
  // 自检：属主必须仍能读到目录内容（防止把 DACL 清空这种"成功"的破坏）。
  try { fs.readdirSync(dir); }
  catch (error) { return { ok: false, detail: `收紧后目录已不可读，请检查 ACL（${error?.message ?? error}）` }; }
  return { ok: true, detail: 'icacls' };
}

/**
 * 收紧一个**文件**的权限（凭据文件用；文件不能带 (OI)(CI)）。
 * @param {string} file - 目标文件。
 * @returns {{ok: boolean, detail: string}}
 */
export function hardenFile(file) {
  if (process.platform !== 'win32') {
    try { fs.chmodSync(file, 0o600); return { ok: true, detail: 'chmod 600' }; }
    catch (error) { return { ok: false, detail: error?.message ?? String(error) }; }
  }
  const user = process.env.USERNAME;
  if (!user) return { ok: false, detail: '无法确定当前用户名（%USERNAME% 为空）' };
  const grants = ['/grant:r', `${user}:F`, '/grant:r', '*S-1-5-18:F', '/grant:r', '*S-1-5-32-544:F'];
  const steps = [
    [file, ...grants, '/Q'],
    [file, '/inheritance:r', ...grants, '/Q'],
    [file, '/remove:g', ...PERMISSIVE_SIDS, '/Q']
  ];
  for (const [index, args] of steps.entries()) {
    const failure = icaclsFailure(icacls(args));
    if (failure) return { ok: false, detail: failure };
    const verified = verifyAcl(file, { hardened: index === steps.length - 1 });
    if (!verified.ok) return verified;
  }
  return { ok: true, detail: 'icacls' };
}

/**
 * 给人看的手动收紧命令（失败降级时打印）。
 *
 * 必须是**安全**的那一版：把 (OI)(CI) 授权和 /T 混在同一句里会把子文件 DACL 清空。
 */
export function manualDirCommand(dir) {
  if (process.platform !== 'win32') return `chmod -R go-rwx "${dir}"`;
  const d = `"${dir}"`;
  return [
    `icacls ${d} /T /Q /grant "%USERNAME%:F" /grant "*S-1-5-18:F" /grant "*S-1-5-32-544:F"`,
    `icacls ${d} /inheritance:r /Q /grant "%USERNAME%:(OI)(CI)F" /grant "*S-1-5-18:(OI)(CI)F" /grant "*S-1-5-32-544:(OI)(CI)F"`,
    `icacls ${d} /remove:g "*S-1-5-11" "*S-1-5-32-545" "*S-1-1-0" /T /Q`
  ].join('\n             ');
}
