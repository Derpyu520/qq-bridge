// QQ 桥接 agent 的工具护栏（host 插件，挂在 qq-chat-tools preset 上）。
//
// 为什么需要它：DSH 0.2 的沙盒只有**写**边界（workspace-write 把写限制在会话 cwd），
// 读是全放行的（fs-sandbox："Reads pass through untouched: every mode permits reading"，
// bash 的 bwrap 是 `--ro-bind / /`），也**没有**命令级护栏。群聊一旦挂上本地工具，
// 群友就能让 agent 读本机任意文件；`rm -r` 之类命令虽然写不出工作区，但仍能在工作区
// 里造成破坏。这个插件补两件事：
//
//   1. denyRead —— 指定路径/目录（含其子树）不可读写：`read`/`read_image`/`write`/
//      `edit` 直接拒；`glob`/`grep` 拒搜索根、也拒会遍历到排除目录的祖先根；
//   2. denyExec —— 拒绝危险命令（默认含 `rm -r`/`sudo`/`dd of=`/`mkfs`/fork bomb 等）。
//
// 能力边界（必须说清楚，别把它当沙盒）：
//   · fs 工具的路径检查是**可靠的**：参数是结构化的，我们按规范化路径 + realpath 比对；
//   · bash 的读写检查是**字符串级尽力而为**：`python -c`、变量拼接、base64 等都能绕过；
//   · 真正的写边界仍是 DSH 的 workspace-write（bwrap/landlock），这个插件不是替代品。
//
// 配置读取：<repo>/config.json 的 `agentGuard` 段，按 mtime 缓存，改完无需重启 DSH。
//   {
//     "agentGuard": {
//       "enabled": true,
//       "denyRead": ["~/.ssh", "~/.dsh/.credentials.yaml", "<绝对或相对仓库根的路径>"],
//       "denyExec": ["\\brm\\s+-[^\\s]*[rR]"]
//     }
//   }
//   · 不写 `denyRead` ⇒ 用内置默认列表；写了就**完全替换**默认（行为可预测，不藏东西）。
//   · 路径支持 `~`、绝对路径、相对仓库根的路径；目录自动含子树。
//   · `denyExec` 是正则字符串数组，同样「不写=默认，写了=替换」。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根：本文件在 <repo>/plugins/qq-agent-presets/ 下。安装后是 link:，import.meta.url 指向真实仓库。 */
export const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** 默认排除读取的路径（相对仓库根的项由 REPO_ROOT 拼接）。 */
export const DEFAULT_DENY_READ = Object.freeze([
  '~/.ssh',
  '~/.git-credentials',
  '~/.netrc',
  '~/.aws',
  '~/.config/gh',
  '~/.dsh/.credentials.yaml',
  '~/.dsh/sessions',
  '~/.config/QQ',
  'config.json',
  'state'
]);

/** 默认拒绝执行的命令模式（正则源码；匹配整条 command，忽略大小写）。 */
export const DEFAULT_DENY_EXEC = Object.freeze([
  '\\brm\\s+(-[^\\s]*[rR][^\\s]*|--recursive)',
  '\\bfind\\b[^\\n]*\\s-delete\\b',
  '\\b(shred|mkfs|fdisk|parted|wipefs)\\b',
  '\\bdd\\b[^\\n]*\\bof=',
  '\\b(sudo|doas|su)\\b',
  '\\bchmod\\s+(-R|--recursive)\\b',
  '\\bchown\\s+(-R|--recursive)\\b',
  '\\b(mount|umount)\\b',
  '\\b(shutdown|reboot|poweroff|halt|init\\s+0)\\b',
  ':\\s*\\(\\s*\\)\\s*\\{',
  '\\btruncate\\s+-s\\s*0\\b',
  '>\\s*/dev/(sd|nvme|mmcblk)'
]);

/** 参与「路径不可读写」检查的工具 → 取路径的参数名。 */
const FS_PATH_ARGS = Object.freeze({
  read: ['file_path'],
  read_image: ['file_path'],
  write: ['file_path'],
  edit: ['file_path'],
  glob: ['path'],
  grep: ['path']
});
/** 目录遍历型工具：搜索根若在排除目录的**祖先**上，也必须拒绝（否则会遍历进去）。 */
const TRAVERSAL_TOOLS = new Set(['glob', 'grep']);
/** 命令型工具：命令字符串里出现排除路径或危险模式即拒绝。 */
const SHELL_TOOLS = new Set(['bash', 'pwsh']);

