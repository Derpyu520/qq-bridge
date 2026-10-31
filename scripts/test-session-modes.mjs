// 会话三态回归：blocked 不入库、muted 入库但不排唤醒、normal 恢复后能正常触发唤醒。
// 纯离线：假 QQ / 假 DSH（audit-bridge-harness），不联网、不碰真实 state。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:456';

const messageEvent = (id, text) => ({
  post_type: 'message',
  message_type: 'group',
  self_id: 10002,
  group_id: 456,
  user_id: 999,
  message_id: id,
  sender: { nickname: '小明', card: '小明' },
  raw_message: text,
  message: [{ type: 'text', data: { text } }]
});

async function withMode(mode, run) {
  const files = mode ? { 'state/session-modes.json': { [KEY]: mode } } : {};
  const h = await bridgeHarness({ files });
  try {
    h.setMode('reserved2');
    await run(h);
  } finally {
    await h.close();
  }
}

test('blocked：消息不入库、不排唤醒、不投递', async () => {
  await withMode('blocked', async (h) => {
    await h.handleIncoming('group', '456', messageEvent(1, '屏蔽期间的消息'), h.cfg);
    const st = h.getSocialV2State(KEY);
    assert.equal(st.unread.length, 0, 'blocked 不应把消息写进未读');
    assert.equal(st.pendingWakeTimer, null, 'blocked 不应排唤醒');
    assert.equal(h.calls.prompts.length, 0, 'blocked 不应投递 prompt');
  });
});

test('muted：消息仍入库，但不排唤醒（否则就是烧 token 却不说话）', async () => {
  await withMode('muted', async (h) => {
    await h.handleIncoming('group', '456', messageEvent(2, '静默期间的消息'), h.cfg);
    const st = h.getSocialV2State(KEY);
    assert.equal(st.unread.length, 1, 'muted 仍应收下消息，取消静默后要能补看');
    assert.equal(st.pendingWakeTimer, null, 'muted 不应排唤醒');
    assert.equal(h.calls.prompts.length, 0, 'muted 不应投递 prompt');
    // 静默期间的唤醒重试/补发路径也不能漏：直接调 sendWakePromptV2 应被守卫挡下。
    await h.sendWakePromptV2(KEY, 'bootstrap');
    assert.equal(h.calls.prompts.length, 0, 'muted 时 sendWakePromptV2 也必须短路');
  });
});

test('normal：取消静默后恢复唤醒与投递能力', async () => {
  await withMode(null, async (h) => {
    await h.handleIncoming('group', '456', messageEvent(3, '正常消息'), h.cfg);
    const st = h.getSocialV2State(KEY);
    assert.equal(st.unread.length, 1);
    assert.ok(st.pendingWakeTimer, 'normal 应排上唤醒（合并窗口）');
  });
});


