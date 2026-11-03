// 发布前隐私与敏感信息扫描（**离线、只读、不联网**）。
//
// 为什么需要它：这个项目在一台真实机器上跑过，工作树里散落着真实 QQ 号、群号、本机绝对路径、
// 令牌、以及个人化的人格卡内容。任何一次"忘了 gitignore 就直接推"都会把这些永久写进公开仓库历史
// ——而 Git 历史里的东西删提交是删不掉的（还会被 fork 保留）。
//
// 工作方式：扫描**将要被提交的内容**（`git ls-files` 的文件 + 未跟踪但没被 ignore 的文件），
// 逐条匹配规则；命中即失败（退出码 1），并只打印**脱敏后的片段**（绝不回显凭据本身）。
//
// 用法：
//   node scripts/privacy-scan.mjs                # 扫描当前工作树（推荐：提交前/发布前）
//   node scripts/privacy-scan.mjs --tracked-only # 只扫 git 已跟踪文件
//   node scripts/privacy-scan.mjs --history      # 追加扫描**全部 git 历史**（发布前必跑）
//   node scripts/privacy-scan.mjs --json         # 机读输出
//
// 规则来源：`scripts/privacy-rules.json`（可自己加；里面的值是**你机器上的真实标识**，不入库）。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RULES_FILE = path.join(__dirname, 'privacy-rules.json');
const args = process.argv.slice(2);
const trackedOnly = args.includes('--tracked-only');
const withHistory = args.includes('--history');
const asJson = args.includes('--json');

// 默认规则：即使没有 privacy-rules.json 也能挡住最常见的一类泄漏。
const DEFAULT_RULES = {
  comment: '默认规则。请把 privacy-rules.json 加进 .gitignore（它含你的真实 QQ 号/路径），本文件是脱敏模板。',
  deny: [
    // 段内**允许空格**：真实工作目录常见 `D:\Projects\my workspace\...`。
    // 早先排除 `\s` 的写法会把这类路径整体漏掉（实测：连已知泄漏都扫不出来）。
    { name: '本机绝对路径（Windows 用户目录）', pattern: '[A-Za-z]:\\\\Users\\\\[^\\\\"\'`<>]{2,}', flags: 'i', reject: rejectUserDirPath },
    { name: '本机绝对路径（非系统盘的顶层目录）', pattern: '(?<![A-Za-z0-9])(?!C:)[A-Za-z]:\\\\[^\\\\"\'`|<>]{2,}\\\\', flags: 'i', reject: rejectWindowsPathShape },
    { name: 'QQ 号/群号（9-10 位连续数字）', pattern: '(?<![0-9])[1-9][0-9]{8,9}(?![0-9])', flags: '' },
    // 真实凭据是**高熵**的；`dea3ce8c408a...` 这种 40 位全 hex 是 git commit SHA，
    // 报它属于纯粹的噪音（会让整个扫描被无视）。所以只报"含非 hex 字符的长串"。
    { name: '疑似令牌/密钥（高熵串）', pattern: '(?<![0-9a-zA-Z])[0-9a-zA-Z_-]{32,}(?![0-9a-zA-Z])', flags: '', requireNonHex: true },
    // 凭据赋值：**空值/占位符不算**（`accessToken: ''` 是模板常态，报它只会制造噪音）。
    { name: '疑似凭据赋值（有实际值）', pattern: '(?:access[_-]?token|api[_-]?key|password|passwd|secret)["\']?\\s*[:=]\\s*["\']?[A-Za-z0-9_\\-./+=]{12,}', flags: 'i' },
    { name: '私钥头', pattern: '-----BEGIN [A-Z ]*PRIVATE KEY-----', flags: '' },
    { name: '带凭据的 URL', pattern: 'https?://[^/\\s:@]+:[^/\\s:@]+@', flags: 'i' },
  ],
  // 这些文件本来就不该进公开仓库；出现即失败（无论内容）。
  denyFiles: ['config.json', 'state/', 'audio/', '*.log', '*.bak', '*.bak-*', 'roles/*.md.bak*'],
  // 路径/整行匹配到这些就跳过（脱敏模板、示例、测试夹具、已声明含占位符的文档）。
  // 注意：这是**误报白名单**，不是"这些文件不用检查"——加入前先确认里面确实只有占位数据。
  allowPaths: [
    'scripts/privacy-', 'config.example.json', 'package-lock.json', 'src/sensitive.js',
    // 测试夹具/回归脚本：里面是刻意构造的假 ID 与假凭据
    'scripts/test-', 'scripts/console-ui-', 'scripts/fixtures/', 'scripts/audit-bridge-harness.mjs',
    'scripts/check-onebot-status.mjs', 'scripts/send-test-group.mjs', 'scripts/send-voice.mjs',
    'scripts/setup-dsh.mjs', 'scripts/patch-', 'scripts/verify-', 'scripts/probe-',
    // ── 以下三项来自一次独立复核：在**全新克隆**里扫描会报 15 条命中，全部是误报，
    //    但它们此前只写在本地 privacy-rules.json（不入库）里，所以对外部验证者而言
    //    这道闸门永远是红的。把误报放进来，闸门才是可用的。
    //    逐条依据：docs/guides/PRIVACY.md 是**讲解脱敏规则**的文档，里面的
    //    `C:\Users\<名字>\…` / `https://user:pass@host` / `-----BEGIN … PRIVATE KEY-----`
    //    就是它要举例的占位符；src/bridge.js:1706 是注释里的示例 `D:\...\audio\xxx.mp3`；
    //    src/bridge.js 的 `accessToken:` 与 src/dsh-client.js 的 `secret =` 命中的都是
    //    **运行时从配置/凭据文件读取**的赋值，源码里没有任何凭据字面量。
    //    ⚠️ 代价必须说清：allowPaths 是**按文件**粒度放行的，所以 bridge.js / dsh-client.js
    //    今后新增的真实泄漏不会被扫出来。要收紧，正确做法是给扫描器加
    //    「文件 + 规则名」粒度（或让凭据规则只认高熵字面量），而不是继续往这里加文件。
    'docs/guides/PRIVACY.md', 'src/bridge.js', 'src/dsh-client.js',
  ],
};

