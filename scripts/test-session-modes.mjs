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
