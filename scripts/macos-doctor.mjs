import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { discoverSnowLumaConnection, readOneBotTokens, snowLumaHomeCandidates } from '../src/snowluma-conn.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = os.homedir();
const QQ_APP = '/Applications/QQ.app';
const NAPCAT_HOME = path.join(HOME, 'Library/Containers/com.tencent.qq/Data/Documents/napcat');
const INSTALLER = path.join(HOME, 'Downloads/NapCatInstaller_arm64.amd64/NapCatInstaller.app');

const ok = (msg) => console.log(`  ✅ ${msg}`);
const warn = (msg) => console.log(`  ⚠️  ${msg}`);
const bad = (msg) => console.log(`  ❌ ${msg}`);

function portOpen(port) {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return /\bLISTEN\b/.test(out);
  } catch {
    return false;
  }
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  } catch {
    return null;
  }
}

console.log('macOS 环境');
console.log(`  架构: ${os.arch()}`);
console.log(`  Node: ${process.version}`);
console.log(`  项目: ${ROOT}`);

console.log('\nQQ / NapCat');
if (fs.existsSync(QQ_APP)) ok('已安装 /Applications/QQ.app');
else bad('未安装 /Applications/QQ.app；请先从官网安装 QQ');

if (fs.existsSync(NAPCAT_HOME)) {
  ok(`NapCat 目录存在: ${NAPCAT_HOME}`);
  if (fs.existsSync(path.join(NAPCAT_HOME, 'napcat.mjs'))) ok('NapCat 主体已解压');
  else warn('NapCat 目录存在但缺少 napcat.mjs（未完成安装）');
} else {
  warn(`未发现 NapCat 目录: ${NAPCAT_HOME}`);
}

const LOADER = path.join(HOME, 'Library/Containers/com.tencent.qq/Data/Documents/loadNapCat.js');
if (fs.existsSync(LOADER)) ok('NapCat 加载器已写入');
else warn('NapCat 加载器不存在');

try {
  const pkgPath = '/Applications/QQ.app/Contents/Resources/app/package.json';
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const resolved = path.resolve(path.dirname(pkgPath), String(pkg.main ?? ''));
  if (resolved === LOADER || (fs.existsSync(resolved) && fs.realpathSync(resolved) === fs.realpathSync(LOADER))) {
    ok('QQ 启动入口已切换到 NapCat');
  } else {
    warn(`QQ 启动入口未切换（main=${pkg.main}）`);
  }
} catch {
  warn('无法读取 QQ package.json');
}

if (fs.existsSync(INSTALLER)) warn(`已下载 NapCat 安装器: ${INSTALLER}（打开后执行安装）`);
else warn('未发现本地 NapCat 安装器；可从 https://github.com/NapNeko/NapCat-Mac-Installer/releases/latest 获取');

const homes = snowLumaHomeCandidates({ cfg: {} });
const accounts = [...new Set(homes)].flatMap((home) => readOneBotTokens(home).map((entry) => ({ ...entry, home })));
if (accounts.length === 0) {
  bad('没有找到 onebot 配置；先在 NapCat WebUI 里启用 HTTP 3000 / WebSocket 3001');
} else {
  for (const a of accounts) {
    const label = a.uin || 'default';
    console.log(`  账号 ${label}`);
    if (!a.ws) warn('  未配置 WebSocket 服务端（qq-bridge 需要它）');
    else console.log(`    WS  ws://${a.ws.host}:${a.ws.port}  token=${a.ws.token ? '已配置' : '空'}`);
    if (!a.http) warn('  未配置 HTTP 服务端（语音/表情/成员查询会退化）');
    else console.log(`    HTTP http://${a.http.host}:${a.http.port}  token=${a.http.token ? '已配置' : '空'}`);
  }
}

console.log('\n端口');
for (const port of [3000, 3001, 6099]) {
  if (portOpen(port)) ok(`${port} 正在监听`);
  else warn(`${port} 未监听`);
}

console.log('\n桥接配置');
const cfg = readConfig();
if (!cfg) {
  bad('config.json 不存在；复制 config.example.json 后填写 dsh 与 allow 白名单');
} else {
  const ob = { ...(cfg.snowluma ?? {}), ...(cfg.onebot ?? {}) };
  console.log(`  OneBot WS:   ${ob.wsUrl ?? '(默认)'}`);
  console.log(`  OneBot HTTP: ${ob.httpUrl ?? '(默认)'}`);
  console.log(`  DSH:         ${cfg.dsh?.baseUrl ?? '(默认)'}`);
  const privateIds = Array.isArray(cfg.allow?.private) ? cfg.allow.private.length : 0;
  const groupIds = Array.isArray(cfg.allow?.groups) ? cfg.allow.groups.length : 0;
  if (privateIds + groupIds > 0) ok(`白名单: 私聊 ${privateIds} / 群 ${groupIds}`);
  else warn('白名单为空：默认不会响应任何消息');
  if (cfg.ownerQQ) ok(`管理员 QQ: ${cfg.ownerQQ}`); else warn('未配置 ownerQQ');
}

console.log('\n自动发现');
try {
  const r = await discoverSnowLumaConnection({ cfg: cfg ?? {}, timeoutMs: 3000 });
  if (r.ok) {
    ok(`可用账号 ${r.self?.user_id ?? '?'}（${r.self?.nickname ?? '无昵称'}）`);
    if (r.wsUrl) ok(`WS: ${r.wsUrl}`);
    else warn('找到了 HTTP，但同账号没有 WS 配置');
  } else {
    bad(r.error ?? '未发现可用连接');
  }
} catch (error) {
  bad(error?.message ?? String(error));
}

console.log('\n下一步');
console.log('  1. 打开 /Applications/QQ.app 登录 QQ（NapCat 入口）');
console.log('  2. 在 NapCat WebUI 启用 HTTP 3000 和 WebSocket 3001');
console.log('  3. 运行 ./start-macos.command');
