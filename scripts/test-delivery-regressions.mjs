// 交付链路回归（真实 bridge 源码在内存 VM 里跑，不发真实 QQ/DSH）：
//   1) 普通聊天的「图片 + 文本」必须按到达顺序提交 —— 图片解析慢时不能被纯文本超车；
//   2) prompt 拒绝不外发原始错误，reserved2 不自动通知，其他模式固定提示并节流；
//   3) 断线期间完成的回复要从重连快照补发，并且按 turn 去重（重复快照/重连不重发）；
//   4) 已由 MCP 发送工具发出的回合、静默/空回复/中止回合不得补发；
//   5) reserved2 不参与补发（其文本由 AI 自己用工具发送）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
async function test(name, run) {
  try {
    await run();
    console.log('PASS', name);
  } catch (error) {
    failures++;
    console.error('FAIL', name, '—', error?.stack ?? error);
  }
}

const KEY = 'group:456';
const SID = 'session-delivery';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function attachSession(h) {
  h.setMode('chat');
  h.state.sessions[KEY] = SID;
  h.state.sessionPolicies[KEY] = h.sessionPolicy(KEY);
  h.reverse.set(SID, KEY); // 真实 bridge 在 ensureSession 里维护；夹具直接建映射时要同步。
}

const entry = (type, data) => ({ type: 'event', event: { type, data } });
const start = (turn) => entry('turn/start', { turn });
const reply = (turn, text) => entry('assistant/message', {
  turn,
  message: { content: [{ type: 'text', text }] }
});
const end = (turn, kind = 'completed') => entry('turn/end', { turn, reason: { kind } });
const sendToolCall = (callId) => entry('tool/call', { callId, name: 'mcp__snowluma__qq_send_group_message', arguments: '{}' });
const sendToolResult = (callId) => entry('tool/result', {
  message: { source: { callId }, content: [{ isError: false }] }
});
const turn = (id, text, { kind = 'completed', sendTool = false } = {}) => [
  start(id),
  ...(text ? [reply(id, text)] : []),
  ...(sendTool ? [sendToolCall(`call-${id}`), sendToolResult(`call-${id}`)] : []),
  end(id, kind)
];

// 带 seq 的快照记录：真实 DSH 的 SessionEvent 自带单调 seq，补发水位优先用它。
const turnWithSeq = (id, text, startSeq, endSeq) => [
  { type: 'event', seq: startSeq, event: { type: 'turn/start', data: { turn: id } } },
  ...(text ? [{ type: 'event', seq: startSeq + 1, event: { type: 'assistant/message', data: { turn: id, message: { content: [{ type: 'text', text }] } } } }] : []),
  { type: 'event', seq: endSeq, event: { type: 'turn/end', data: { turn: id, reason: { kind: 'completed' } } } }
];

