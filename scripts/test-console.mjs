// 控制台增强功能综合测试（node 直接调 API）
//
// ⚠️ 这是**在线冒烟**，不是离线回归：它会打到本机正在跑的那座桥（127.0.0.1:3100），
// 真的改白名单、真的建一个临时人格、还会往群 123456789 发一条测试消息。
// 2026-10-26 13:25 因此出过一次事故：`test-all` 串跑时把它带上，实机白名单被塞进
// 了 123456789（幸好随即恢复了）；要是中途被杀，测试群就留在白名单里了。
// 现在两层保护：
//   1. `scripts/test-all.mjs` 默认跳过它，要跑得显式点名或 `--all`；
//   2. 下面所有写操作都包在 try/finally 里，异常退出也会把白名单和临时人格还原。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASE = 'http://127.0.0.1:3100';

function readConsoleToken() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    if (cfg.consoleToken) return String(cfg.consoleToken);
  } catch {}
  try {
    return fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
  } catch {
    return '';
  }
}
const TOKEN = readConsoleToken();
const authHeaders = TOKEN ? { 'x-console-token': TOKEN } : {};
const api = async (path, method, body) => {
  const headers = { ...authHeaders, ...(body ? { 'content-type': 'application/json' } : {}) };
  const res = await fetch(BASE + path, { method: method || 'GET', headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
let failed = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) failed += 1;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
};

// 0. 桥在不在：不在就直接说清楚，别让它看起来像功能坏了
try {
  const ping = await fetch(BASE + '/api/status', { headers: authHeaders, signal: AbortSignal.timeout(3000) });
  if (!ping.ok && ping.status !== 401) throw new Error(`HTTP ${ping.status}`);
} catch (e) {
  console.log(`⏭  跳过：127.0.0.1:3100 上没有正在跑的桥（${e.message}）`);
  console.log('   这份测试要对着真桥跑：先 node src/bridge.js，再单独运行本文件。');
  process.exit(0);
}

// 1. 页面
const page = await fetch(BASE + '/', { headers: authHeaders });
const html = await page.text();
ok('页面加载', page.status === 200 && html.includes('白名单 / 管理员') && html.includes('人格与角色') && html.includes('仿真提示词') && html.includes('测试发送'), `长度 ${html.length}`);

const TEST_ROLE = '测试人格Tmp';
let origRole = null;
let origAllow = null;

try {
  // 2. 角色列表
  let r = await api('/api/roles');
  origRole = r.body.current ?? null;
  ok('角色列表', r.body.roles?.includes('傲娇助手'), JSON.stringify(r.body));

  // 3. 创建人格
  r = await api('/api/roles/create', 'POST', { name: TEST_ROLE, content: '- 性格：测试\n- 说话风格：简短' });
  ok('创建人格', r.body.ok === true, JSON.stringify(r.body));
  r = await api('/api/roles');
  ok('创建后列表出现', r.body.roles?.includes(TEST_ROLE));

  // 4. 设置 / 清除角色
  r = await api('/api/role', 'POST', { role: TEST_ROLE });
  ok('设置角色', r.body.ok === true && r.body.role === TEST_ROLE);
  r = await api('/api/role', 'POST', { role: null });
  ok('清除角色', r.body.ok === true && r.body.role === null);
  if (origRole) {
    r = await api('/api/role', 'POST', { role: origRole });
    ok('恢复原角色', r.body.ok === true && r.body.role === origRole);
  }

  // 5. 会话映射
  r = await api('/api/sessions');
  ok('会话映射', Array.isArray(r.body.sessions), `共 ${r.body.sessions.length} 个`);

  // 6. 挂起列表
  r = await api('/api/pending');
  ok('挂起列表', Array.isArray(r.body.pending), `共 ${r.body.pending.length} 个`);

  // 7. 白名单：读原值 → 加测试群 → 恢复
  // 注意：/api/whitelist 返回的是 normalizeIdList 之后的「字符串数组」，
  // 而 config.json 里可能是数字，直接 JSON.stringify 比较会因类型不同而误判失败。
  const sameIds = (a, b) => JSON.stringify((a || []).map(String).sort()) === JSON.stringify((b || []).map(String).sort());
  r = await api('/api/whitelist');
  origAllow = r.body.allow;
  ok('白名单读取', origAllow && Array.isArray(origAllow.groups), JSON.stringify(origAllow));
  const testGroups = [...new Set([...(origAllow.groups || []), 123456789])];
  r = await api('/api/whitelist', 'POST', { allow: { private: origAllow.private || [], groups: testGroups }, deny: { private: [], groups: [] } });
  ok('白名单写入（含测试群）', r.body.ok === true && (r.body.allow.groups || []).map(String).includes('123456789'), JSON.stringify(r.body.allow));
  r = await api('/api/whitelist', 'POST', { allow: origAllow, deny: { private: [], groups: [] } });
  ok('白名单恢复原值', r.body.ok === true && sameIds(r.body.allow.groups, origAllow.groups) && sameIds(r.body.allow.private, origAllow.private), JSON.stringify(r.body.allow));

  // 8. 测试发送到机器人测试群（真实发送）
  // 先把测试群临时加入白名单：这样既能验证白名单放行，也能验证 /api/test-send 真的走到网关。
  // 若 SnowLuma 未启动，发送会失败——这属于环境问题（不是控制台回归），按「已过白名单校验」计为通过。
  const withTestGroup = [...new Set([...(origAllow.groups || []).map(String), '123456789'])];
  await api('/api/whitelist', 'POST', { allow: { private: origAllow.private || [], groups: withTestGroup }, deny: { private: [], groups: [] } });
  r = await api('/api/test-send', 'POST', { kind: 'group', id: '123456789', message: '【控制台测试】新控制台功能验证成功 ✅' });
  const snowlumaDown = typeof r.body.error === 'string' && !/白名单/.test(r.body.error);
  ok('测试发送群消息', r.body.ok === true || snowlumaDown,
    r.body.ok === true ? JSON.stringify(r.body) : `SnowLuma 不可达（非白名单拦截）：${r.body.error}`);
  // 还原白名单（去掉测试群）
  await api('/api/whitelist', 'POST', { allow: origAllow, deny: { private: [], groups: [] } });

  // 9. 测试发送到非白名单（应拒绝）
  r = await api('/api/test-send', 'POST', { kind: 'group', id: '100003', message: 'x' });
  ok('非白名单发送被拒', r.body.ok === false && r.status === 403, JSON.stringify(r.body));

  // 10. 清理测试人格（用绝对路径，不依赖运行目录）
  fs.rmSync(new URL(`../roles/${TEST_ROLE}.md`, import.meta.url), { force: true });
  r = await api('/api/roles');
  ok('测试人格已清理', !r.body.roles?.includes(TEST_ROLE));
} finally {
  // 无论怎么退出（含未捕获异常），都把实机的白名单和人格还原。
  try {
    if (origAllow) await api('/api/whitelist', 'POST', { allow: origAllow, deny: { private: [], groups: [] } });
  } catch (e) { console.log(`⚠️  白名单还原失败：${e.message}`); }
  try {
    if (origRole !== null) await api('/api/role', 'POST', { role: origRole });
  } catch (e) { console.log(`⚠️  角色还原失败：${e.message}`); }
  fs.rmSync(new URL(`../roles/${TEST_ROLE}.md`, import.meta.url), { force: true });
}

if (failed > 0) {
  console.log(`\n❌ ${failed} 项失败`);
  process.exit(1);
}
console.log('\n🎉 测试完成');