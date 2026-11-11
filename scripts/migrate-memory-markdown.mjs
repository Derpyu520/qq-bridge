// 一次性迁移：把已有的 events-*.jsonl 重建为可读的 MEMORY.md + index.json。
// 用法：node scripts/migrate-memory-markdown.mjs [--dry]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { rebuildMemoryMarkdown, MEMORY_MD } from '../src/memory/markdown.js';
import { readJsonl } from '../src/memory/util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const memDir = path.join(ROOT, 'state', 'memory');
const dry = process.argv.includes('--dry');

if (!fs.existsSync(memDir)) {
  console.log('没有 state/memory，跳过');
  process.exit(0);
}

let done = 0;
let skipped = 0;
for (const entry of fs.readdirSync(memDir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
  const dir = path.join(memDir, entry.name);
  const files = fs.readdirSync(dir).filter((n) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort();
  const events = [];
  for (const f of files) {
    for (const ev of readJsonl(path.join(dir, f), () => {})) {
      if (ev && Number(ev.t)) events.push(ev);
    }
  }
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch { /* 忽略 */ }
  const key = meta.key || entry.name;

  const hasMd = fs.existsSync(path.join(dir, MEMORY_MD));
  if (!events.length) {
    skipped += 1;
    console.log(`  ${key}: 无事件，跳过`);
    continue;
  }
  if (dry) {
    console.log(`  ${key}: 将重建 ${events.length} 条${hasMd ? '（已有 MEMORY.md，会覆盖）' : ''}`);
    done += 1;
    continue;
  }
  const result = rebuildMemoryMarkdown(dir, events);
  const index = { version: 1, entries: {}, nextSeq: 1 };
  [...events].sort((a, b) => Number(b.t) - Number(a.t)).forEach((ev, i) => {
    index.entries[i + 1] = { t: ev.t, seq: i + 1, sender: ev.sender, isSelf: ev.isSelf, kind: ev.kind };
  });
  index.nextSeq = events.length + 1;
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index, null, 2) + '\n', 'utf8');
  done += 1;
  console.log(`  ${key}: 重建完成（${events.length} 条，${result.chars} 字符）`);
}

console.log(`\n${dry ? '[dry-run] ' : ''}处理 ${done} 个会话，跳过 ${skipped} 个`);
