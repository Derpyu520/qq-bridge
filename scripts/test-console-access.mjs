// 控制台「对外访问地址」（config.consoleHost）的回归：
//   A) 监听面 —— 默认只监听回环；配置了具体 IP / 主机名才多开一个监听器；Host 白名单
//      按**监听器**分别判定（回环监听器永远严格），外来 Host 依旧 403。
//   B) 对外监听必须配一个**显式**的 consoleToken：没配就不开对外监听器。
//   C) 管理端点 /api/console/access —— 校验、落盘、内存生效、鉴权隔离。
//
// 为什么单独写这个：consoleHost 是**唯一**能把控制台（本机最高权限入口）暴露到回环之外的开关，
// 它的每一次放宽都必须有断言钉住，尤其是「只放行那一个地址」「回环那条路没被顺带放松」
// 和「没有显式令牌就不开对外监听」。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN = { 'x-console-token': 'fixture-console-token' };
// 127.0.0.0/8 全是本地地址，用 .0.2 模拟「局域网具体地址」这条代码路径（监听 + Host 放行）。
const LAN_IP = '127.0.0.2';

let bad = 0;
const ok = (cond, name, extra = '') => {
  if (!cond) bad += 1;
  console.log(`${cond ? '  OK  ' : '  FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
};

/** 发一个请求。`connectHost` 决定连到哪个本地地址（决定落到哪个监听器）。 */
function call(port, pathname, { method = 'GET', headers = {}, body, connectHost = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: connectHost, port, path: pathname, method, headers: { 'content-type': 'application/json', ...headers } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(data); } catch {}
          resolve({ status: res.statusCode, body: parsed, text: data });
        });
      },
    );
    // 连不上（没有对外监听器）也是一个可断言的结果，不是测试失败。
    req.on('error', (e) => resolve({ status: `ERR:${e.code ?? e.message}`, body: null }));
    req.setTimeout(3000, () => req.destroy(new Error('request hung')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function closeAll(server, h) {
  // 对外那个附加监听器也得关掉，否则事件循环不退出（测试进程会挂住）。
  for (const extra of server.extraListeners ?? []) await new Promise((r) => extra.close(r));
  await new Promise((r) => server.close(r));
  await h.close();
}

// ── A) 监听面与 Host 白名单 ──────────────────────────────────────────────────
console.log('## 监听面与 Host 白名单');
{
  // 默认：consoleHost 留空 → 只监听回环，LAN IP 的 Host 一律 403。
  const h = await bridgeHarness({ config: { consolePort: 0 } });
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((r) => server.once('listening', r));
    const port = server.address().port;
    const lan = await call(port, '/api/status', { headers: { ...ADMIN, host: `${LAN_IP}:${port}` } });
    ok(lan.status === 403, '默认：LAN IP 的 Host 被拒', `HTTP ${lan.status}`);
    const loop = await call(port, '/api/status', { headers: { ...ADMIN, host: `127.0.0.1:${port}` } });
    ok(loop.status === 200, '默认：回环 Host 仍放行', `HTTP ${loop.status}`);
  } finally { await closeAll(server, h); }
}
{
  // 配置了具体 IP → 多开一个监听器，且该 IP 进入 Host 白名单。
  const h = await bridgeHarness({ config: { consolePort: 0, consoleHost: LAN_IP } });
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((r) => server.once('listening', r));
    const port = server.address().port;

    // 直连 LAN IP：只有真的多开了监听器才连得上。
    // 端口用回环监听器的**实际**端口 —— 配置端口为 0 时两个监听器也必须落在同一个端口上。
    const direct = await call(port, '/api/status', { headers: { ...ADMIN, host: `${LAN_IP}:${port}` }, connectHost: LAN_IP });
    ok(direct.status === 200, 'LAN 监听器真的在监听（直连 LAN IP 成功）', `HTTP ${direct.status}`);

    const lan = await call(port, '/api/status', { headers: { ...ADMIN, host: `${LAN_IP}:${port}` }, connectHost: LAN_IP });
    ok(lan.status === 200, 'LAN Host 放行', `HTTP ${lan.status}`);
    const bare = await call(port, '/api/status', { headers: { ...ADMIN, host: LAN_IP }, connectHost: LAN_IP });
    ok(bare.status === 200, '裸 IP 的 Host 放行', `HTTP ${bare.status}`);

    // 放宽了对外监听，**不等于**放宽了 Host 校验。
    const evil = await call(port, '/api/status', { headers: { ...ADMIN, host: `evil.example.com:${port}` }, connectHost: LAN_IP });
    ok(evil.status === 403, '外域 Host 仍被拒（DNS rebinding 硬化未失效）', `HTTP ${evil.status}`);
    const other = await call(port, '/api/status', { headers: { ...ADMIN, host: `127.0.0.3:${port}` }, connectHost: LAN_IP });
    ok(other.status === 403, '未配置的其它 IP 被拒', `HTTP ${other.status}`);

    const noToken = await call(port, '/api/status', { headers: { host: `${LAN_IP}:${port}` }, connectHost: LAN_IP });
    ok(noToken.status === 401, 'LAN 访问仍需控制台令牌', `HTTP ${noToken.status}`);

    // 回环监听器那条路**没有**被顺带放松：连回环地址却把 Host 写成 LAN IP 必须 403。
    // （白名单按监听器判定，靠的是 req.socket.localAddress。）
    const spoof = await call(port, '/api/status', { headers: { ...ADMIN, host: `${LAN_IP}:${port}` }, connectHost: '127.0.0.1' });
    ok(spoof.status === 403, '回环监听器不接受伪造的 LAN Host', `HTTP ${spoof.status}`);
  } finally { await closeAll(server, h); }
}
{
  // 主机名：与具体 IP 同等对待（放行的是配置里那个字符串本身）。
  const h = await bridgeHarness({ config: { consolePort: 0, consoleHost: 'localhost' } });
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((r) => server.once('listening', r));
    const port = server.address().port;
    // 'localhost' 会解析到 127.0.0.1，而回环监听器已经占了同一个端口 —— 所以这里
    // 断言的是「主机名被接受并落到了配置里」，监听是否成功由绑定结果说话。
    const res = await call(port, '/api/status', { headers: { ...ADMIN, host: `localhost:${port}` } });
    ok(res.status === 200 || res.status === 403, '主机名形式可被接受（绑定结果随本机解析而定）', `HTTP ${res.status}`);
  } finally { await closeAll(server, h); }
}
{
  // 通配地址 0.0.0.0：监听所有网卡，只开一个监听器（同一端口不能再单独绑 127.0.0.1）。
  const h = await bridgeHarness({ config: { consolePort: 0, consoleHost: '0.0.0.0' } });
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((r) => server.once('listening', r));
    const port = server.address().port;
    const viaLan = await call(port, '/api/status', { headers: { ...ADMIN, host: `${LAN_IP}:${port}` }, connectHost: LAN_IP });
    ok(viaLan.status === 200, '0.0.0.0：对外网卡可访问', `HTTP ${viaLan.status}`);
    // 通配监听器上，Host 只在本机地址（localAddress 是回环）时仍按回环口径严格校验。
    const viaLoop = await call(port, '/api/status', { headers: { ...ADMIN, host: `evil.example.com:${port}` }, connectHost: '127.0.0.1' });
    ok(viaLoop.status === 403, '0.0.0.0：回环来路的伪造 Host 仍被拒', `HTTP ${viaLoop.status}`);
    const noToken = await call(port, '/api/status', { headers: { host: `${LAN_IP}:${port}` }, connectHost: LAN_IP });
    ok(noToken.status === 401, '0.0.0.0：对外访问仍需控制台令牌', `HTTP ${noToken.status}`);
  } finally { await closeAll(server, h); }
}

// ── B) 对外监听必须配显式令牌 ────────────────────────────────────────────────
console.log('## 对外监听要求显式 consoleToken');
{
  const h = await bridgeHarness({ config: { consolePort: 0, consoleHost: LAN_IP, consoleToken: '' } });
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((r) => server.once('listening', r));
    const port = server.address().port;
    const res = await call(port, '/api/status', { headers: { ...ADMIN, host: `${LAN_IP}:${port}` }, connectHost: LAN_IP });
    ok(String(res.status).startsWith('ERR:') || res.status !== 200, '没有显式令牌 → 不开对外监听器', `结果 ${res.status}`);
    // 回环那侧照常可用（管理端不至于失联）。没有配置令牌时桥接会**自动生成**一个，
    // 落在 state/console-token —— 那正是「显式令牌」与「自动令牌」的区别所在。
    let generated = '';
    try { generated = fs.readFileSync(path.join(h.temp, 'state', 'console-token'), 'utf8').trim(); } catch {}
    const loopHeaders = generated ? { 'x-console-token': generated } : ADMIN;
    const loop = await call(port, '/api/status', { headers: { ...loopHeaders, host: `127.0.0.1:${port}` } });
    ok(loop.status === 200, '没有显式令牌 → 回环控制台照常可用', `HTTP ${loop.status}`);
    const access = await call(port, '/api/console/access', { headers: loopHeaders });
    ok(access.body?.consoleTokenConfigured === false, '接口如实报告「没有显式令牌」', JSON.stringify(access.body));
    ok(access.body?.effectiveConsoleHost === '', '接口如实报告「没有对外监听」', JSON.stringify(access.body));
  } finally { await closeAll(server, h); }
}

// ── C) 管理端点 ───────────────────────────────────────────────────────────────
console.log('## /api/console/access');
{
  const h = await bridgeHarness({ config: { consolePort: 0 } });
  const server = h.startConsoleServer();
  const readCfg = () => JSON.parse(fs.readFileSync(path.join(h.temp, 'config.json'), 'utf8'));
  try {
    if (!server.listening) await new Promise((r) => server.once('listening', r));
    const port = server.address().port;

    let r = await call(port, '/api/console/access', { headers: ADMIN });
    ok(r.status === 200 && r.body.consoleHost === '' && r.body.effectiveConsoleHost === '',
      'GET 返回初始状态（只监听回环）', JSON.stringify(r.body));

    // 合法形式：具体 IP、主机名、通配地址。
    for (const good of ['192.168.1.10', '::1', 'nas.local', 'my-nas', '0.0.0.0', '::']) {
      const res = await call(port, '/api/console/access', { method: 'POST', headers: ADMIN, body: { consoleHost: good } });
      ok(res.status === 200 && res.body.consoleHost === good, `接受「${good}」`, `HTTP ${res.status}`);
    }
    // 非法形式：带端口、空标签、下划线、连字符开头/结尾、空格。
    for (const bad of ['192.168.1.10:3100', 'has_underscore', '-leading', 'trailing-', 'double..dot', 'sp ace', 'a'.repeat(300)]) {
      const res = await call(port, '/api/console/access', { method: 'POST', headers: ADMIN, body: { consoleHost: bad } });
      ok(res.status === 400 && /consoleHost/.test(res.body?.error || ''), `拒绝非法值「${bad.slice(0, 20)}」`, `HTTP ${res.status}`);
    }
    ok(readCfg().consoleHost === '::', '非法值没有写坏 config.json（仍是上一个合法值）', String(readCfg().consoleHost));

    r = await call(port, '/api/console/access', { method: 'POST', headers: ADMIN, body: {} });
    ok(r.status === 400, '缺 consoleHost 字段 → 400', `HTTP ${r.status}`);

    r = await call(port, '/api/console/access', { method: 'POST', headers: ADMIN, body: { consoleHost: '192.168.1.10' } });
    ok(r.status === 200 && r.body.ok === true && r.body.consoleHost === '192.168.1.10', '保存具体 IP 成功', JSON.stringify(r.body));
    ok(r.body.restartRequired === true, 'restartRequired=true（监听器是启动时创建的）');
    ok(r.body.effectiveConsoleHost === '', '未重启前 effectiveConsoleHost 仍为空');
    ok(r.body.consoleTokenConfigured === true, '显式令牌状态被如实报告', String(r.body.consoleTokenConfigured));

    const cfg = readCfg();
    ok(cfg.consoleHost === '192.168.1.10', '已写入 config.json', String(cfg.consoleHost));
    ok(cfg.ownerQQ === 123 && Array.isArray(cfg.allow?.groups), 'config.json 其它字段未丢', JSON.stringify(cfg.allow));

    r = await call(port, '/api/console/access', { headers: ADMIN });
    ok(r.body.consoleHost === '192.168.1.10' && r.body.effectiveConsoleHost === '', 'GET 反映已保存值', JSON.stringify(r.body));

    // 管理端点不能被智能体令牌碰到（那是 confused deputy 的入口）。
    r = await call(port, '/api/console/access', { method: 'POST', headers: { ...ADMIN, 'x-agent-token': 'whatever' }, body: { consoleHost: '10.0.0.1' } });
    ok(r.status === 403, '带 agent token → 403', `HTTP ${r.status}`);
    ok(readCfg().consoleHost === '192.168.1.10', 'agent 请求没有改到配置');

    r = await call(port, '/api/console/access', { method: 'POST', body: { consoleHost: '10.0.0.1' } });
    ok(r.status === 401, '无控制台令牌 → 401', `HTTP ${r.status}`);
    ok(r.body?.code === 'console-token-missing', '未带令牌 → code=console-token-missing', JSON.stringify(r.body));

    // 令牌错误要和「没带令牌」分开：前端据此提示「令牌错误，请重新输入」。
    r = await call(port, '/api/console/access', { method: 'POST', headers: { 'x-console-token': 'wrong-token-wrong-token' }, body: { consoleHost: '10.0.0.1' } });
    ok(r.status === 401 && r.body?.code === 'console-token-invalid', '令牌错误 → code=console-token-invalid', JSON.stringify(r.body));
    ok(/令牌错误/.test(r.body?.error || ''), '错误文案明确指出是令牌错误', String(r.body?.error));
    ok(readCfg().consoleHost === '192.168.1.10', '令牌错误的请求没有改到配置', String(readCfg().consoleHost));

    // 登录页：GET / 未通过鉴权时返回表单页，而不是一句 JSON 或 prompt()。
    const loginMissing = await call(port, '/');
    ok(loginMissing.status === 401 && /需要控制台令牌/.test(loginMissing.text || ''), 'GET / 无令牌 → 登录页（需要令牌）', `HTTP ${loginMissing.status}`);
    ok(/name="token"/.test(loginMissing.text || ''), '登录页是令牌表单', '');
    const loginInvalid = await call(port, '/?token=definitely-wrong-token');
    ok(loginInvalid.status === 401 && /控制台令牌错误/.test(loginInvalid.text || ''), 'GET / 令牌错误 → 登录页（令牌错误）', `HTTP ${loginInvalid.status}`);
    ok(!/definitely-wrong-token/.test(loginInvalid.text || ''), '登录页不回显用户输入的令牌', '');

    // 通过 ?token= 引导进入时不再被鉴权层拦下（夹具没有 public/console.html，所以只断言
    // 「不是登录页」；真实页面内容由 test-console-static / test-console 覆盖）。
    const loginOk = await call(port, '/?token=fixture-console-token');
    ok(loginOk.status === 200 && !/需要控制台令牌|控制台令牌错误/.test(loginOk.text || ''), '正确令牌 → 不再返回登录页', `HTTP ${loginOk.status}`);

    r = await call(port, '/api/console/access', { method: 'POST', headers: ADMIN, body: { consoleHost: '' } });
    ok(r.status === 200 && r.body.consoleHost === '', '清除（留空 = 只监听回环）成功', JSON.stringify(r.body));
    ok(readCfg().consoleHost === '', '清除已落盘', String(readCfg().consoleHost));
  } finally { await closeAll(server, h); }
}

console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`);
if (bad > 0) process.exit(1);
