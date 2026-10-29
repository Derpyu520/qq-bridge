// 自检：DSH 桌面 profile 里是否还有 mcp-snowluma 条目。
//
// 背景：安装/更新插件（例如 dsh-qqbot）会重写 profile 的 cordis.patch.yml，
// 把 setup-dsh.mjs 写进去的 3 个 MCP 条目冲掉。冲掉之后模型调 qq_send_message
// 会被 DSH 判成 unknown tool，于是它只写内心戏、群里什么也看不到。
//
// 退出码：0 = 正常；1 = 缺少条目（start.bat 会自动跑 setup-dsh.mjs desktop 修复）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const PROFILE = process.env.DSH_PROFILE || 'desktop';
const file = path.join(DSH_HOME, 'profiles', PROFILE, 'cordis.patch.yml');

const REQUIRED = ['mcp-snowluma', 'mcp-web-search-safe'];

if (!fs.existsSync(file)) {
  console.error(`[check-mcp] 找不到 ${file}`);
  process.exit(1);
}

let doc;
try {
  doc = yaml.load(fs.readFileSync(file, 'utf8')) ?? [];
} catch (error) {
  console.error(`[check-mcp] YAML 解析失败：${error.message}`);
  process.exit(1);
}

const ids = new Set();
for (const op of Array.isArray(doc) ? doc : []) {
  if (op && Array.isArray(op.insert)) for (const item of op.insert) if (item?.id) ids.add(item.id);
}

const missing = REQUIRED.filter((id) => !ids.has(id));
if (missing.length) {
  console.log(`[check-mcp] 缺少 MCP 条目：${missing.join(', ')}`);
  process.exit(1);
}
console.log(`[check-mcp] OK（${REQUIRED.join(', ')} 都在）`);
process.exit(0);
