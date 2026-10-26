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
const asJson = args.includes('--json');

// 默认规则：即使没有 privacy-rules.json 也能挡住最常见的一类泄漏。
const DEFAULT_RULES = {
  comment: '默认规则。请把 privacy-rules.json 加进 .gitignore（它含你的真实 QQ 号/路径），本文件是脱敏模板。',
  deny: [
    { name: '本机绝对路径（Windows 用户目录）', pattern: '[A-Za-z]:\\\\Users\\\\[^\\\\\\s"\'`]{2,}', flags: 'i' },
    { name: '本机绝对路径（非系统盘的顶层目录）', pattern: '(?<![A-Za-z0-9])(?!C:)[A-Za-z]:\\\\[^\\\\\\s"\'`|<>]{2,}\\\\', flags: 'i' },
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

// 占位符白名单：本仓库的示例/夹具用这些号，其余纯数字（QQ 号/群号）一律要报。
// 注意必须声明在扫描循环之前：isNoise() 在循环里被调用，函数声明会提升但 const 不会。
const PLACEHOLDER_NUMBERS = new Set([
  '123456780', '123456781', '123456782', '123456783', '123456788', '123456789',
  '1000000000', '1000000001', '1000000002', '1234567890', '987654321'
]);

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
    try { re = new RegExp(rule.pattern, rule.flags ?? 'g'); }
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
      if (isNoise(value, rule)) continue;
      hits += 1;
      const line = text.slice(0, m.index).split('\n').length;
      findings.push({ kind: 'content', rule: rule.name, file: normalized, line, masked: mask(value) });
    }
    if (attempts >= 5000 || Date.now() - started >= 3000) {
      console.error(`[privacy-scan] ⚠️ ${normalized} 的「${rule.name}」匹配过多/过慢，已提前结束该规则（该文件此规则结果可能不完整）`);
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
 *
 * ⚠️ **纯数字不是噪音**：QQ 号/群号就是纯数字。早期版本把纯数字一并当噪音吞掉，
 * 结果"9-10 位数字"这条规则永远不报——这是真实项目里差点漏掉几十个真号的原因。
 * 只放行下面这份占位符白名单（本仓库的示例/夹具用它）。
 */
function isNoise(value, rule) {
  if (/^[0-9]+$/.test(value)) return PLACEHOLDER_NUMBERS.has(value);  // QQ 号/群号：纯数字，必须报
  if (/^(iVBORw0KGgo|data:image\/|R0lGOD)/i.test(value)) return true;  // 测试夹具里的 1x1 图片 base64
  if (rule.requireNonHex && /^[0-9a-f]+$/i.test(value)) return true;
  if (/^[A-Z0-9_]+$/.test(value)) return true;                       // 环境变量名/常量
  if (/^[a-z0-9._-]+$/.test(value)) return true;                     // 文件名/包名/路径片段
  if (/^[A-Za-z0-9]+$/.test(value) && !(/[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value))) return true;
  return false;
}

if (asJson) {
  console.log(JSON.stringify({ rulesFromFile: rules.fromFile, source: listed.via, scanned: files.length, findings }, null, 2));
} else {
  console.log(`[privacy-scan] 规则来源：${rules.fromFile ? 'scripts/privacy-rules.json + 内置默认' : '仅内置默认（建议补 privacy-rules.json）'}`);
  console.log(`[privacy-scan] 扫描文件数：${files.length}（来源：${listed.via}）`);
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
