// 会话级运行模式（每个会话各自设置）的回归：
//   A) 端点 /api/conversation/mode（GET/POST/删除覆盖）+ /api/sessions 的 mode 字段；
//   B) 生效模式真的作用于建会话（preset 选择）与会话策略指纹（改模式 → 旧会话退役）；
//   C) 校验与鉴权：非法模式 400、closed-agent 只允许当前 owner 私聊、
//      没有安全 preset 时 409、agent token 403、无控制台令牌 401；
//   D) 落盘 + 管理员变更时作废旧 closed-agent 覆盖。
//
// 为什么单独写这个：会话级模式是**放宽/收紧单个会话权限**的入口。尤其是
// 「closed-agent 只属于当前 owner 私聊」和「没有安全 preset 就拒绝」这两条，
// 一旦回归，一个普通群会话就可能拿到完整本地工具面。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const ADMIN = { 'x-console-token': 'fixture-console-token' };
const AGENT = { 'x-console-token': 'fixture-console-token', 'x-agent-token': 'fixture-agent-token' };

let bad = 0;
const ok = (cond, name, extra = '') => {
  if (!cond) bad += 1;
  console.log(`${cond ? '  OK  ' : '  FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
};

function call(port, pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method, headers: { 'content-type': 'application/json', ...headers } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(data); } catch {}
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('request hung')));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

const h = await bridgeHarness({ config: { consolePort: 0 } });
h.setPresets(['standard', 'qq-chat', 'qq-chat-v2']);
const server = h.startConsoleServer();
if (!server.listening) await new Promise((r) => server.once('listening', r));
const port = server.address().port;
const modeFile = path.join(h.temp, 'state', 'conversation-modes.json');

try {
  // ── A) 默认状态与字段 ────────────────────────────────────────────────────
  console.log('## 接口字段');
  {
    const r = await call(port, '/api/sessions', { headers: ADMIN });
    ok(r.status === 200 && r.body?.globalMode === 'chat', '全局模式默认 chat', `HTTP ${r.status} / ${r.body?.globalMode}`);
    ok((r.body?.modes ?? []).join(',') === 'chat,reserved,reserved2,closed-agent', '返回四种可选模式');
  }

  // ── B) 覆盖生效：preset 选择 + 策略指纹 ──────────────────────────────────
  console.log('## 覆盖生效');
  {
    const before = h.sessionPolicy('group:456');
    let r = await call(port, '/api/conversation/mode', { method: 'POST', headers: ADMIN, body: { key: 'group:456', mode: 'reserved2' } });
    ok(r.status === 200 && r.body?.ok, '设置 reserved2 成功', `HTTP ${r.status} ${r.body?.error ?? ''}`);
    ok(r.body?.override?.mode === 'reserved2', '响应里带覆盖值');
    ok(h.sessionPolicy('group:456') !== before, '策略指纹随模式变化（会触发会话重建）');

    // 生效模式真的用于建会话：reserved2 → socialV2.agentPreset。
    await h.ensureSession('group:456');
    ok(h.calls.created.at(-1)?.agentPreset === 'qq-chat-v2', '新会话使用 reserved2 的 preset', String(h.calls.created.at(-1)?.agentPreset));
    ok(h.state.sessions['group:456'] != null, '会话已登记');

    // 改回 chat → 指纹变化 + 已登记的会话被退役（下次消息按新模式重建）。
    r = await call(port, '/api/conversation/mode', { method: 'POST', headers: ADMIN, body: { key: 'group:456', mode: 'chat' } });
    ok(r.status === 200, '改回 chat 成功', `HTTP ${r.status}`);
    ok(h.state.sessions['group:456'] == null, '改模式后旧会话被退役');
    await h.ensureSession('group:456');
    ok(h.calls.created.at(-1)?.agentPreset === 'qq-chat', '重建后的会话使用 chat 的 preset', String(h.calls.created.at(-1)?.agentPreset));
  }

  // ── C) 校验：非法模式 / closed-agent 边界 / 缺 preset ─────────────────────
  console.log('## 校验');
  {
    let r = await call(port, '/api/conversation/mode', { method: 'POST', headers: ADMIN, body: { key: 'group:456', mode: 'simulation' } });
    ok(r.status === 400, '拒绝未知模式', `HTTP ${r.status}`);

    r = await call(port, '/api/conversation/mode', { method: 'POST', headers: ADMIN, body: { key: 'group:456', mode: 'closed-agent' } });
    ok(r.status === 400, '拒绝把群会话设为 closed-agent', `HTTP ${r.status}`);

    r = await call(port, '/api/conversation/mode', { method: 'POST', headers: ADMIN, body: { key: 'private:123', mode: 'closed-agent' } });
    ok(r.status === 200, '管理员私聊可设 closed-agent', `HTTP ${r.status} ${r.body?.error ?? ''}`);
    await h.ensureSession('private:123');
    ok(h.calls.created.at(-1)?.agentPreset === 'standard', 'closed-agent 走 DSH 默认 preset', String(h.calls.created.at(-1)?.agentPreset));

    // preset 清单里没有 qq-chat-v2 时，reserved2 必须 409（绝不回退到 standard）。
    h.setPresets(['standard']);
    r = await call(port, '/api/conversation/mode', { method: 'POST', headers: ADMIN, body: { key: 'group:456', mode: 'reserved2' } });
    ok(r.status === 409, '缺安全 preset 时拒绝设为 reserved2', `HTTP ${r.status}`);
    h.setPresets(['standard', 'qq-chat', 'qq-chat-v2']);
  }

  // ── D) 落盘 + 删除覆盖 ───────────────────────────────────────────────────
  console.log('## 落盘与删除覆盖');
  {
    let r = await call(port, '/api/conversation/mode', { method: 'POST', headers: ADMIN, body: { key: 'group:456', mode: 'reserved2' } });
    ok(r.status === 200, '重新设置 reserved2');
    const saved = JSON.parse(fs.readFileSync(modeFile, 'utf8'));
    ok(saved.version === 1 && saved.conversations['group:456']?.mode === 'reserved2', '覆盖已落盘', JSON.stringify(saved.conversations?.['group:456']));

    r = await call(port, '/api/conversation/mode', { method: 'POST', headers: ADMIN, body: { key: 'group:456', mode: null } });
    ok(r.status === 200 && r.body?.override === null, '删除覆盖后回到全局', `HTTP ${r.status}`);
    ok(h.state.sessions['group:456'] == null, '删除覆盖同样会退役旧会话');
    const after = JSON.parse(fs.readFileSync(modeFile, 'utf8'));
    ok(after.conversations['group:456'] === undefined, '删除已落盘');
  }

  // ── E) 鉴权 ─────────────────────────────────────────────────────────────
  console.log('## 鉴权');
  {
    const r = await call(port, '/api/conversation/mode', { method: 'POST', headers: AGENT, body: { key: 'group:456', mode: 'closed-agent' } });
    ok(r.status === 403, 'agent token 不能改会话模式', `HTTP ${r.status}`);
    const anon = await call(port, '/api/conversation/mode', { headers: {}, });
    ok(anon.status === 401, '无控制台令牌 401', `HTTP ${anon.status}`);
  }

  // ── F) 管理员变更 → 作废旧 closed-agent 覆盖 ─────────────────────────────
  console.log('## 管理员变更');
  {
    const r = await call(port, '/api/whitelist', {
      method: 'POST',
      headers: ADMIN,
      body: { allow: { groups: [456], private: [123, 999] }, deny: { groups: [], private: [] }, ownerQQ: 999 },
    });
    ok(r.status === 200, '更换管理员成功', `HTTP ${r.status} ${r.body?.error ?? ''}`);
    const q = await call(port, '/api/conversation/mode?key=private:123', { headers: ADMIN });
    ok(q.body?.override === null, '旧管理员的 closed-agent 覆盖已作废', JSON.stringify(q.body?.override));
  }
} finally {
  for (const extra of server.extraListeners ?? []) await new Promise((r) => extra.close(r));
  await new Promise((r) => server.close(r));
  await h.close();
}

console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`);
process.exitCode = bad === 0 ? 0 : 1;
