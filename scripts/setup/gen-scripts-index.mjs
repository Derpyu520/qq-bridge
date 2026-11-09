#!/usr/bin/env node
// scripts/ 索引生成器：按**目录分类**把 scripts/ 里的脚本写进 scripts/README.md。
//
// 目录即分类：audit/ 审计子模块、tests/offline|live 测试、probes/ 探针、setup/ 安装生成、
// ops/ 运维诊断、send/ 会发 QQ 的、console/ 控制台、lib/ 共享库。新增脚本直接放对目录，
// 再运行本脚本刷新索引；`--check` 供 test:audit 校验索引是否过期。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPTS = path.join(ROOT, 'scripts');
const README = path.join(SCRIPTS, 'README.md');
const BEGIN = '<!-- scripts-index:begin -->';
const END = '<!-- scripts-index:end -->';

const SECTION_ORDER = [
  '入口与运行器', '审计子模块与夹具', '离线测试（test:audit 清单）', '单独运行的测试',
  '探针与校验', '安装、生成与修补', '控制台', '运维、诊断与扫描',
  '会向 QQ 发送内容（谨慎）', '内部库与夹具', '其它'
];

function walk(dir, rel = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), childRel));
    else out.push(childRel);
  }
  return out;
}

function readAuditList() {
  const text = fs.readFileSync(path.join(SCRIPTS, 'test-audit.mjs'), 'utf8');
  return new Set([...text.matchAll(/'([\w./-]+\.mjs)'/g)].map((m) => m[1]));
}

function readNpmCommands() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const map = new Map();
  for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
    for (const m of String(cmd).matchAll(/scripts\/([\w./-]+\.mjs)/g)) {
      if (!map.has(m[1])) map.set(m[1], []);
      map.get(m[1]).push(name);
    }
  }
  return map;
}

function firstComment(rel) {
  const lines = fs.readFileSync(path.join(SCRIPTS, rel), 'utf8').split(/\r?\n/);
  const base = path.basename(rel);
  for (let line of lines.slice(0, 16)) {
    line = line.trim();
    if (!line || line.startsWith('#!')) continue;
    if (line.startsWith('//')) {
      let text = line.replace(/^\/\/\s?/, '').trim();
      if (!text || /^[-=*#─—]/.test(text)) continue;
      text = text.replace(new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[—-]\\s*`), '');
      text = text.replace(/[：:]$/, '');
      return text.length > 80 ? `${text.slice(0, 79)}…` : text;
    }
    if (!line.startsWith('import') && !line.startsWith('const ') && !line.startsWith('export ')) break;
  }
  return '';
}

function sectionOf(rel) {
  const dir = path.dirname(rel);
  if (rel === 'test-audit.mjs') return '入口与运行器';
  if (dir === 'audit') return '审计子模块与夹具';
  if (dir === 'tests/offline') return '离线测试（test:audit 清单）';
  if (dir === 'tests/live') return '单独运行的测试';
  if (dir === 'probes') return '探针与校验';
  if (dir === 'setup') return '安装、生成与修补';
  if (dir === 'console') return '控制台';
  if (dir === 'ops') return '运维、诊断与扫描';
  if (dir === 'send') return '会向 QQ 发送内容（谨慎）';
  if (dir === 'lib') return '内部库与夹具';
  return '其它';
}

function buildIndex() {
  const all = walk(SCRIPTS);
  const mjs = all.filter((f) => f.endsWith('.mjs') && f !== 'README.md');
  const assets = all.filter((f) => !f.endsWith('.mjs') && f !== 'README.md' && f !== '.gitignore');
  const audit = readAuditList();
  const npm = readNpmCommands();
  const buckets = new Map(SECTION_ORDER.map((s) => [s, []]));
  for (const rel of mjs) {
    const notes = [];
    if (audit.has(rel)) notes.push('audit');
    if (npm.has(rel)) notes.push(`npm: ${npm.get(rel).join(' / ')}`);
    const desc = firstComment(rel);
    buckets.get(sectionOf(rel)).push(`- \`${rel}\`${desc ? ` — ${desc}` : ''}${notes.length ? `（${notes.join('；')}）` : ''}`);
  }
  const lines = [BEGIN, ''];
  for (const section of SECTION_ORDER) {
    const items = buckets.get(section);
    if (!items.length) continue;
    lines.push(`### ${section}`, '', ...items, '');
  }
  if (assets.length) {
    lines.push('### 资源文件与夹具', '');
    for (const f of assets) lines.push(`- \`${f}\``);
    lines.push('');
  }
  lines.push(END);
  return lines.join('\n');
}

const header = `# scripts/ 索引

> 目录即分类：
>
> - \`audit/\` 审计子模块与夹具（\`test-audit.mjs\` 在根目录，是运行入口）
> - \`tests/offline/\` 离线测试（必须登记在 \`test-audit.mjs\` 清单里）
> - \`tests/live/\` 需要 DSH / SnowLuma / QQ 的实时测试
> - \`probes/\` 探针与适配校验 · \`setup/\` 安装/生成/修补 · \`ops/\` 运维与诊断
> - \`send/\` 会向 QQ 发送内容 · \`console/\` 控制台工具 · \`lib/\` 共享库 · \`fixtures/\` 资源
>
> 新增脚本：选对目录 → 离线测试加进 \`test-audit.mjs\` 清单 → 运行
> \`node scripts/setup/gen-scripts-index.mjs\` 刷新本文件（\`--check\` 只校验）。
> 一次性调试脚本放 \`scripts/.gitignore\`，不要提交。
>
> 常用入口：\`npm run test:audit\`（离线全量）、\`npm run privacy-scan\`、\`npm run verify:adaptation\`。

`;

function renderFull(existing) {
  const index = buildIndex();
  if (!existing) return `${header}${index}\n`;
  const begin = existing.indexOf(BEGIN);
  const end = existing.indexOf(END);
  if (begin < 0 || end < 0) return `${existing.trimEnd()}\n\n${index}\n`;
  return `${existing.slice(0, begin)}${index}${existing.slice(end + END.length)}`;
}

const check = process.argv.includes('--check');
const existing = fs.existsSync(README) ? fs.readFileSync(README, 'utf8') : '';
const next = renderFull(existing);
if (next === existing) {
  if (check) console.log('[scripts-index] 索引已是最新');
} else if (check) {
  console.error('[scripts-index] 索引过期：请运行 node scripts/setup/gen-scripts-index.mjs');
  process.exitCode = 1;
} else {
  fs.writeFileSync(README, next);
  console.log('[scripts-index] 已更新 scripts/README.md');
}