/**
 * Windows 路径的「形状级」噪音过滤，工作树与历史扫描共用。
 *
 * 只排除：文档占位符（`<名字>`、`...`）、Windows 文件名里本来就非法的字符（`* ? |`）、
 * 以及源码里的转义/正则片段（`d:\s*(...)`、`t:\n  ...`）。
 * **不排除括号/方括号/花括号**——它们是合法目录名字符（如 `D:\Projects (2024)\...`），
 * 一刀切排除会造成真实路径的漏报。
 */
function rejectWindowsPathShape(value) {
  return (/[<>…]|\.\.\./.test(value)
    || /[\\/](?:path|xxx|example)[\\/]/i.test(value)
    || /[*?|]/.test(value)
    || /\\[sSdDwWnNtT][([*+?\\]/.test(value)
    || /\\[nrt]\s/.test(value));
}

/** 用户目录规则额外排除「用户名本身就是占位符」的写法。 */
function rejectUserDirPath(value) {
  return (rejectWindowsPathShape(value)
    || /[\\/](?:someone|x|user|username|example|名字|用户名)(?:[\\/]|$)/i.test(value));
}

function loadRules() {
  if (!fs.existsSync(RULES_FILE)) return { ...DEFAULT_RULES, fromFile: false };
  try {
    const raw = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8').replace(/^\uFEFF/, ''));
    return {
      ...DEFAULT_RULES,
      ...raw,
      deny: [...(raw.deny ?? []), ...DEFAULT_RULES.deny],
      denyFiles: [...(raw.denyFiles ?? []), ...DEFAULT_RULES.denyFiles],
      allowPaths: [...(raw.allowPaths ?? []), ...DEFAULT_RULES.allowPaths],
      fromFile: true,
    };
  } catch (error) {
    console.error(`[privacy-scan] 无法解析 ${RULES_FILE}：${error?.message ?? error}`);
    process.exit(2);
  }
}

/** 收集候选文件：git 已跟踪 + 未跟踪但未被 ignore 的。git 不可用时退化为目录遍历。 */
function listFiles() {
  const git = (a) => {
    const res = spawnSync('git', a, { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
    if (res.error || res.status !== 0) return null;
    return (res.stdout ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  };
  const tracked = git(['ls-files']);
  if (tracked) {
    if (trackedOnly) return { files: tracked, via: 'git ls-files' };
    const others = git(['ls-files', '--others', '--exclude-standard']) ?? [];
    return { files: [...new Set([...tracked, ...others])], via: 'git ls-files' };
  }
  // git 不可用（沙箱禁止 spawn / 没装 git / 不是仓库）：退化为目录遍历 + 读 .gitignore。
  // 这样脚本在任何环境下都能给出**有意义的**结果，而不是一句"拿不到文件列表"。
  const ignores = readGitignorePatterns();
  const out = [];
  const seen = new Set();
  const MAX_DEPTH = 24;
  const MAX_FILE_BYTES = 8 * 1024 * 1024;
  const walk = (dir, rel, depth) => {
    if (depth > MAX_DEPTH) return;
    // 真实存在的坑：本仓库里 `state/setup-dsh-test-home/plugins/qq-mode-console` 是一个
    // **junction**，指回仓库自身 ⇒ 朴素遍历会无限递归。所以必须显式跳过所有 reparse point
    // （junction / 符号链接）。Windows 上 Node 的 Dirent.isSymbolicLink() 对 junction 不可靠，
    // 因此这里直接看 lstat 的 ReparsePoint 属性，再用 realpath 去重兜底。
    let real;
    try { real = fs.realpathSync(dir); } catch { return; }
    if (seen.has(real)) return;
    seen.add(real);
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (SKIP_DIRS.has(e.name) || SKIP_DIRS.has(childRel)) continue;
      if (ignores.some((re) => re.test(childRel) || re.test(`${childRel}/`))) continue;
      const abs = path.join(dir, e.name);
      let st = null;
      try { st = fs.lstatSync(abs); } catch { continue; }
      if (st.isSymbolicLink() || (st.attributes !== undefined && (st.attributes & 0x400) !== 0)) {
        // 0x400 = FILE_ATTRIBUTE_REPARSE_POINT
        continue;
      }
      if (st.isDirectory()) walk(abs, childRel, depth + 1);
      else if (st.isFile()) {
        if (st.size > MAX_FILE_BYTES) continue;
        out.push(childRel);
      }
    }
  };
  walk(ROOT, '', 0);
  return { files: out, via: `目录遍历（git 不可用，已尽力套用 .gitignore；跳过 ${seen.size} 个真实目录）` };
}

// 永远跳过的目录：依赖、缓存、git 元数据、以及**用户数据**（后者的处理方式是"出现即报错"，
// 见 denyFiles，不需要进去扫内容）。少跳一个目录就可能让扫描去读几十万行依赖代码。
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.npm-cache', '.cache', 'dist', 'build', 'coverage',
  'state', 'audio', 'assets/vendor',
]);

/** 把 .gitignore 里"简单形态"的规则转成正则（够用即可：目录名、文件名、*.ext、/path）。 */
function readGitignorePatterns() {
  let text = '';
  try { text = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8'); } catch { return []; }
  const out = [];
  for (let line of text.split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const p = line.replace(/^\//, '').replace(/\/$/, '');
    if (!p) continue;
    // 关键点：`*.log` 这类"只有 basename 通配"的规则要匹配**任意目录下**的同名文件，
    // 而不是拼成 `^*\.log`（那是个非法正则）。含 `/` 的规则按路径前缀匹配。
    const hasSlash = p.includes('/');
    const base = hasSlash ? p : path.basename(p);
    const baseRe = globToRe(hasSlash ? p : base).source;
    try {
      out.push(hasSlash
        ? new RegExp(`(?:^|/)${baseRe}(?:/|$)`)
        : new RegExp(`(?:^|/)${baseRe}$`));
    } catch { /* 忽略无法解析的规则 */ }
  }
  return out;
}

const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.webm', '.wav', '.mp3', '.ico', '.zip', '.tgz', '.exe', '.dll', '.node', '.woff', '.woff2', '.ttf', '.zstd']);

function looksBinary(buf) {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function mask(snippet) {
  // 只保留头尾，中间打码——报告本身不能成为泄漏源。
  const s = String(snippet).replace(/[\r\n]+/g, ' ').trim();
  if (s.length <= 12) return s.replace(/./g, '*');
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function globToRe(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
  return new RegExp(`^${esc}$`);
}

const rules = loadRules();
if (process.env.QQ_BRIDGE_PRIVACY_DEBUG) console.error('[privacy-scan:debug] rules loaded');
const listed = listFiles();
if (process.env.QQ_BRIDGE_PRIVACY_DEBUG) console.error(`[privacy-scan:debug] listed ${listed.files.length} files via ${listed.via}`);
const files = listed.files;
if (!files.length) {
  console.error('[privacy-scan] 没有拿到任何文件（目录遍历失败或仓库为空）');
  process.exit(2);
}

const allowRe = rules.allowPaths.map((p) => (p.includes('*') ? globToRe(p) : new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&')}`)));
const denyFileRes = rules.denyFiles.map((p) => ({ glob: p, re: globToRe(p) }));

const findings = [];
for (const rel of files) {
  const normalized = rel.split(path.sep).join('/');
  // ① 文件级：本来就不该出现的文件
  for (const { glob, re } of denyFileRes) {
    if (re.test(normalized)) findings.push({ kind: 'file', rule: `不应入库的文件（${glob}）`, file: normalized, masked: '' });
  }
  if (allowRe.some((re) => re.test(normalized))) continue;
  if (BINARY_EXT.has(path.extname(normalized).toLowerCase())) continue;
  const abs = path.join(ROOT, rel);
  let buf;
  try { buf = fs.readFileSync(abs); } catch { continue; }
  if (looksBinary(buf)) continue;
  const text = buf.toString('utf8');
  // ② 内容级：一个文件里同一规则最多报 3 处（带行号），方便直接定位；不要把整文件刷屏。
  for (const rule of rules.deny) {
    let re;
    // 必须带 `g`：默认规则里有 `flags: ''` 的条目，而非全局正则的 `exec()` 不推进
    // `lastIndex` —— 同一个位置会被反复命中，表现为「同一条命中报 3 次」以及
    // 「匹配过多/过慢」的假截断（实测：src/media-normalize.js 的 3 条误报、
    // public/console.html 的假截断都是这个原因）。
    const flags = new Set((rule.flags ?? '').split(''));
    flags.add('g');
    try { re = new RegExp(rule.pattern, [...flags].join('')); }
    catch (error) { console.error(`[privacy-scan] 规则「${rule.name}」正则非法：${error.message}`); continue; }
    re.lastIndex = 0;
    let m;
    let hits = 0;       // 已上报的命中数（上限 3）
    let attempts = 0;   // 正则**总迭代次数**（含被过滤掉的）
    const started = Date.now();
    // 迭代上限必须独立于 hits：被过滤掉的匹配也会让 lastIndex 每次只前进 1 个字符，
    // 在一个"全是 hex 串"的文档里（本仓库的 TOKEN_OPTIMIZATION.md 就是）会出现
    // 数十万次迭代而 hits 始终为 0 —— 表现为整个扫描卡死。
    while ((m = re.exec(text)) !== null && hits < 3 && attempts < 5000 && Date.now() - started < 3000) {
      attempts += 1;
      const value = m[0];
      if (m.index === re.lastIndex) re.lastIndex += 1; // 空匹配保护
      if (rule.reject && rule.reject(value)) continue;
      if (isNoise(value, rule)) continue;
      hits += 1;
      const line = text.slice(0, m.index).split('\n').length;
      findings.push({ kind: 'content', rule: rule.name, file: normalized, line, masked: mask(value) });
    }
    if (attempts >= 5000 || Date.now() - started >= 3000) {
      // 覆盖不完整必须**算失败**，不能只打一行警告：静默降级的扫描器会让人误以为
      // 「没报问题 = 没问题」。要恢复通过，请调高下面这两个上限或缩小该规则。
      console.error(`[privacy-scan] ❌ ${normalized} 的「${rule.name}」匹配过多/过慢，已提前结束该规则（结果不完整）`);
      findings.push({ kind: 'scan', rule: `扫描未完成（${rule.name}）`, file: normalized, masked: '' });
    }
  }
}

/**
 * 噪音过滤：把**明显不是秘密**的命中挡掉。
 *
 * 为什么必须做：一个"什么都报"的扫描器等于没有扫描器——用户看两眼就不看了。
 * 这里挡掉的三类是实测出来的主要噪音源：
 *   - 全 hex 的长串：git commit SHA（`dea3ce8c408a…`）而不是密钥；
 *   - 全大写下划线的长串：环境变量名 / 常量名（`PLAYWRIGHT_MODULE`）；
 *   - 连字符/点号分隔的小写长串：文件名/包名/路径片段（`bridge.js.bak-20260821-1722-currentRoleHint`）。
 * 真凭据是**混合大小写 + 数字**的高熵串，因此下面要求"同时含小写与大写与数字"。
 */
function isNoise(value, rule) {
  if (rule.requireNonHex && /^[0-9a-f]+$/i.test(value)) return true;
  // 全大写的标识符/常量/文档编号：`PLAYWRIGHT_MODULE`、`AUDIT_2026-10-18_MEDIA_AND_WATERMARK`
  // 都会被高熵规则命中，但它们不可能是凭据（凭据是大小写+数字混合）。
  if (/^[A-Z0-9_-]+$/.test(value)) return true;
  if (/^[a-z0-9._-]+$/.test(value)) return true;                     // 文件名/包名/路径片段
  if (/^[A-Za-z0-9]+$/.test(value) && !(/[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value))) return true;
  return false;
}

/**
 * 历史扫描：工作树扫描看不见「已经提交过、后来删掉」的内容，而这正是最危险的一类
 * ——删文件不会删历史，fork 还会永久保留。这里用 `git grep` 遍历所有可达提交，
 * 只跑**低误报、ERE 可用**的规则（高熵规则误报太多，不适合扫历史）。
 *
 * 这是**发布前**的检查，不进 CI：CI 默认浅克隆，看不到历史；全历史扫描也明显更慢。
 */
const HISTORY_RULES = [
  {
    name: '本机绝对路径（Windows 用户目录）',
    check: /[A-Za-z]:\\Users\\[^\\"'`<>]{2,}/,
    // 占位符：`C:\Users\<名字>\…`、`C:\Users\someone\config.json`、`C:\Users\x\Music`
    reject: rejectUserDirPath,
  },
  {
    name: '本机绝对路径（非系统盘）',
    // 段内**允许空格**：真实工作目录常见 `D:\Projects\my workspace\...`，
    // 早先排除 `\s` 的写法会把这类路径整体漏掉（实测漏掉了已知泄漏）。
    check: /[A-Za-z]:\\[^\\"<>]+\\[^\\"<>]+\\/,
    reject: (v) => (/^[Cc]:/.test(v) || rejectWindowsPathShape(v)),
  },
  { name: '私钥头', check: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    name: '带凭据的 URL',
    check: /https?:\/\/[^/\s:@]+:[^/\s:@]+@/,
    // 只排除「密码本身就是占位符」或「主机是占位符」的写法（`https://user:pass@host`）。
    // 真实但使用了 `user` 作为用户名、密码是实际值的 URL 仍然要报。
    reject: (v) => (/[<>…]/.test(v) || /:(?:pass|password|placeholder|test|demo)@/i.test(v)
      || /@(?:host|localhost|example)(?:[:/]|$)/i.test(v)),
  },
  {
    name: '已知密钥前缀',
    check: /(?:sk-|ghp_|gho_|ghs_|xox[baprs]-|AKIA)[A-Za-z0-9_-]{16,}/,
    // 测试夹具里的 `sk-test-only-for-unit-test` / `sk-from-dsh-credentials`：
    // 真 key 是大小写+数字混合，这些是纯小写连字符。
    reject: (v) => (/(?:test|fake|dummy|example|fixture|sample)/i.test(v) || /^[a-z0-9_-]+$/.test(v)),
  },
  {
    name: 'QQ 号/群号（9-10 位连续数字）',
    check: /(?<![0-9])[1-9][0-9]{8,9}(?![0-9])/,
    noise: true,
  },
];

const HISTORY_MAX_BLOB_BYTES = 8 * 1024 * 1024;

/** 单个 blob 首次出现在历史里的提交（只给命中项查，避免对每个对象都跑 git log）。 */
function commitsForBlob(oid) {
  try {
    const res = spawnSync('git', ['log', '--all', '--find-object', oid, '--format=%h', '--max-count=3'],
      { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
    if (res.error || res.status !== 0) return '';
    return (res.stdout ?? '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 3).join(',');
  } catch {
    return '';
  }
}

/**
 * 遍历**每一个历史 blob**（而不是每一条 `git grep` 结果），用与工作树扫描相同的 JS 正则。
 *
 * 为什么不直接用 `git grep -E`：POSIX ERE 不支持 lookbehind，`\\` 的转义在不同平台/版本
 * 上行为不一致（实测 `git grep -E '[A-Za-z]:\\\\...'` 在本机扫不出已知的 `D:\Projects\...`）。
 * 逐 blob 读一次内容，既避开这些坑，也不会因为「同一文件在几十个提交里没变」而重复报告。
 */
function scanHistory() {
  const revs = spawnSync('git', ['-c', 'core.quotepath=false', 'rev-list', '--all', '--objects'],
    { cwd: ROOT, encoding: 'utf8', timeout: 120000, maxBuffer: 128 * 1024 * 1024 });
  if (revs.error || revs.status !== 0 || !(revs.stdout ?? '').trim()) {
    console.error('[privacy-scan] ❌ 历史扫描失败：拿不到 git 对象列表');
    findings.push({ kind: 'history', rule: '历史扫描没有执行', file: '(git rev-list)', masked: '' });
    return;
  }

  // 对象清单 → 只要 blob，并按 oid 去重（同一内容出现在多个提交里只扫一次）。
  const typed = spawnSync('git', ['cat-file', '--batch-check=%(objectname) %(objecttype) %(rest)'],
    { cwd: ROOT, encoding: 'utf8', input: revs.stdout, timeout: 120000, maxBuffer: 128 * 1024 * 1024 });
  if (typed.error || typed.status !== 0) {
    console.error('[privacy-scan] ❌ 历史扫描失败：无法识别 git 对象类型');
    findings.push({ kind: 'history', rule: '历史扫描没有执行', file: '(git cat-file)', masked: '' });
    return;
  }
  const blobs = new Map(); // oid -> 第一次出现的路径
  for (const line of (typed.stdout ?? '').split('\n')) {
    const i = line.indexOf(' ');
    if (i < 0) continue;
    const oid = line.slice(0, i);
    const rest = line.slice(i + 1);
    const j = rest.indexOf(' ');
    if (j < 0) continue;
    if (rest.slice(0, j) !== 'blob') continue;
    const p = rest.slice(j + 1);
    if (!p || BINARY_EXT.has(path.extname(p).toLowerCase())) continue;
    if (!blobs.has(oid)) blobs.set(oid, p);
  }
  if (!blobs.size) return;

  const batch = spawnSync('git', ['cat-file', '--batch'],
    { cwd: ROOT, input: `${[...blobs.keys()].join('\n')}\n`, timeout: 300000, maxBuffer: 256 * 1024 * 1024 });
  if (batch.error || batch.status !== 0 || !batch.stdout) {
    console.error('[privacy-scan] ❌ 历史扫描失败：无法读取历史文件内容');
    findings.push({ kind: 'history', rule: '历史扫描没有执行', file: '(git cat-file --batch)', masked: '' });
    return;
  }

  const seen = new Set();
  // 每个规则只编译一次：历史 blob 里会有几十万行，逐行 new RegExp 会明显拖慢。
  const compiled = new Map();
  const scanLine = (rule, fileKey, fileLabel, lineNo, text) => {
    if (!text) return;
    let re = compiled.get(rule);
    if (!re) {
      const flags = new Set(rule.check.flags.split(''));
      flags.add('g');
      re = new RegExp(rule.check.source, [...flags].join(''));
      compiled.set(rule, re);
    }
    let m;
    let hits = 0;
    while ((m = re.exec(text)) !== null && hits < 3) {
      if (m.index === re.lastIndex) re.lastIndex += 1;
      const value = m[0];
      if (rule.reject && rule.reject(value)) continue;
      if (rule.noise && isNoise(value, {})) continue;
      hits += 1;
      const masked = mask(value);
      // 同一处泄漏会横跨很多提交（同一个文件甚至会有多个 blob 版本）；
      // 去重键只用「规则+路径+片段」，显示时才附带提交号。
      const key = `${rule.name}|${fileKey}|${masked}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const file = typeof fileLabel === 'function' ? fileLabel() : fileLabel;
      findings.push({ kind: 'history', rule: rule.name, file, line: lineNo, masked });
    }
  };

  let pos = 0;
  while (pos < batch.stdout.length) {
    const nl = batch.stdout.indexOf(0x0a, pos);
    if (nl < 0) break;
    const header = batch.stdout.toString('utf8', pos, nl);
    pos = nl + 1;
    const [oid, type, sizeText] = header.split(' ');
    if (type === 'missing') break;
    const size = Number(sizeText);
    if (!Number.isFinite(size)) break;
    const content = batch.stdout.subarray(pos, pos + size);
    pos += size + 1; // 跳过 git 追加的换行
    if (type !== 'blob') continue;
    if (size > HISTORY_MAX_BLOB_BYTES || looksBinary(content)) continue;
    const file = blobs.get(oid) ?? '(unknown)';
    // 只有真的命中时才查提交号（`git log --find-object` 不便宜）。
    const label = () => {
      const commits = commitsForBlob(oid);
      return commits ? `${file} @ ${commits}` : file;
    };
    const lines = content.toString('utf8').split('\n');
    for (const rule of HISTORY_RULES) {
      for (let ln = 0; ln < lines.length; ln += 1) scanLine(rule, file, label, ln + 1, lines[ln]);
    }
  }

  // 提交信息同样是公开内容（`git log` 直接可见），一并扫描。
  const log = spawnSync('git', ['--no-pager', 'log', '--all', '--format=%h%x09%B%x00'],
    { cwd: ROOT, encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
  if (!log.error && log.status === 0) {
    for (const record of (log.stdout ?? '').split('\u0000')) {
      const tab = record.indexOf('\t');
      if (tab < 0) continue;
      const hash = record.slice(0, tab).trim();
      const body = record.slice(tab + 1).split('\n');
      for (const rule of HISTORY_RULES) {
        const label = `(commit message) @ ${hash}`;
        body.forEach((line, i) => scanLine(rule, label, label, i + 1, line));
      }
    }
  }
}

if (withHistory) scanHistory();

if (asJson) {
  console.log(JSON.stringify({ rulesFromFile: rules.fromFile, source: listed.via, scanned: files.length, historyScanned: withHistory, findings }, null, 2));
} else {
  console.log(`[privacy-scan] 规则来源：${rules.fromFile ? 'scripts/privacy-rules.json + 内置默认' : '仅内置默认（建议补 privacy-rules.json）'}`);
  console.log(`[privacy-scan] 扫描文件数：${files.length}（来源：${listed.via}${withHistory ? '；含 git 历史' : ''}）`);
  if (!findings.length) {
    console.log('[privacy-scan] ✅ 未发现敏感信息。');
  } else {
    console.log(`[privacy-scan] ❌ 发现 ${findings.length} 处问题：`);
    for (const f of findings) {
      console.log(`   - [${f.kind}] ${f.rule} → ${f.file}${f.masked ? `  （命中片段：${f.masked}）` : ''}`);
    }
    console.log('[privacy-scan] 处理方式：① 真实数据删掉/换占位符；② 该文件本就该忽略 → 加进 .gitignore；');
    console.log('[privacy-scan] ③ 是脱敏模板/测试夹具的误报 → 加进 privacy-rules.json 的 allowPaths。');
    console.log('[privacy-scan] ⚠️ 已经提交过的内容光删文件没用：还要清历史（git filter-repo）或干脆新建仓库。');
  }
}
process.exitCode = findings.length ? 1 : 0;
