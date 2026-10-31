// 跨会话令牌回归：默认关闭；两个方向各自开关；按来源会话限频；正文注明来源。
// 纯离线（audit-bridge-harness 假网关），不发真实 QQ 消息。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { bridgeHarness } from './audit-bridge-harness.mjs';

async function makeHarness(socialV2 = {}, files = {}) {
  const h = await bridgeHarness({
    files,
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
      method: body === undefined ? 'GET' : 'POST',
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

async function withHarness(socialV2, run, files = {}) {
  const ctx = await makeHarness(socialV2, files);
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

test('显式打开两个开关后：群里可以发给管理员，且正文注明来源会话', async () => {
  await withHarness({ allowCrossSessionSend: true, allowAnySessionToOwner: true }, async ({ h, call, group }) => {
    const r = await sendPrivate(call, group, '123', '跨会话测试');
    assert.equal(r.ok, true, JSON.stringify(r));
    const sent = h.calls.http.find((entry) => String(entry.url).endsWith('/send_private_msg'));
    assert.ok(sent, '应当真的发出');
    assert.match(JSON.stringify(sent.body), /【来自 group:456】/);
  });
});

test('「任何会话 → owner」的独立开关可以单独关掉', async () => {
  await withHarness({ allowCrossSessionSend: true, allowAnySessionToOwner: true, allowAnySessionToOwner: false }, async ({ h, call, group }) => {
    const r = await sendPrivate(call, group, '123', '跨会话测试');
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(h.calls.http.length, 0);
  });
});

test('管理员私聊 → 白名单目标：总开关打开时可用', async () => {
  await withHarness({ allowCrossSessionSend: true, allowAnySessionToOwner: true }, async ({ h, call, owner }) => {
    const r = await sendPrivate(call, owner, '789', '帮我看一下');
    assert.equal(r.ok, true, JSON.stringify(r));
    const sent = h.calls.http.find((entry) => String(entry.url).endsWith('/send_private_msg'));
    assert.match(JSON.stringify(sent.body), /【来自 private:123】/);
  });
});

test('按来源会话限频：超过 crossSessionSendPerHour 后拒绝', async () => {
  await withHarness({ allowCrossSessionSend: true, allowAnySessionToOwner: true, crossSessionSendPerHour: 2 }, async ({ call, group }) => {
    assert.equal((await sendPrivate(call, group, '123', '第一次')).ok, true);
    assert.equal((await sendPrivate(call, group, '123', '第二次')).ok, true);
    const third = await sendPrivate(call, group, '123', '第三次');
    assert.equal(third.ok, false, JSON.stringify(third));
    assert.equal(third.status, 403);
  });
});


test('跨会话只扩展发送：未读、提示词、状态和唤醒配置仍绑定来源会话', async () => {
  await withHarness({ allowCrossSessionSend: true, allowAnySessionToOwner: true }, async ({ h, call, group }) => {
    h.appendSocialV2Message('private:123', 'owner', '私密内容', '私密内容', false, true, 99);
    for (const route of ['unread', 'recent', 'prompt', 'state']) {
      const r = await call(`/api/socialV2/${route}?key=private:123`, group);
      assert.equal(r.status, 403, `${route}: ${JSON.stringify(r)}`);
    }
    const r = await call('/api/socialV2/wake-config', group, { key: 'private:123', config: { mode: 'active' } });
    assert.equal(r.status, 403, JSON.stringify(r));
  });
});

test('非文本跨会话拒绝：拍一拍不能绕过可见来源标记', async () => {
  await withHarness({ allowCrossSessionSend: true, allowAnySessionToOwner: true }, async ({ call, group }) => {
    const r = await call('/api/socialV2/send-poke', group, { key: 'private:123' });
    assert.equal(r.status, 403, JSON.stringify(r));
    assert.match(r.error, /token/);
  });
});

test('默认子开关：只开总开关仍拒绝群→owner，保留 owner→白名单', async () => {
  await withHarness({ allowCrossSessionSend: true }, async ({ call, group, owner }) => {
    assert.equal((await sendPrivate(call, group, '123', '不应默认开启')).status, 403);
    assert.equal((await sendPrivate(call, owner, '789', '管理员主动代发')).ok, true);
  });
});

test('撤销来源白名单后，旧群令牌不能继续跨会话发送', async () => {
  await withHarness({ allowCrossSessionSend: true, allowAnySessionToOwner: true }, async ({ h, call, group }) => {
    h.cfg.allow.groups = [];
    assert.equal((await sendPrivate(call, group, '123', '已撤销来源')).status, 403);
    assert.equal(h.calls.http.length, 0);
  });
});

test('限频全局上限：换来源令牌不能绕过', async () => {
  await withHarness({ allowCrossSessionSend: true, allowAnySessionToOwner: true, crossSessionSendGlobalPerHour: 1 }, async ({ call, group, owner }) => {
    assert.equal((await sendPrivate(call, group, '123', '第一个来源')).ok, true);
    assert.equal((await sendPrivate(call, owner, '789', '第二个来源')).status, 403);
  });
});


test('owner→白名单子开关可以关闭；第三方之间与非白名单发送始终拒绝', async () => {
  await withHarness({ allowCrossSessionSend: true, allowAnySessionToOwner: true, allowOwnerToWhitelist: false }, async ({ call, group, owner }) => {
    assert.equal((await sendPrivate(call, owner, '789', '关闭代发')).status, 403);
    assert.equal((await sendPrivate(call, group, '789', '群发给第三人')).status, 403);
    assert.equal((await sendPrivate(call, owner, '99999', '非白名单')).status, 403);
  });
});

test('发送端点都保留来源：group、send-message、send-burst 的每条正文', async () => {
  await withHarness({ allowCrossSessionSend: true, allowAnySessionToOwner: true, send: { burstMinGapMs: 0, burstMaxGapMs: 0, minGapMs: 0, maxGapMs: 0 } }, async ({ h, call, group, owner }) => {
    assert.equal((await call('/api/send/group', owner, { groupId: '456', token: owner, message: '群消息' })).ok, true);
    for (const route of ['send-message', 'send-burst']) {
      const result = await call(`/api/socialV2/${route}`, group, { key: 'private:123', messages: ['第一条', '第二条'], gapMode: 'fixed', gapMs: 0 });
      assert.equal(result.ok, true, JSON.stringify(result));
    }
    const outbound = h.calls.http.filter(entry => /send_(private|group)_msg$/.test(entry.url));
    assert.equal(outbound.length, 5);
    for (const entry of outbound) assert.match(JSON.stringify(entry.body), /【来自 (group:456|private:123)】/);
    const activity = fs.readFileSync(path.join(h.temp, 'state/qq-activity.log'), 'utf8');
    assert.match(activity, /\[跨会话发送\] group:456 -> private:123/);
  });
});

test('批量发送按条扣额，同会话发送不消耗跨会话配额', async () => {
  await withHarness({ allowCrossSessionSend: true, allowAnySessionToOwner: true, crossSessionSendPerHour: 1 }, async ({ h, call, group, owner }) => {
    assert.equal((await call('/api/socialV2/send-message', group, { key: 'private:123', messages: ['一', '二'] })).status, 403);
    assert.equal(h.calls.http.length, 0);
    assert.equal((await sendPrivate(call, owner, '123', '同会话')).ok, true);
    assert.equal((await sendPrivate(call, group, '123', '第一条跨会话')).ok, true);
    assert.equal((await sendPrivate(call, group, '123', '第二条跨会话')).status, 403);
  });
});

test('重启保留限频记录；一小时前的记录过期', async () => {
  const opts = { allowCrossSessionSend: true, allowAnySessionToOwner: true, crossSessionSendPerHour: 1 };
  let saved;
  await withHarness(opts, async ({ h, call, group }) => {
    assert.equal((await sendPrivate(call, group, '123', '重启前')).ok, true);
    saved = fs.readFileSync(path.join(h.temp, 'state/cross-session-send-times.json'), 'utf8');
  });
  await withHarness(opts, async ({ call, group }) => {
    assert.equal((await sendPrivate(call, group, '123', '重启后')).status, 403);
  }, { 'state/cross-session-send-times.json': saved });
  await withHarness(opts, async ({ call, group }) => {
    assert.equal((await sendPrivate(call, group, '123', '窗口已过期')).ok, true);
  }, { 'state/cross-session-send-times.json': [{ caller: 'group:456', at: Date.now() - 3600001 }] });
});

test('限频记录损坏/不可写时拒绝，0 配额禁用跨会话', async () => {
  const opts = { allowCrossSessionSend: true, allowAnySessionToOwner: true };
  await withHarness(opts, async ({ h, call, group }) => {
    assert.equal((await sendPrivate(call, group, '123', '损坏记录')).status, 403);
    assert.equal(h.calls.http.length, 0);
  }, { 'state/cross-session-send-times.json': '{bad json' });
  await withHarness(opts, async ({ h, call, group }) => {
    fs.mkdirSync(path.join(h.temp, 'state/cross-session-send-times.json'));
    assert.equal((await sendPrivate(call, group, '123', '无法落盘')).status, 403);
    assert.equal(h.calls.http.length, 0);
  });
  for (const key of ['crossSessionSendPerHour', 'crossSessionSendGlobalPerHour']) {
    await withHarness({ ...opts, [key]: 0 }, async ({ call, group }) => {
      assert.equal((await sendPrivate(call, group, '123', '零配额')).status, 403);
    });
  }
});

test('来源日志标红且按文本渲染，消息 HTML 不被解释', () => {
  const html = fs.readFileSync(new URL('../public/console.html', import.meta.url), 'utf8');
  const fn = html.slice(html.indexOf('function renderActivity('), html.indexOf('async function refresh()'));
  const el = { nodes: [], replaceChildren() { this.nodes = []; }, append(node) { this.nodes.push(node); } };
  const ctx = { document: { getElementById: () => el, createTextNode: text => ({ textContent: text }), createElement: () => ({ style: {} }) } };
  vm.runInNewContext(fn + ';renderActivity("[12:34:56] [跨会话发送] group:456 -> private:123\\n[12:34:56] 普通消息 <img src=x onerror=boom>");', ctx);
  assert.equal(el.nodes[0].style.color, 'var(--danger, #ef4444)');
  assert.match(el.nodes.at(-1).textContent, /<img/);
  assert.equal(el.nodes.at(-1).innerHTML, undefined);
});


test('分条等待期间撤销来源白名单，后续跨会话正文停止出站', async () => {
  await withHarness({ allowCrossSessionSend: true, allowAnySessionToOwner: true }, async ({ h, call, group }) => {
    const sending = call('/api/socialV2/send-message', group, { key: 'private:123', messages: ['第一条', '第二条'], gapMode: 'fixed', gapMs: 200 });
    const until = Date.now() + 2000;
    while (h.calls.http.length === 0 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(h.calls.http.length, 1);
    h.cfg.allow.groups = [];
    const r = await sending;
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(h.calls.http.length, 1);
  });
});