const isWin = process.platform === 'win32';
const cmp = (p) => (isWin ? p.toLowerCase() : p);

/** 把配置里的路径展开成绝对路径（支持 `~`；相对路径按仓库根解析）。 */
export function expandPath(entry, { repoRoot = REPO_ROOT, home = os.homedir() } = {}) {
  const raw = String(entry ?? '').trim();
  if (!raw) return '';
  if (raw === '~') return path.resolve(home);
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.resolve(home, raw.slice(2));
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(repoRoot, raw);
}

/**
 * 规范化一个待检查的路径：尽量走 realpath（防工作区内符号链接指向排除目录），
 * 目标不存在时对最近的已存在祖先取 realpath 再拼回剩余部分。
 */
export function canonicalPath(target, { cwd = process.cwd() } = {}) {
  const abs = path.isAbsolute(String(target ?? '')) ? path.resolve(String(target)) : path.resolve(cwd, String(target ?? ''));
  try { return fs.realpathSync(abs); } catch {}
  let ancestor = abs;
  const rest = [];
  while (true) {
    try {
      const real = fs.realpathSync(ancestor);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return abs;
      rest.push(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

/** target 是否等于 root 或位于 root 之下（比较前调用方已规范化）。 */
export function isUnder(target, root) {
  const t = cmp(path.resolve(String(target ?? '')));
  const r = cmp(path.resolve(String(root ?? '')));
  if (!r) return false;
  if (t === r) return true;
  return t.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/** 某个路径是否命中排除列表（等于或在其子树内）。 */
export function isPathDenied(target, denyRead) {
  return (denyRead ?? []).some((root) => isUnder(target, root));
}

/** 搜索根是否为某个排除目录的祖先（遍历会读到排除内容）。 */
export function isAncestorOfDenied(root, denyRead) {
  return (denyRead ?? []).some((denied) => isUnder(denied, root) && !isUnder(root, denied));
}

/** 解析 agentGuard 配置；缺省时用内置默认，显式给出时完全替换。 */
export function resolveGuardConfig(raw, { repoRoot = REPO_ROOT, home = os.homedir() } = {}) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const enabled = value.enabled !== false;
  const denyReadSource = Array.isArray(value.denyRead) ? value.denyRead : DEFAULT_DENY_READ;
  const denyExecSource = Array.isArray(value.denyExec) ? value.denyExec : DEFAULT_DENY_EXEC;
  const denyRead = [];
  for (const entry of denyReadSource) {
    const abs = expandPath(entry, { repoRoot, home });
    if (!abs) continue;
    let canonical = abs;
    try { canonical = fs.realpathSync(abs); } catch {}
    denyRead.push(canonical);
  }
  const denyExec = [];
  for (const pattern of denyExecSource) {
    try { denyExec.push(new RegExp(String(pattern), 'i')); }
    catch (error) { console.error(`[qq-agent-guard] 忽略非法 denyExec 正则 ${JSON.stringify(pattern)}: ${error?.message ?? error}`); }
  }
  return { enabled, denyRead, denyExec };
}

let cache = { stamp: null, value: null, file: '' };
/** 读取 <repo>/config.json 的 agentGuard（按 mtime+size 缓存，改完即生效）。 */
export function loadGuardConfig({ repoRoot = REPO_ROOT, home = os.homedir() } = {}) {
  const file = path.join(repoRoot, 'config.json');
  let stat;
  try { stat = fs.statSync(file); } catch {
    if (cache.file !== file || cache.stamp !== null) cache = { stamp: null, value: resolveGuardConfig(null, { repoRoot, home }), file };
    return cache.value;
  }
  const stamp = `${stat.mtimeMs}:${stat.size}`;
  if (cache.stamp === stamp && cache.file === file) return cache.value;
  let raw = null;
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    raw = JSON.parse(text);
  } catch (error) {
    console.error(`[qq-agent-guard] 读取 config.json 失败，沿用默认排除列表：${error?.message ?? error}`);
  }
  cache = { stamp, value: resolveGuardConfig(raw?.agentGuard, { repoRoot, home }), file };
  return cache.value;
}

/** 命令里是否出现某个排除路径（绝对路径 / ~ 形式 / 相对 home 的形式）。 */
function commandMentionsPath(command, denyRead, { home }) {
  const text = String(command ?? '');
  for (const denied of denyRead) {
    const forms = new Set([denied]);
    if (home && isUnder(denied, home)) {
      const rel = path.relative(home, denied);
      if (rel && !rel.startsWith('..')) {
        forms.add(`~/${rel}`);
        forms.add(`~\\${rel}`);
        forms.add(rel);
      }
    }
    for (const form of forms) {
      if (form && text.includes(form)) return { denied, form };
    }
  }
  return null;
}

/**
 * 核心判定：给一次工具调用，返回拒绝理由或 null（允许）。
 * @param {object} input - { name, args, cwd, config }
 * @returns {string|null}
 */
export function checkToolCall({ name, args, cwd, config, home = os.homedir() }) {
  if (!config?.enabled) return null;
  const tool = String(name ?? '');
  const toolArgs = args && typeof args === 'object' ? args : {};
  const workdir = cwd || process.cwd();

  const paths = FS_PATH_ARGS[tool];
  if (paths) {
    const targets = [];
    for (const key of paths) {
      const value = toolArgs[key];
      if (typeof value !== 'string' || value.trim() === '') continue;
      targets.push({ raw: value, abs: canonicalPath(value, { cwd: workdir }) });
    }
    // glob/grep 不传 path 时默认搜会话工作区：工作区本身可能就是排除目录的祖先
    // （例如 sessionCwd=家目录、denyRead=[~/.ssh]），这时遍历同样会读到排除内容。
    if (TRAVERSAL_TOOLS.has(tool) && targets.length === 0) {
      targets.push({ raw: '(默认工作区)', abs: canonicalPath(workdir) });
    }
    for (const { raw, abs } of targets) {
      if (isPathDenied(abs, config.denyRead)) {
        return `[agent-guard] 拒绝访问 ${raw}：该路径在 agentGuard.denyRead 排除列表内（含其子目录）`;
      }
      if (TRAVERSAL_TOOLS.has(tool) && isAncestorOfDenied(abs, config.denyRead)) {
        return `[agent-guard] 拒绝在 ${raw} 下搜索：该目录包含被排除的路径，遍历会读到被排除内容；请把搜索根缩小到具体子目录`;
      }
    }
    if (TRAVERSAL_TOOLS.has(tool)) {
      const pattern = typeof toolArgs.pattern === 'string' ? toolArgs.pattern : '';
      // glob/grep 的 pattern 若带绝对路径 / ~ / ..，会绕过上面按搜索根的检查。
      if (config.denyRead.length > 0 && (pattern.startsWith('/') || pattern.startsWith('~') || pattern.includes('..'))) {
        return '[agent-guard] 拒绝该搜索表达式：pattern 不能是绝对路径、~ 或包含 ..（避免绕过 denyRead 排除列表）';
      }
    }
    return null;
  }

  if (SHELL_TOOLS.has(tool)) {
    const command = typeof toolArgs.command === 'string' ? toolArgs.command : '';
    if (!command) return null;
    const hit = commandMentionsPath(command, config.denyRead, { home });
    if (hit) {
      return `[agent-guard] 拒绝执行：命令包含被排除的路径 ${hit.form}（agentGuard.denyRead）`;
    }
    for (const pattern of config.denyExec) {
      if (pattern.test(command)) {
        return `[agent-guard] 拒绝执行：命令匹配禁止模式 ${pattern.source}（agentGuard.denyExec）。这不是沙盒，只是命令级护栏；确需执行请让管理员在管理端操作`;
      }
    }
    return null;
  }

  return null;
}

/** 从 exec 里取会话工作区（DSH 的 tool exec 带 agent.session.header.cwd）。 */
export function sessionCwdOf(exec) {
  try {
    const cwd = exec?.agent?.session?.header?.cwd;
    if (typeof cwd === 'string' && cwd) return cwd;
  } catch {}
  return process.cwd();
}

export const name = 'qq-agent-guard';
export const inject = ['tools'];

export function apply(ctx) {
  ctx.tools.guard((exec) => {
    try {
      const config = loadGuardConfig();
      if (!config.enabled) return undefined;
      return checkToolCall({
        name: exec?.name,
        args: exec?.arguments,
        cwd: sessionCwdOf(exec),
        config
      }) ?? undefined;
    } catch (error) {
      // 守卫自身异常时 fail-closed：宁可挡住一次调用，也不要静默放行。
      return `[agent-guard] 护栏内部错误，已拒绝本次调用：${error?.message ?? error}`;
    }
  });
}