await test('图片先到、文本后到：普通聊天也必须按到达顺序提交（图片解析慢不超车）', async () => {
  const h = await bridgeHarness({ config: { sendDelayMs: 0 } });
  try {
    attachSession(h);
    let imageStarted;
    const started = new Promise((resolve) => { imageStarted = resolve; });
    h.bot.getImage = async () => {
      imageStarted();
      await sleep(150);
      // 1×1 PNG，和夹具网关返回的一致。
      return { base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=' };
    };
    const imageEvent = {
      post_type: 'message', message_type: 'group', self_id: 10002, group_id: 456,
      user_id: 999, message_id: 8001,
      sender: { nickname: '小明', card: '小明' },
      raw_message: '[图片]', message: [{ type: 'image', data: { file: 'fixture.png' } }]
    };
    const textEvent = {
      post_type: 'message', message_type: 'group', self_id: 10002, group_id: 456,
      user_id: 999, message_id: 8002,
      sender: { nickname: '小明', card: '小明' },
      raw_message: '第二句', message: [{ type: 'text', data: { text: '第二句' } }]
    };

    const imageDelivery = h.handleIncoming('group', '456', imageEvent, h.cfg);
    await started; // 图片已经进入队列、正卡在媒体解析
    const textDelivery = h.handleIncoming('group', '456', textEvent, h.cfg);
    await Promise.all([imageDelivery, textDelivery]);

    assert.equal(h.calls.prompts.length, 2, '两条消息都应提交');
    const [first, second] = h.calls.prompts;
    assert.ok(first.content.some((part) => part.type === 'image'), '第一条提交必须包含图片（不能被后到的文本超车）');
    assert.ok(second.content.length === 1 && second.content[0].type === 'text' && second.content[0].text.includes('第二句'), '第二条提交应为纯文本');
  } finally { await h.close(); }
});

await test('普通聊天改走 promptQueues 后仍按原语义发送 ack', async () => {
  const h = await bridgeHarness({ config: { sendDelayMs: 0, ackMessage: '已收到' } });
  try {
    attachSession(h);
    await h.handleIncoming('group', '456', {
      post_type: 'message', message_type: 'group', self_id: 10002, group_id: 456,
      user_id: 999, message_id: 8101,
      sender: { nickname: '小明', card: '小明' },
      raw_message: '在吗', message: [{ type: 'text', data: { text: '在吗' } }]
    }, h.cfg);
    assert.equal(h.calls.prompts.length, 1, '消息应照常提交');
    assert.deepEqual(h.calls.sent.map((m) => m.text), ['已收到'], 'ack 仍应在提交成功后发送');
  } finally { await h.close(); }
});

await test('#104 prompt 拒绝不外发原始错误：reserved2 保持私密，其他模式固定提示并节流', async () => {
  const h = await bridgeHarness({ config: { sendDelayMs: 0 } });
  try {
    attachSession(h);
    const raw = '503 {"gateway_hint":"private-account-pool-detail"}';
    h.api.sessions.prompt = async () => ({
      result: { ok: false, error: { code: 'UPSTREAM_ERROR', message: raw } }
    });

    h.setMode('reserved2');
    const rejected = await h.deliverPrompt(KEY, 'fixture');
    assert.equal(rejected.ok, false);
    assert.equal(h.calls.sent.length, 0, 'reserved2 不得自动外发 prompt 拒绝详情');

    h.setMode('chat');
    await h.deliverPrompt(KEY, 'fixture');
    await h.deliverPrompt(KEY, 'fixture');
    assert.deepEqual(h.calls.sent.map((m) => m.text), ['⚠️ 暂时无法处理消息，请稍后再试。']);
    assert.ok(!h.calls.sent.some((m) => m.text.includes('private-account-pool-detail')));
  } finally { await h.close(); }
});

await test('重连快照：补发断线期间完成的回复，且重复快照不重发', async () => {
  const h = await bridgeHarness({ config: { sendDelayMs: 0 } });
  try {
    attachSession(h);
    // 第一次快照只有历史：没有游标 → 初始化，不把旧回复灌进 QQ。
    await h.handleSessionSnapshot(SID, { records: turn('T1', '历史回复') });
    assert.equal(h.calls.sent.length, 0, '首次建立游标时不得补发历史回复');
    assert.equal(h.deliveryCursors.get(SID).deliveredTurn, 'T1');

    // 断线期间跑完 T2：live turn/end 没到，快照里有完整回复。
    await h.handleSessionSnapshot(SID, { records: [...turn('T1', '历史回复'), ...turn('T2', '断线期间的回复')] });
    assert.equal(h.calls.sent.length, 1, '断线期间完成的回复应补发一次');
    assert.equal(h.calls.sent[0].text, '断线期间的回复');
    assert.equal(h.deliveryCursors.get(SID).deliveredTurn, 'T2');

    // 重复下发同一份快照（每次重连都会重发快照）→ 不得重复。
    await h.handleSessionSnapshot(SID, { records: [...turn('T1', '历史回复'), ...turn('T2', '断线期间的回复')] });
    assert.equal(h.calls.sent.length, 1, '重复快照不得重复补发');

    // 游标落盘：bridge 重启后仍能去重。
    const file = path.join(h.temp, 'state', 'delivery-cursors.json');
    assert.ok(fs.existsSync(file), '交付游标应持久化到 state/delivery-cursors.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.sessions[SID].deliveredTurn, 'T2');
  } finally { await h.close(); }
});

await test('同一会话并发到达两份相同快照也只补发一次', async () => {
  const h = await bridgeHarness({ config: { sendDelayMs: 0 } });
  try {
    attachSession(h);
    await h.handleSessionSnapshot(SID, { records: turn('T1', 'anchor') });
    const records = [...turn('T1', 'anchor'), ...turn('T2', '并发快照回复')];
    await Promise.all([
      h.handleSessionSnapshot(SID, { records }),
      h.handleSessionSnapshot(SID, { records })
    ]);
    assert.deepEqual(h.calls.sent.map((m) => m.text), ['并发快照回复'], '并发快照必须串行并去重');
  } finally { await h.close(); }
});

await test('live turn/end 已交付的回合不会在重连快照里重发（含工具已发送的回合）', async () => {
  const h = await bridgeHarness({ config: { sendDelayMs: 0 } });
  try {
    attachSession(h);
    // 模拟 live 通道完整跑完 T1（trackTurnEvent 是 pumpMux 用的同一入口）。
    h.trackTurnEvent(SID, { type: 'turn/start', data: { turn: 'T1' } });
    h.trackTurnEvent(SID, { type: 'assistant/message', data: { turn: 'T1', message: { content: [{ type: 'text', text: '已经发过的回复' }] } } });
    const ended = h.trackTurnEvent(SID, { type: 'turn/end', data: { turn: 'T1', reason: { kind: 'completed' } } });
    assert.equal(ended.ended.reason.kind, 'completed');
    assert.equal(h.deliveryCursors.get(SID).deliveredTurn, 'T1');

    await h.handleSessionSnapshot(SID, { records: turn('T1', '已经发过的回复') });
    assert.equal(h.calls.sent.length, 0, 'live 已交付的回合不得补发');

    // T2 断线期间完成，但本回合已用 MCP 发送工具发出 → 只推进游标，不重复发文本。
    await h.handleSessionSnapshot(SID, { records: [...turn('T1', '已经发过的回复'), ...turn('T2', '工具已发', { sendTool: true })] });
    assert.equal(h.calls.sent.length, 0, '工具已发送的回合不得自动补发');
    assert.equal(h.deliveryCursors.get(SID).deliveredTurn, 'T2');
  } finally { await h.close(); }
});

await test('空回复 / 中止回合只推进游标，不补发', async () => {
  const h = await bridgeHarness({ config: { sendDelayMs: 0 } });
  try {
    attachSession(h);
    await h.handleSessionSnapshot(SID, { records: turn('T1', 'anchor') });
    await h.handleSessionSnapshot(SID, { records: [...turn('T1', 'anchor'), ...turn('T2', ''), ...turn('T3', '被中止', { kind: 'aborted' })] });
    assert.equal(h.calls.sent.length, 0);
    assert.equal(h.deliveryCursors.get(SID).deliveredTurn, 'T3');
  } finally { await h.close(); }
});

await test('首轮就崩溃（没有 deliveredTurn）：用 inflight 锚点补发该回合及之后', async () => {
  const h = await bridgeHarness({ config: { sendDelayMs: 0 } });
  try {
    attachSession(h);
    // 模拟上一进程已看到 turn/start、但还没交付就退出：只有 inflight 游标。
    h.deliveryCursors.set(SID, { deliveredTurn: '', inflightTurn: 'T1' });
    await h.handleSessionSnapshot(SID, { records: [...turn('T1', '首轮回复'), ...turn('T2', '第二轮回复')] });
    assert.deepEqual(h.calls.sent.map((m) => m.text), ['首轮回复', '第二轮回复']);
    assert.equal(h.deliveryCursors.get(SID).deliveredTurn, 'T2');
  } finally { await h.close(); }
});

await test('已交付锚点掉出窗口时，仍能用 inflight 锚点补发', async () => {
  const h = await bridgeHarness({ config: { sendDelayMs: 0 } });
  try {
    attachSession(h);
    h.deliveryCursors.set(SID, { deliveredTurn: 'T0', deliveredSeq: -1, inflightTurn: 'T2', inflightSeq: -1 });
    await h.handleSessionSnapshot(SID, { records: [...turn('T2', '窗口内新回复'), ...turn('T3', '后续回复')] });
    assert.deepEqual(h.calls.sent.map((m) => m.text), ['窗口内新回复', '后续回复']);
  } finally { await h.close(); }
});

await test('发送失败不推进游标，下一次快照重试', async () => {
  const h = await bridgeHarness({ config: { sendDelayMs: 0 } });
  try {
    attachSession(h);
    await h.handleSessionSnapshot(SID, { records: turn('T1', 'anchor') });
    const original = h.bot.sendGroupMessage.bind(h.bot);
    let failOnce = true;
    h.bot.sendGroupMessage = async (...args) => {
      if (failOnce) { failOnce = false; throw new Error('fixture send failure'); }
      return original(...args);
    };
    await h.handleSessionSnapshot(SID, { records: [...turn('T1', 'anchor'), ...turn('T2', '需要重试的回复')] });
    assert.equal(h.calls.sent.length, 0, '发送失败时不能算已交付');
    assert.equal(h.deliveryCursors.get(SID).deliveredTurn, 'T1', '失败后游标应停在失败回合之前');

    await h.handleSessionSnapshot(SID, { records: [...turn('T1', 'anchor'), ...turn('T2', '需要重试的回复')] });
    assert.deepEqual(h.calls.sent.map((m) => m.text), ['需要重试的回复'], '下一次快照应重试成功');
    assert.equal(h.deliveryCursors.get(SID).deliveredTurn, 'T2');
  } finally { await h.close(); }
});

await test('seq 水位：旧游标掉出快照窗口后，窗口内的新回合仍能补发且不重复', async () => {
  const h = await bridgeHarness({ config: { sendDelayMs: 0 } });
  try {
    attachSession(h);
    // live 跑完 T1（seq 5..10），随后断线：快照窗口已被截断，T1 不在 records 里。
    h.trackTurnEvent(SID, { type: 'turn/start', seq: 5, data: { turn: 'T1' } });
    h.trackTurnEvent(SID, { type: 'assistant/message', seq: 6, data: { turn: 'T1', message: { content: [{ type: 'text', text: '已经发过' }] } } });
    h.trackTurnEvent(SID, { type: 'turn/end', seq: 10, data: { turn: 'T1', reason: { kind: 'completed' } } });
    assert.equal(h.deliveryCursors.get(SID).deliveredSeq, 10);

    const window = [...turnWithSeq('T2', '断线回复一', 21, 30), ...turnWithSeq('T3', '断线回复二', 31, 40)];
    await h.handleSessionSnapshot(SID, { records: window });
    assert.deepEqual(h.calls.sent.map((m) => m.text), ['断线回复一', '断线回复二'], '窗口内 seq > 10 的回合都应补发');
    assert.equal(h.deliveryCursors.get(SID).deliveredSeq, 40);

    await h.handleSessionSnapshot(SID, { records: window });
    assert.equal(h.calls.sent.length, 2, '同一窗口重放不得重复补发');
  } finally { await h.close(); }
});

await test('reserved2 不补发（内部文本不能当普通聊天回复发出）', async () => {
  const h = await bridgeHarness({ config: { sendDelayMs: 0 } });
  try {
    attachSession(h);
    h.setMode('reserved2');
    await h.handleSessionSnapshot(SID, { records: turn('T1', 'reserved2 内部输出') });
    assert.equal(h.calls.sent.length, 0);
    assert.equal(h.deliveryCursors.get(SID), undefined, 'reserved2 不应改动补发游标');
  } finally { await h.close(); }
});

await test('模式未确定时快照先暂存，refreshMode 之后再决定（不能按初始 chat 补发）', async () => {
  const h = await bridgeHarness({ config: { sendDelayMs: 0 } });
  try {
    // 注意：这里刻意不调用 setMode，模拟 mux 快照先于 checkDsh/refreshMode 到达。
    h.state.sessions[KEY] = SID;
    h.state.sessionPolicies[KEY] = h.sessionPolicy(KEY);
    h.reverse.set(SID, KEY);
    await h.handleSessionSnapshot(SID, { records: turn('T1', '历史回复') });
    assert.equal(h.calls.sent.length, 0);
    assert.equal(h.deliveryCursors.get(SID), undefined, '模式未知时不得读写交付游标');

    await h.refreshMode(); // 夹具 settings 无 qq-mode → 回退本地 mode.json（缺失时保持 chat）
    await h.replayDeferredDeliveries();
    assert.equal(h.calls.sent.length, 0, '暂存快照只用于建立游标，不得补发历史');
    assert.equal(h.deliveryCursors.get(SID).deliveredTurn, 'T1');
  } finally { await h.close(); }
});

console.log(failures === 0 ? '\n✅ 交付链路回归通过' : `\n❌ ${failures} 项失败`);
process.exitCode = failures === 0 ? 0 : 1;
