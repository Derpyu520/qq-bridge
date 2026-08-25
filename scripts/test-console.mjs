// 控制台增强功能综合测试（node 直接调 API）
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

// 1. 页面
const page = await fetch(BASE + '/', { headers: authHeaders });
const html = await page.text();
ok('页面加载', page.status === 200 && html.includes('白名单 / 管理员') && html.includes('人格（角色扮演）') && html.includes('测试发送'), `长度 ${html.length}`);

// 2. 角色列表
let r = await api('/api/roles');
const origRole = r.body.current ?? null;
ok('角色列表', r.body.roles?.includes('傲娇助手'), JSON.stringify(r.body));

// 3. 创建人格
const TEST_ROLE = '测试人格Tmp';
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
r = await api('/api/whitelist');
const origAllow = r.body.allow;
ok('白名单读取', origAllow && Array.isArray(origAllow.groups), JSON.stringify(origAllow));
const testGroups = [...new Set([...(origAllow.groups || []), 123456789])];
r = await api('/api/whitelist', 'POST', { allow: { private: origAllow.private || [], groups: testGroups }, deny: { private: [], groups: [] } });
ok('白名单写入（含测试群）', r.body.ok === true && r.body.allow.groups.includes(123456789), JSON.stringify(r.body.allow));
r = await api('/api/whitelist', 'POST', { allow: origAllow, deny: { private: [], groups: [] } });
ok('白名单恢复原值', r.body.ok === true && JSON.stringify(r.body.allow) === JSON.stringify(origAllow));

// 8. 测试发送到机器人测试群（真实发送）
r = await api('/api/test-send', 'POST', { kind: 'group', id: '123456789', message: '【控制台测试】新控制台功能验证成功 ✅' });
ok('测试发送群消息', r.body.ok === true, JSON.stringify(r.body));

// 9. 测试发送到非白名单（应拒绝）
r = await api('/api/test-send', 'POST', { kind: 'group', id: '987654321', message: 'x' });
ok('非白名单发送被拒', r.body.ok === false && r.status === 403, JSON.stringify(r.body));

// 10. 清理测试人格（用绝对路径，不依赖运行目录）
fs.rmSync(new URL(`../roles/${TEST_ROLE}.md`, import.meta.url), { force: true });
r = await api('/api/roles');
ok('测试人格已清理', !r.body.roles?.includes(TEST_ROLE));

if (failed > 0) {
  console.log(`\n❌ ${failed} 项失败`);
  process.exit(1);
}
console.log('\n🎉 测试完成');
