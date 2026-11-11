// 诊断：仓库里哪些路径的 ACL 被**切断了继承**，因而在 DSH 沙箱会话里不可写。
//
// 为什么需要它
// ------------
// DSH 的 Windows 文件沙箱按**能力 SID**（形如 `S-1-4-…`）授权：工作区根目录上挂一条
// 可继承的 ACE，子路径靠**继承**拿到它。所以只要某个目录/文件被 `/inheritance:r`
// 切断了继承链，沙箱进程就没有写权限 —— 表现为 EPERM / "Access to the path … is denied"，
// 而从 `danger-full-access` 会话（或无沙箱的普通终端）跑同样的操作却完全正常。
//
// 本项目**故意**对 `state/` 与 `config.json` 这么做（见 src/util/state-acl.mjs：
// state/ 里有控制台令牌、SnowLuma OneBot 令牌与全部 QQ 聊天记录）。这是有意的安全取舍，
// 不是 bug —— 但它有个必须知道的副作用：
//
//   ⚠️ **在 DSH 沙箱会话里，任何写 `state/` 的操作都会被系统拒绝。**
//      包括本项目自己的测试夹具、探针、self-test。
//      因此那些脚本的临时产物一律落在系统临时目录（见 scripts/probes/probe-auth.mjs 的说明），
//      而不是仓库的 state/。
//
// 除 state/ 与 config.json 之外的路径**不应该**被切断继承。若本脚本报出别的路径，
// 说明有仓库外的动作（手工 icacls、别的工具）动过它们 —— 它们会让沙箱里的
// 正常开发/调试工作无理由失败。
//
// 用法：
//   node scripts/ops/diagnose-acl.mjs            # 只报告
//   node scripts/ops/diagnose-acl.mjs --strict   # 发现"非预期"的收紧路径时以 1 退出（可进 CI）
//
// 本脚本**只读**，不修改任何权限；修复命令只打印，由你自己决定要不要执行。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { icacls, hasInheritedPermissionAce } from '../../src/util/state-acl.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STRICT = process.argv.includes('--strict');
const SKIP_DIRS = new Set(['node_modules', '.git', '.npm-cache']);

/** 项目**有意**收紧的路径（前缀匹配，相对仓库根的 posix 风格路径）。 */
const INTENTIONAL = ['state', 'config.json', 'work/config.json', 'config/config.json'];

if (process.platform !== 'win32') {
  console.log('[diagnose-acl] 非 Windows：DSH 的 ACL 沙箱不适用，无需诊断。');
  process.exit(0);
}

/** 路径是否被切断了继承（= 拿不到工作区根上那条可继承的能力 SID ACE）。 */
function aclOf(target) {
  const res = icacls([target], 10000);
  if (res.error) return { error: res.error };
  if (res.status !== 0) return { error: new Error(`icacls 退出码 ${res.status}`) };
  return { out: res.stdout ?? '' };
}

function isSevered(target) {
  const { out, error } = aclOf(target);
  if (error) return { unknown: error };
  // hasInheritedPermissionAce 会排除 Mandatory Label 行 —— DSH 沙箱把工作区标成
  // Low 完整性，那一行**永远**带 (I)，不排除就会把"已收紧"全判成"未收紧"。
  return { severed: !hasInheritedPermissionAce(out) };
}

/** 输出里是否出现能力 SID（形如 S-1-4-…），用于说明"这条路径自己带着写权限"。 */
function hasCapabilitySid(target) {
  return /S-1-4-/.test(aclOf(target).out ?? '');
}

const severed = [];
const unreadable = [];
let spawnBlocked = false;
const walk = (dir, rel = '') => {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    const st = isSevered(abs);
    if (st.unknown) {
      // 沙箱禁止以管道 stdio 拉起子进程 ⇒ icacls 直接 EPERM。
      // 这不是"路径有问题"，而是**本脚本必须在无沙箱终端里跑**。
      if (st.unknown.code === 'EPERM') spawnBlocked = true;
      unreadable.push(r);
      continue;
    }
    if (st.severed) severed.push({ rel: r, abs, isDir: e.isDirectory(), cap: hasCapabilitySid(abs) });
    if (e.isDirectory()) walk(abs, r);
  }
};

