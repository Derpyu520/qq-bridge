// 跨会话令牌回归：默认关闭；两个方向各自开关；按来源会话限频；正文注明来源。
// 纯离线（audit-bridge-harness 假网关），不发真实 QQ 消息。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

async function makeHarness(socialV2 = {}) {
  const h = await bridgeHarness({
    config: {
      ownerQQ: 123,
      allow: { private: ['123', '789'], groups: ['456'] },
      socialV2: { proactive: { enabled: false }, ...socialV2 }
    }
  });
  h.setMode('reserved2');
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (url, token, body) => {
    const res = await fetch(base + url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-console-token': 'fixture-console-token',
        'x-agent-call': '1',
        'x-agent-token': token
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000)
    });
    return { status: res.status, ...(await res.json()) };
  };
  const group = h.getSocialV2State('group:456').agentToken;
  const owner = h.getSocialV2State('private:123').agentToken;
  h.getSocialV2State('private:789');
  return { h, server, call, group, owner };
}

const sendPrivate = (call, token, userId, message) => call('/api/send/private', token, { userId, token, message });

async function withHarness(socialV2, run) {
  const ctx = await makeHarness(socialV2);
  try {
    await run(ctx);
  } finally {
    await new Promise((resolve) => ctx.server.close(resolve));
    await ctx.h.close();
  }
}

test('默认关闭：群里拿自己的令牌给管理员发私聊会被拒', async () => {
  await withHarness({}, async ({ h, call, group }) => {
    const r = await sendPrivate(call, group, '123', '跨会话测试');
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.status, 403);
    assert.equal(h.calls.http.length, 0, '拒绝时不应触达网关');
  });
});

test('打开总开关后：群里可以发给管理员，且正文注明来源会话', async () => {
  await withHarness({ allowCrossSessionSend: true }, async ({ h, call, group }) => {
    const r = await sendPrivate(call, group, '123', '跨会话测试');
    assert.equal(r.ok, true, JSON.stringify(r));
    const sent = h.calls.http.find((entry) => String(entry.url).endsWith('/send_private_msg'));
    assert.ok(sent, '应当真的发出');
    assert.match(JSON.stringify(sent.body), /【来自 group:456】/);
  });
});

test('「任何会话 → owner」的独立开关可以单独关掉', async () => {
  await withHarness({ allowCrossSessionSend: true, allowAnySessionToOwner: false }, async ({ h, call, group }) => {
    const r = await sendPrivate(call, group, '123', '跨会话测试');
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(h.calls.http.length, 0);
  });
});

test('管理员私聊 → 白名单目标：总开关打开时可用', async () => {
  await withHarness({ allowCrossSessionSend: true }, async ({ h, call, owner }) => {
    const r = await sendPrivate(call, owner, '789', '帮我看一下');
    assert.equal(r.ok, true, JSON.stringify(r));
    const sent = h.calls.http.find((entry) => String(entry.url).endsWith('/send_private_msg'));
    assert.match(JSON.stringify(sent.body), /【来自 private:123】/);
  });
});

test('按来源会话限频：超过 crossSessionSendPerHour 后拒绝', async () => {
  await withHarness({ allowCrossSessionSend: true, crossSessionSendPerHour: 2 }, async ({ call, group }) => {
    assert.equal((await sendPrivate(call, group, '123', '第一次')).ok, true);
    assert.equal((await sendPrivate(call, group, '123', '第二次')).ok, true);
    const third = await sendPrivate(call, group, '123', '第三次');
    assert.equal(third.ok, false, JSON.stringify(third));
    assert.equal(third.status, 403);
  });
});
