// 一次性数据修正：清掉历史遗留的「私聊」脏画像，并按新算法重算人设锚。
// 用法：node scripts/fix-memory-data.mjs [--dry]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMemoryPlugin } from '../src/memory/index.js';
import { selectRoleText } from '../src/role-card.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const memDir = path.join(ROOT, 'state', 'memory');
const dry = process.argv.includes('--dry');
const BAD = new Set(['私聊', '未知', '']);

if (!fs.existsSync(memDir)) {
  console.log('没有 state/memory，跳过');
  process.exit(0);
}

// 角色卡（与 bridge 一致：先按模式选好再交给记忆模块）
let roleInfo = null;
try {
  const roleName = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'current-role.json'), 'utf8')).role ?? '';
  if (roleName) {
    const file = path.join(ROOT, 'roles', `${roleName}.md`);
    const stat = fs.statSync(file);
    roleInfo = {
      name: roleName,
      text: selectRoleText(fs.readFileSync(file, 'utf8'), 'v2'),
      stamp: `${roleName}:${stat.mtimeMs}:${stat.size}`,
    };
  }
} catch { /* 没角色卡就只清画像 */ }

const plugin = createMemoryPlugin({
  stateDir: memDir,
  config: { enabled: true, dir: 'state/memory' },
  log: () => {},
  getRoleInfo: () => roleInfo,
});

let cleanedProfiles = 0;
let refreshedAnchors = 0;

for (const entry of fs.readdirSync(memDir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
  const dir = path.join(memDir, entry.name);
  const profileFile = path.join(dir, 'profiles.json');
  const metaFile = path.join(dir, 'meta.json');
  let key = entry.name;
  try { key = JSON.parse(fs.readFileSync(metaFile, 'utf8')).key || entry.name; } catch { /* 用目录名 */ }

  // 1) 清脏画像
  let profiles = {};
  try { profiles = JSON.parse(fs.readFileSync(profileFile, 'utf8')); } catch { profiles = {}; }
  const bad = Object.keys(profiles).filter((n) => BAD.has(n));
  if (bad.length) {
    for (const n of bad) delete profiles[n];
    if (!dry) fs.writeFileSync(profileFile, JSON.stringify(profiles, null, 2) + '\n', 'utf8');
    cleanedProfiles += bad.length;
    console.log(`  ${key}: 删除脏画像 [${bad.join(', ')}]`);
  }

  // 2) 重算人设锚（stamp 带了算法版本，旧缓存必然失效 → 这里主动写回）
  if (roleInfo) {
    const before = (() => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, 'anchor.json'), 'utf8')).text ?? ''; } catch { return ''; }
    })();
    const text = plugin.renderAnchor(key);
    if (text && text !== before) {
      refreshedAnchors += 1;
      console.log(`  ${key}: 人设锚已刷新（${text.length} 字，双标点=${text.includes('。；')}）`);
    }
  }
}

console.log(`\n${dry ? '[dry-run] ' : ''}清理脏画像 ${cleanedProfiles} 条，刷新人设锚 ${refreshedAnchors} 个`);
