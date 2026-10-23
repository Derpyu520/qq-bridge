// SnowLuma 账号/token 自发现自检。
//
// 背景（实测确认的根因）：SnowLuma 的 OneBot 配置按账号分文件
// （<SnowLuma>/config/onebot_<QQ号>.json），每个账号一个 token，HTTP 与 WS 还各不相同。
// 换 QQ 账号登录后，任何把 token 写死在 config.json 里的工具都会 401 ——
// 这正是"换个账号登录，发语音工具就不行了"的原因。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  discoverSnowLumaConnection, persistToken, readOneBotHttpTokens, readOneBotTokens, snowLumaHomeCandidates
} from '../src/snowluma-conn.js';
// 独立发语音工具在仓库上一级（不在本仓库里）：位置解析与"不在时怎么跳过"走共享口径。
import { hasVoiceTool, skipVoiceTool, voiceToolPath } from './voice-tool-locator.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; console.error(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};
// 工具不在本仓库里时返回 null，让下面几条桥接侧断言仍能照跑（读源码不该因为
// 一个不在仓库里的目录而整个抛掉）。
const readTool = (rel) => (hasVoiceTool() ? fs.readFileSync(voiceToolPath(rel), 'utf8') : null);

console.log('## home 目录推断');
{
  const homes = snowLumaHomeCandidates({ cfg: { snowluma: { homeDir: 'X:/sl', launcherPath: 'X:/sl2/launcher.bat' } } });
  ok(homes.includes('X:/sl'), '优先用 homeDir');
  ok(homes.some((h) => h.replace(/\\/g, '/') === 'X:/sl2'), '其次用 launcherPath 所在目录');
  ok(snowLumaHomeCandidates({ cfg: {} }).length >= 0, '无配置时返回空或环境变量值（不抛错）');
}

