// 记忆插件离线探针：拿真实的 state/social-v2.json 做一次迁移 + 渲染，看看注入块长什么样。
// 不写真实 state：记忆落在系统临时目录，只读 social-v2.json 与 roles/。
// 跑法：node scripts/probe-memory.mjs  （可带 key：node scripts/probe-memory.mjs group:123）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMemoryPlugin } from '../src/memory/index.js';
import { selectRoleText } from '../src/role-card.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const socialFile = path.join(ROOT, 'state', 'social-v2.json');
const rolesDir = path.join(ROOT, 'roles');

const cfgFile = path.join(ROOT, 'config.json');
let memoryCfg = {};
try {
  memoryCfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')).memory ?? {};
} catch { /* 用默认配置 */ }

let conversations = {};
try {
  conversations = JSON.parse(fs.readFileSync(socialFile, 'utf8')).conversations ?? {};
} catch {
  // 新克隆/干净环境没有 state/ 是正常的：用空会话演示人设锚与空记忆块。
  conversations = {};
}

const explicitKey = process.argv[2];
const key = explicitKey || Object.keys(conversations).find((k) => /^(group|private):\d+$/.test(k)) || 'demo:10001';
if (!explicitKey && !Object.keys(conversations).length) {
  console.log('（没有 state/social-v2.json，使用空演示会话：仅验证人设锚与空注入块）');
}
const socialSt = conversations[key] ?? {};

// 当前角色卡
const roleFile = path.join(ROOT, 'state', 'current-role.json');
let roleName = '';
try { roleName = JSON.parse(fs.readFileSync(roleFile, 'utf8')).role ?? ''; } catch { /* 无角色 */ }
let roleText = '';
let stamp = roleName;
if (roleName) {
  const file = path.join(rolesDir, `${roleName}.md`);
  try {
    const stat = fs.statSync(file);
    // 与 bridge 一致：传"已按二代模式选好"的文本（记忆模块不依赖 role-card.js）。
    roleText = selectRoleText(fs.readFileSync(file, 'utf8'), 'v2');
    stamp = `${roleName}:${stat.mtimeMs}:${stat.size}`;
  } catch { /* 角色卡不存在 */ }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-probe-'));
const plugin = createMemoryPlugin({
  stateDir: tmp,
  config: { ...memoryCfg, enabled: true },
  log: (line) => console.log(`[log] ${line}`),
  getRoleInfo: () => (roleText ? { name: roleName, text: roleText, stamp } : null),
});

console.log(`\n会话 key：${key}`);
const lastIncoming = [...(socialSt.unread ?? [])].reverse().find((m) => m && !m.isSelf)
  ?? [...(socialSt.recentMessages ?? [])].reverse().find((m) => m && !m.isSelf);
const cue = String(lastIncoming?.plain ?? lastIncoming?.text ?? '').slice(0, 120);
console.log(`cue（最近一条别人的话）：${cue || '（无）'}\n`);

plugin.render(key, { cue, socialSt });
const anchor = plugin.renderAnchor(key);
console.log(`迁移/画像后的 stats：${JSON.stringify(plugin.stats(key))}`);

console.log(`\n──── 人设锚（${anchor.length} 字）────\n${anchor || '（无人格卡）'}`);

const block = plugin.render(key, { cue, socialSt });
console.log(`\n──── 记忆注入块（${block.length} 字）────\n${block || '（空）'}`);
console.log(`\n──── 相关回忆 query ────\n${JSON.stringify(plugin.query(key, cue, 3), null, 2)}`);

fs.rmSync(tmp, { recursive: true, force: true });
