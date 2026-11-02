// 验证「调大上限真的能多塞内容」：用真实 state 渲染不同预算/锚上限的对比。
// 用法：node scripts/probe-memory-limits.mjs [key]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { createMemoryPlugin, MAX_BUDGET_CHARS, MAX_ANCHOR_CHARS } from '../src/memory/index.js';
import { selectRoleText } from '../src/role-card.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const socialFile = path.join(ROOT, 'state', 'social-v2.json');
const conversations = (() => {
  try { return JSON.parse(fs.readFileSync(socialFile, 'utf8')).conversations ?? {}; } catch { return {}; }
})();
const key = process.argv[2] || Object.keys(conversations)[0] || 'demo:1';
const socialSt = conversations[key] ?? {};

let roleInfo = null;
try {
  const roleName = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'current-role.json'), 'utf8')).role ?? '';
  if (roleName) {
    const file = path.join(ROOT, 'roles', `${roleName}.md`);
    const stat = fs.statSync(file);
    roleInfo = { name: roleName, text: selectRoleText(fs.readFileSync(file, 'utf8'), 'v2'), stamp: `${roleName}:${stat.mtimeMs}:${stat.size}` };
  }
} catch { /* 无角色卡 */ }

const lastIncoming = [...(socialSt.unread ?? [])].reverse().find((m) => m && !m.isSelf)
  ?? [...(socialSt.recentMessages ?? [])].reverse().find((m) => m && !m.isSelf);
const cue = String(lastIncoming?.plain ?? lastIncoming?.text ?? '').slice(0, 120);

console.log(`会话: ${key}`);
console.log(`cue : ${cue || '（无）'}\n`);

// 真实记忆目录：渲染会写 accessCount，所以先整份拷到临时目录再跑，避免动线上数据。
const REAL_MEM = path.join(ROOT, 'state', 'memory');
function freshCopy() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-lim-'));
  if (fs.existsSync(REAL_MEM)) fs.cpSync(REAL_MEM, tmp, { recursive: true });
  return tmp;
}

console.log('预算对比（记忆块字符数 / 行数）：');
for (const budget of [300, 800, 1600, 2400, 4000]) {
  const tmp = freshCopy();
  const plugin = createMemoryPlugin({ stateDir: tmp, config: { budgetChars: budget }, getRoleInfo: () => roleInfo, log: () => {} });
  const block = plugin.render(key, { cue });
  const lines = block ? block.split('\n').length : 0;
  console.log(`  budget=${String(budget).padStart(4)} → ${String(block.length).padStart(4)} 字符 / ${lines} 行`);
  if (budget === 4000) console.log('\n---- 4000 预算下的实际内容 ----\n' + (block || '(空)') + '\n');
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('人设锚对比（上限 / 实际字数）：');
for (const anchorMax of [200, 400, 800, MAX_ANCHOR_CHARS]) {
  const tmp = freshCopy();
  const plugin = createMemoryPlugin({ stateDir: tmp, config: { anchorMaxChars: anchorMax }, getRoleInfo: () => roleInfo, log: () => {} });
  const anchor = plugin.renderAnchor(key);
  console.log(`  anchorMaxChars=${String(anchorMax).padStart(4)} → ${String(anchor.length).padStart(4)} 字`);
  if (anchorMax === MAX_ANCHOR_CHARS) console.log('\n---- 1200 上限下的实际锚 ----\n' + (anchor || '(空)') + '\n');
  fs.rmSync(tmp, { recursive: true, force: true });
}
