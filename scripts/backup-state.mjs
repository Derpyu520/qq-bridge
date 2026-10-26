#!/usr/bin/env node
/**
 * 备份 state/ 下的文件，命名统一成 `<原名>.<YYYYMMDD-HHmmss>.bak`。
 *
 * 为什么要统一：以前是手写时间戳（`bridge.js.bak-restart-selfheal-20261026-095857`、
 * `config.json.bak-wake-limit-1792979576643`），同一个原件能出现四五种写法，
 * bridge.js 里 pruneStateBackups() 只能靠「`.bak` 之前那截」分组，写法一歪就分错组、
 * 该清理的留一辈子。统一成「原名 + 时间戳 + .bak」之后，分组规则只有一条：
 * 去掉结尾的 .bak，再去掉结尾的时间戳。
 *
 * 用法：
 *   node scripts/backup-state.mjs config.json srcPath=../something.js
 *   node scripts/backup-state.mjs --prune            # 只跑一次收敛，不备份
 *   node scripts/backup-state.mjs --list             # 看每组的份数
 *
 * 「srcPath=」前缀用于 state/ 之外的原件（比如 src/bridge.js），
 * 备份文件名仍然只取 basename，跟原来一样落在 state/backups/。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STATE_DIR = path.join(ROOT, 'state');
const BACKUP_DIR = path.join(STATE_DIR, 'backups');
const KEEP = 3;                 // 每个原件留最近几份
const MAX_AGE_DAYS = 7;         // 超过保留份数、且放满这么多天才删

// 统一后的时间戳：20261026-131500
// 允许时间戳后面再挂一段标签：`20261026-131500-restart-selfheal`。
// 标签留在同段里是为了分组规则不被切开——分组只看「结尾这一段像不像时间戳」。
const STAMP_RE = /^\d{8}-\d{6}(?:-[0-9a-z-]+)?$/;

function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-`
    + `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 把备份文件名归到「原件」名字上。两种写法都要认：
 *   新：config.json.20261026-131500.bak       → config.json
 *   旧：config.json.bak-wake-limit-1792...    → config.json
 * 认不出来就整名当归，宁可少删不要错删。
 */
export function backupGroupKey(file) {
  let base = file;
  if (base.endsWith('.bak')) base = base.slice(0, -4);
  else if (base.includes('.bak')) base = base.slice(0, base.indexOf('.bak'));
  const dot = base.lastIndexOf('.');
  if (dot > 0) {
    const tail = base.slice(dot + 1);
    if (STAMP_RE.test(tail)) base = base.slice(0, dot);
  }
  return base;
}

export function pruneStateBackups({ keep = KEEP, maxAgeDays = MAX_AGE_DAYS, dryRun = false, dir = BACKUP_DIR } = {}) {
  let entries;
  try {
    entries = fs.readdirSync(dir).filter((f) => f.includes('.bak'));
  } catch {
    return [];   // 还没备份过，不是错误
  }
  const cutoff = Date.now() - maxAgeDays * 24 * 3600 * 1000;
  const groups = new Map();
  for (const file of entries) {
    const key = backupGroupKey(file);
    let mtime = 0;
    try { mtime = fs.statSync(path.join(dir, file)).mtimeMs; } catch {}
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ file, mtime });
  }
  const removed = [];
  for (const list of groups.values()) {
    list.sort((a, b) => b.mtime - a.mtime);          // 新的在前
    for (const stale of list.slice(Math.max(0, keep))) {
      if (stale.mtime > cutoff) continue;            // 刚备份的那份有冷却期
      if (!dryRun) {
        try { fs.rmSync(path.join(dir, stale.file)); } catch { continue; }
      }
      removed.push(stale.file);
    }
  }
  return removed;
}

function copyOne(spec) {
  const eq = spec.indexOf('=');
  const source = eq > 0 ? spec.slice(eq + 1) : path.join(STATE_DIR, spec);
  if (!fs.existsSync(source)) return { ok: false, spec, reason: '找不到原件' };
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const name = path.basename(source);
  const base = `${name}.${stamp()}`;
  let dest = path.join(BACKUP_DIR, `${base}.bak`);
  for (let i = 2; fs.existsSync(dest); i++) dest = path.join(BACKUP_DIR, `${base}-${i}.bak`);
  fs.copyFileSync(source, dest);
  const st = fs.statSync(source);
  try { fs.utimesSync(dest, st.atime, st.mtime); } catch {}   // 保留原件时间，排序才不会乱
  return { ok: true, spec, dest: path.relative(ROOT, dest) };
}

// 只有直接跑才执行 CLI：被 import 时（测试、bridge.js 复用分组逻辑）不该打印用法就退出。
const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const args = isCli ? process.argv.slice(2) : [];
if (isCli && !args.length) {
  console.log('用法：node scripts/backup-state.mjs <state里的文件名...> | srcPath=<任意路径> | --prune | --list');
  process.exit(1);
}

if (isCli && args[0] === '--list') {
  const groups = new Map();
  for (const f of fs.readdirSync(BACKUP_DIR)) {
    if (!f.includes('.bak')) continue;
    const k = backupGroupKey(f);
    groups.set(k, (groups.get(k) ?? 0) + 1);
  }
  for (const [k, n] of [...groups].sort()) console.log(`${String(n).padStart(2)} 份  ${k}`);
  process.exit(0);
}

if (isCli && args[0] === '--prune') {
  const removed = pruneStateBackups({ dryRun: args.includes('--dry-run') });
  console.log(removed.length ? `清掉 ${removed.length} 份：${removed.join('、')}` : '没有该清的');
  process.exit(0);
}

let bad = 0;
if (isCli) for (const spec of args) {
  const r = copyOne(spec);
  if (r.ok) console.log(`✓ ${r.spec} → ${r.dest}`);
  else { console.error(`✗ ${r.spec}：${r.reason}`); bad++; }
}
if (isCli) process.exit(bad ? 1 : 0);