async function withConsole(mode, run) {
  await withMode(mode, async (h) => {
    const server = h.startConsoleServer();
    if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
    const setMode = async (mode) => {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/session/mute`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token' },
        body: JSON.stringify({ key: KEY, mode }), signal: AbortSignal.timeout(5000)
      });
      const body = await res.json();
      assert.equal(body.ok, true, JSON.stringify(body));
    };
    try { await run(h, setMode); } finally { await new Promise(resolve => server.close(resolve)); }
  });
}

test('真实 muted→normal：静默首条不消耗 bootstrap，恢复后新消息可唤醒', async () => {
  await withConsole('muted', async (h, setMode) => {
    await h.handleIncoming('group', '456', messageEvent(4, '第一条静默消息'), h.cfg);
    const st = h.getSocialV2State(KEY);
    assert.equal(st.bootstrapSent, false);
    await setMode('normal');
    await h.handleIncoming('group', '456', messageEvent(5, '恢复后的普通陈述'), h.cfg);
    assert.ok(st.pendingWakeTimer, '应恢复首次 bootstrap');
  });
});

test('模式切换清理已有定时器和 prompt 队列，恢复有限睡眠计划', async () => {
  await withConsole(null, async (h, setMode) => {
    const st = h.getSocialV2State(KEY);
    st.wakeConfig.infinite = false;
    st.wakeConfig.sleepUntil = new Date(Date.now() + 60000).toISOString();
    h.setupSleepTimerV2(KEY);
    assert.ok(st.sleepTimer);
    h.setReady(false);
    const queued = h.deliverPrompt(KEY, '不应在静默后补发的旧任务');
    await new Promise(resolve => setImmediate(resolve));
    await setMode('muted');
    assert.equal(st.sleepTimer, null);
    assert.equal(h.promptQueues.get(KEY)?.queue?.length || 0, 0);
    assert.equal((await queued).queued, true);
    h.setReady(true);
    assert.equal(h.calls.prompts.length, 0);
    await setMode('normal');
    assert.ok(st.sleepTimer, '恢复后必须重建有限睡眠定时器');
  });
});

test('blocked 拍一拍：不入库；muted 拍一拍：入库但不消费 bootstrap', async () => {
  for (const mode of ['blocked', 'muted']) await withMode(mode, async (h) => {
    await h.handlePokeNotice({ sub_type: 'poke', group_id: 456, user_id: 999, target_id: 10002, self_id: 10002 });
    const st = h.getSocialV2State(KEY);
    assert.equal(st.unread.length, mode === 'blocked' ? 0 : 1);
    assert.equal(st.bootstrapSent, false);
    assert.equal(st.pendingWakeTimer, null);
  });
});

test('muted 消息有界入库且不启动黑话提取，不执行管理命令', async () => {
  await withMode('muted', async (h) => {
    h.cfg.socialV2 = { ...h.cfg.socialV2, context: { unreadLimit: 3 } };
    for (let i = 0; i < 8; i++) await h.handleIncoming('group', '456', messageEvent(100 + i, '静默消息'), h.cfg);
    const st = h.getSocialV2State(KEY);
    assert.equal(st.unread.length, 3);
    const event = messageEvent(200, '/role off'); event.user_id = 123;
    await h.handleIncoming('group', '456', event, h.cfg);
    assert.equal(st.unread.at(-1).plain, '/role off');
    assert.equal(h.calls.prompts.length, 0);
  });
});


test('投递期间切 muted：ensureSession 的 await 之后也必须复核', async () => {
  await withConsole(null, async (h, setMode) => {
    let release;
    let started;
    const entered = new Promise(resolve => { started = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const create = h.api.sessions.create;
    h.api.sessions.create = async (params) => { started(); await gate; return create(params); };
    const delivery = h.deliverPrompt(KEY, '已经进入投递过程的旧消息');
    await entered;
    await setMode('muted');
    release();
    await delivery;
    assert.equal(h.calls.prompts.length, 0, '切静默后不能提交模型调用');
  });
});

test('prompt 队列清理真实执行：运行中的任务放行前挂上第二个任务再切模式', async () => {
  await withConsole(null, async (h, setMode) => {
    let release; let started;
    const gate = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { started = resolve; });
    const create = h.api.sessions.create;
    h.api.sessions.create = async params => { started(); await gate; return create(params); };
    const first = h.deliverPrompt(KEY, '第一条');
    await entered;
    const second = h.deliverPrompt(KEY, '第二条').then(() => null, error => error);
    assert.equal(h.promptQueues.get(KEY).queue.length, 1);
    await setMode('blocked');
    assert.match((await second).message, /屏蔽/);
    release(); await first;
    assert.equal(h.calls.prompts.length, 0);
  });
});


test('发送分条期间切 muted：后续已经排队的正文不得继续出站', async () => {
  await withConsole(null, async (h, setMode) => {
    const sending = h.sendMessagesV2(KEY, ['第一条', '第二条'], [150]);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(h.calls.http.length, 1);
    await setMode('muted');
    await assert.rejects(sending, /发送已取消/);
    assert.equal(h.calls.http.length, 1);
  });
});


test('真正唤醒在创建会话期间被静默：额度与有限睡眠回滚，normal 可恢复', async () => {
  await withConsole(null, async (h, setMode) => {
    const st = h.getSocialV2State(KEY);
    st.wakeConfig.infinite = false;
    const until = new Date(Date.now() + 60000).toISOString();
    st.wakeConfig.sleepUntil = until;
    const count = st.wakeConfig.wakeCount;
    let release; let started;
    const gate = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { started = resolve; });
    const create = h.api.sessions.create;
    h.api.sessions.create = async params => { started(); await gate; return create(params); };
    const waking = h.sendWakePromptV2(KEY, 'timeout');
    await entered; await setMode('muted'); release(); await waking;
    assert.equal(h.calls.prompts.length, 0);
    assert.equal(st.wakeTimes.length, 0);
    assert.equal(st.wakeConfig.wakeCount, count);
    assert.equal(st.wakeConfig.sleepUntil, until);
    await setMode('normal');
    assert.ok(st.sleepTimer);
  });
});

test('取消尚在合并窗口的首次唤醒，恢复后新消息仍可 bootstrap', async () => {
  await withConsole(null, async (h, setMode) => {
    await h.handleIncoming('group', '456', messageEvent(901, '还在合并窗口'), h.cfg);
    await setMode('muted'); await setMode('normal');
    await h.handleIncoming('group', '456', messageEvent(902, '恢复后普通陈述'), h.cfg);
    assert.equal(h.getSocialV2State(KEY).pendingWakeReason, 'bootstrap');
  });
});