console.log('## per-account token 解析（用临时目录造多账号场景）');
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-home-'));
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  const write = (uin, httpToken, port = 3000, wsToken = 'ws-' + uin) => fs.writeFileSync(
    path.join(home, 'config', `onebot_${uin}.json`),
    JSON.stringify({ networks: { httpServers: [{ name: 'http-default', accessToken: httpToken, host: '127.0.0.1', port }], wsServers: [{ accessToken: wsToken, port: 3001 }] } }),
    'utf8'
  );
  write('111', 'token-aaa');
  write('222', 'token-bbb');
  fs.writeFileSync(path.join(home, 'config', 'onebot_broken.json'), '{ not json', 'utf8');
  fs.writeFileSync(path.join(home, 'config', 'runtime.json'), '{}', 'utf8');

  const toks = readOneBotTokens(home);
  ok(toks.length === 2, '只解析出 onebot_<数字>.json', `得到 ${toks.length} 个`);
  ok(toks[0].uin === '111' && toks[1].uin === '222', '按 uin 稳定排序');
  ok(toks.every((t) => t.http?.token?.startsWith('token-')), 'HTTP token 取自 httpServers');
  ok(toks.every((t) => t.ws?.token?.startsWith('ws-')), 'WS token 取自 wsServers（与 HTTP 不同！）');
  ok(toks.every((t) => t.http.token !== t.ws.token), '两个 token 确实不同（不能混用的证据）');
  ok(toks.every((t) => t.http.port === 3000 && t.ws.port === 3001), '端口分别是 3000 / 3001');

  const flat = readOneBotHttpTokens(home);
  ok(flat.length === 2 && flat[0].token === 'token-aaa', 'readOneBotHttpTokens 兼容扁平形态');

  console.log('## 自动发现：按"谁能用"选择，而不是猜');
  // 用一个假 fetch 模拟：只有 token-bbb 有效
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const tk = String(init?.headers?.authorization ?? '').replace('Bearer ', '');
    if (tk === 'token-bbb') {
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { user_id: 222, nickname: '第二账号' } }) };
    }
    return { ok: false, status: 401, json: async () => ({ status: 'failed', retcode: 1401, wording: 'unauthorized' }) };
  };
  try {
    const r = await discoverSnowLumaConnection({ cfg: {}, baseUrl: 'http://127.0.0.1:3000', homeDirs: [home], timeoutMs: 500 });
    ok(r.ok === true, '发现成功');
    ok(r.token === 'token-bbb', '选中了有效的那个 token', r.token);
    ok(r.self?.user_id === 222, '回报当前账号', String(r.self?.user_id));
    ok(r.source === 'onebot_222.json', '标明 token 来源', r.source);
    ok(r.tried.length === 2, '记录了尝试过的候选', `${r.tried.length} 个`);

    // 全部无效时要给出可操作错误
    globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ status: 'failed', retcode: 1401 }) });
    const bad = await discoverSnowLumaConnection({ cfg: {}, baseUrl: 'http://127.0.0.1:3000', homeDirs: [home], timeoutMs: 300 });
    ok(bad.ok === false, '全部失效时失败');
    ok(/401|token/.test(bad.error), '错误信息指出 token 问题', bad.error.slice(0, 40));
  } finally {
    globalThis.fetch = realFetch;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

console.log('## NapCat 配置解析（macOS）');
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'napcat-home-'));
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config', 'onebot11_333.json'), JSON.stringify({
    network: {
      httpServers: [{ enable: true, host: '0.0.0.0', port: 3000, token: 'http-napcat' }],
      websocketServers: [{ enable: true, host: '::', port: 3001, token: 'ws-napcat' }]
    }
  }), 'utf8');
  fs.writeFileSync(path.join(home, 'config', 'onebot11.json'), JSON.stringify({
    network: {
      httpServers: [{ enable: false, host: '127.0.0.1', port: 4000, token: 'off' }, { enable: true, host: '127.0.0.1', port: 4001, token: 'http-default' }],
      websocketServers: [{ host: '127.0.0.1', port: 4002, token: 'ws-default' }]
    }
  }), 'utf8');

  const toks = readOneBotTokens(home);
  ok(toks.length === 2, '解析 onebot11_<uin>.json 与 onebot11.json', `得到 ${toks.length} 个`);
  const uin = toks.find((t) => t.uin === '333');
  ok(uin?.http?.token === 'http-napcat', 'NapCat HTTP token 取自 httpServers[].token');
  ok(uin?.ws?.token === 'ws-napcat', 'NapCat WS token 取自 websocketServers[].token');
  ok(uin?.http?.host === '127.0.0.1' && uin?.ws?.host === '127.0.0.1', '0.0.0.0 / :: 归一化到 127.0.0.1');
  const def = toks.find((t) => t.uin === '');
  ok(def?.http?.token === 'http-default', '默认配置跳过 enable=false 的服务器');
  ok(def?.http?.port === 4001 && def?.ws?.port === 4002, '默认配置读取自定义端口');

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const tk = String(init?.headers?.authorization ?? '').replace('Bearer ', '');
    if (tk === 'http-napcat') {
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { user_id: 333, nickname: 'NapCat' } }) };
    }
    return { ok: false, status: 401, json: async () => ({ status: 'failed', retcode: 1401 }) };
  };
  try {
    const r = await discoverSnowLumaConnection({ cfg: {}, baseUrl: 'http://127.0.0.1:3000', homeDirs: [home], timeoutMs: 500 });
    ok(r.ok === true && r.self?.user_id === 333, 'NapCat 账号自动发现成功');
    ok(r.wsToken === 'ws-napcat' && r.wsUrl === 'ws://127.0.0.1:3001', '带回同账号的 NapCat WS token/URL', `${r.wsToken} ${r.wsUrl}`);
  } finally {
    globalThis.fetch = realFetch;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

console.log('## token 写回 config.json');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-cfg-'));
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ snowluma: { httpUrl: 'http://127.0.0.1:3000', accessToken: 'old-token' }, allow: { groups: [1] } }, null, 2), 'utf8');
  const r1 = persistToken(cfgPath, 'new-token');
  ok(r1.updated === true && r1.from === 'old-token', '换 token 时写入');
  const after = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  ok(after.snowluma.accessToken === 'new-token', 'config.json 已更新');
  ok(after.allow.groups[0] === 1, '其它配置字段未被破坏');
  const r2 = persistToken(cfgPath, 'new-token');
  ok(r2.updated === false, 'token 未变时不重复写（幂等）');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('## onebot 配置段兼容');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onebot-cfg-'));
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ onebot: { httpUrl: 'http://127.0.0.1:6000', accessToken: 'old' }, snowluma: { accessToken: 'stale' } }, null, 2), 'utf8');
  const r = persistToken(cfgPath, 'new');
  const after = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  ok(r.updated === true && after.onebot.accessToken === 'new', '存在 onebot 段时写回 onebot');
  ok(after.snowluma.accessToken === 'stale', '不误改 snowluma 段');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('## 独立工具确实用它（源码级）');
{
  // 独立工具的入口文件在仓库上一级的 voice-tool/；共享内核仍是本仓库 src/snowluma-conn.js
  for (const rel of ['voice-cli.mjs', 'voice-gui.mjs']) {
    const src = readTool(rel);
    if (src === null) { skipVoiceTool(`${rel} 是否引入自发现模块（snowluma-conn.js / discoverSnowLumaConnection）`); continue; }
    ok(/snowluma-conn\.js/.test(src), `${rel} 引入自发现模块`);
    ok(/discoverSnowLumaConnection/.test(src), `${rel} 调用自动发现`);
  }
  // ↓ 下面两条查的是本仓库的 bridge.js，与工具在不在无关，照跑。
  const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  ok(/healTokenIfStale/.test(bridge), 'bridge 有 token 自愈');
  ok(/persistToken/.test(bridge), 'bridge 会把有效 token 写回 config.json');
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