// 工作区根自己必须是"继承正常"的，否则说明整个工作区都没拿到能力 SID，
// 那是另一个问题（DSH 进入工作区时应当授予它）。
const rootState = isSevered(ROOT);
if (rootState.unknown?.code === 'EPERM') spawnBlocked = true;
console.log(`[diagnose-acl] 仓库根：${ROOT}`);

if (spawnBlocked) {
  console.log('[diagnose-acl] ⛔ 本进程无法以管道 stdio 拉起 icacls（EPERM）——');
  console.log('   DSH 的文件沙箱禁止沙箱子进程捕获其它程序的输出管道。');
  console.log('   这个诊断必须**在无沙箱的普通终端**里运行（或在 DSH 里用 danger-full-access 会话）。');
  console.log('   注意这与 DSH 的 ACL 沙箱是两件事：这里失败的是「读 ACL」，不是「写文件被拒」。');
  process.exit(2);
}

console.log(`[diagnose-acl] 仓库根自身带能力 SID：${hasCapabilitySid(ROOT) ? '是' : '否'}`);
if (rootState.severed) {
  console.log('[diagnose-acl] ⚠️ 仓库根就被切断了继承：整棵树的子路径都拿不到沙箱写权限。');
}

walk(ROOT);

const isIntentional = (rel) =>
  INTENTIONAL.some((p) => rel === p || rel.startsWith(`${p}/`));

const expected = severed.filter((s) => isIntentional(s.rel));
const unexpected = severed.filter((s) => !isIntentional(s.rel));

console.log(`\n=== 有意收紧（预期内） ===`);
console.log(`共 ${expected.length} 项。${expected.length ? '来源：src/util/state-acl.mjs 的 hardenDir/hardenFile（state/ 与 config.json）。' : ''}`);
for (const s of expected.slice(0, 6)) console.log(`  ${s.rel}${s.isDir ? '/' : ''}`);
if (expected.length > 6) console.log(`  … 其余 ${expected.length - 6} 项`);
if (expected.length) {
  console.log('  ⇒ 在 DSH 沙箱会话里写这些路径会被拒绝。这是有意的安全取舍；');
  console.log('     本项目的测试夹具/探针据此一律改用系统临时目录。');
  console.log('');
  console.log('  ⛔ **不要**对这些路径执行 /inheritance:e 来"修好"沙箱写入：');
  console.log('     恢复继承会把父目录的可继承 ACE 一起带回来，其中包含');
  console.log('       NT AUTHORITY\\Authenticated Users : Modify');
  console.log('       BUILTIN\\Users                    : ReadAndExecute');
  console.log('     那正是 harden-state-acl.mjs 专门去掉的两条 —— 等于把控制台令牌、');
  console.log('     SnowLuma OneBot 令牌与全部 QQ 聊天记录重新开放给本机任何已登录用户。');
  console.log('     `state/` 与 `config.json` 的正确姿态就是「保持收紧 + 不要从沙箱里写它」。');
}

console.log(`\n=== 非预期收紧（应处理） ===`);
if (unexpected.length === 0) {
  console.log('  (无)');
} else {
  for (const s of unexpected) console.log(`  ${s.rel}${s.isDir ? '/' : ''}`);
  console.log('\n  这些路径不是本仓库任何脚本收紧的，会让沙箱会话里的正常开发/调试无理由失败。');
  console.log('  修复（恢复继承，不动任何数据；管理员或属主终端均可）：');
  const dirs = new Set();
  for (const s of unexpected) dirs.add(s.isDir ? s.abs : path.dirname(s.abs));
  for (const d of dirs) console.log(`    icacls "${d}" /inheritance:e /C /Q`);
  console.log('  说明：/inheritance:e 会从父目录重新继承那条能力 SID ACE；');
  console.log('        它不会放宽对外部用户的可见性到超出工作区原有的程度。');
}

if (unreadable.length) {
  console.log(`\n=== ACL 读取失败（${unreadable.length} 项，已跳过） ===`);
  for (const r of unreadable.slice(0, 8)) console.log(`  ${r}`);
  if (unreadable.length > 8) console.log(`  … 其余 ${unreadable.length - 8} 项`);
}

console.log(`\n[diagnose-acl] 收紧路径合计 ${severed.length} 项（有意 ${expected.length} / 非预期 ${unexpected.length}）。`);
process.exitCode = STRICT && unexpected.length > 0 ? 1 : 0;
