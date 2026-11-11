#!/usr/bin/env node
// 把旧版 roles/*.md 人格卡迁移成 roles/*.json（不修改 README.md）。
//
// 用法：
//   node scripts/ops/convert-role-cards.mjs                 # 转换，保留 .md
//   node scripts/ops/convert-role-cards.mjs --delete-md     # 转换成功后删除旧 .md
//   node scripts/ops/convert-role-cards.mjs --force         # 覆盖已存在的 .json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { roleCardFromText, roleCardToJson } from '../../src/text/role-card.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROLES = path.join(ROOT, 'roles');
const deleteMd = process.argv.includes('--delete-md');
const force = process.argv.includes('--force');

if (!fs.existsSync(ROLES)) {
  console.error(`roles/ 不存在：${ROLES}`);
  process.exit(1);
}

let converted = 0; let skipped = 0; let removed = 0;
for (const file of fs.readdirSync(ROLES).sort()) {
  if (!file.endsWith('.md') || file === 'README.md') continue;
  const name = file.slice(0, -3);
  const source = path.join(ROLES, file);
  const target = path.join(ROLES, `${name}.json`);
  if (fs.existsSync(target) && !force) { skipped += 1; console.log(`跳过 ${file}：${name}.json 已存在（--force 覆盖）`); continue; }
  const card = roleCardFromText(fs.readFileSync(source, 'utf8'));
  fs.writeFileSync(target, roleCardToJson(card), { encoding: 'utf8', mode: 0o644 });
  converted += 1;
  console.log(`转换 ${file} → ${name}.json（${card.sections.length} 个小节）`);
  if (deleteMd) { fs.rmSync(source); removed += 1; }
}
console.log(`\n完成：转换 ${converted}，跳过 ${skipped}，删除 .md ${removed}`);
