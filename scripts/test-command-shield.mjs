// 系统指令屏蔽（command shield）回归。
//
// 覆盖两层：
//   ① 纯函数：识别 `#sl` 及其变体（全角/大小写/@前缀/中文夹写），不误伤 `#slim` 等；
//   ② 端到端（虚拟网关）：命中后消息不进入二代未读队列、不投递 prompt，
//      并且按配置私聊通知管理员；正常消息仍照常入库（证明没有把进线整条掐断）。
import assert from 'node:assert';
import {
  COMMAND_SHIELD_DEFAULTS,
  commandTokenPattern,
  matchCommandShield,
  normalizeCommandText,
  validateCommandShieldPatterns
} from '../src/command-shield.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  ❌ ${name}\n     ${error?.message ?? error}`);
  }
}

console.log('## 归一化');
await test('全角 ＃／字母 → 半角；零宽字符被清掉', () => {
  assert.equal(normalizeCommandText(' ＃ＳＬ '), '#sl');
  assert.equal(normalizeCommandText('#\u200bsl'), '#sl');
});

console.log('## 命中');
for (const [text, id] of [
  ['#sl', 'snowluma-status'],
  ['#SL', 'snowluma-status'],
  ['＃ｓｌ', 'snowluma-status'],
  ['@小鲸鱼 #sl', 'snowluma-status'],
  ['@小鲸鱼#sl', 'snowluma-status'],
  ['#sl？', 'snowluma-status'],
  ['#sl 看看', 'snowluma-status'],
  ['请执行 #sl', 'snowluma-status'],
  ['#snowluma', 'snowluma-status'],
  ['#status', 'status'],
  ['#状态', 'status'],
  ['#help', 'help'],
  ['#帮助', 'help'],
  ['#帮助！', 'help'],
  ['请用#帮助', 'help'],
  ['#指令', 'help'],
  ['#version', 'version'],
  ['#版本', 'version'],
  ['#重启', 'lifecycle']
]) {
  await test(`拦截：${JSON.stringify(text)} → ${id}`, () => {
    const hit = matchCommandShield(text);
    assert.ok(hit, '应当命中');
    assert.equal(hit.id, id);
    assert.ok(hit.command.startsWith('#'), `command 应只含指令本身，实际 ${JSON.stringify(hit.command)}`);
  });
}

console.log('## 不误伤');
for (const text of [
  '',
  '你好',
  '这个 #slim 包不错',
  '#statusbar 是什么',
  '周报#标签',
  'sl 是啥',
  '＃话题讨论',
  // 边界：下面这些是“话题标签/普通叙述”，不是指令调用。
  '输入#sl试试',
  '#命令行',
  '#版本号',
  '#状态栏',
  '#帮助文档',
  '#版本 2.3 更新了什么',
  '#关于这次活动的通知'
]) {
  await test(`放行：${JSON.stringify(text)}`, () => {
    assert.equal(matchCommandShield(text), null);
  });
}

console.log('## 配置');
await test('enabled=false 时全部放行', () => {
  assert.equal(matchCommandShield('#sl', { enabled: false }), null);
});
await test('extraPatterns 生效（搜索式正则）', () => {
  const hit = matchCommandShield('请查看 /admin 面板', { extraPatterns: ['\\/admin'] });
  assert.ok(hit);
  assert.equal(hit.id, 'extra');
});
await test('坏正则不会抛错，只是不生效', () => {
  assert.equal(matchCommandShield('随便一句正常聊天', { extraPatterns: ['([unclosed'] }), null);
  assert.deepEqual(validateCommandShieldPatterns(['ok', '([bad']), ['([bad']);
});
await test('默认值符合预期（开启、10 分钟通知冷却）', () => {
  assert.equal(COMMAND_SHIELD_DEFAULTS.enabled, true);
  assert.equal(COMMAND_SHIELD_DEFAULTS.notifyOwner, true);
  assert.ok(COMMAND_SHIELD_DEFAULTS.notifyCooldownMs >= 60_000);
});
await test('commandTokenPattern：把 SnowLuma 自定义触发词编译成带边界的规则', () => {
  const pattern = commandTokenPattern('＃查状态');
  assert.ok(pattern, '非空触发词应生成规则');
  assert.ok(matchCommandShield('请 ＃查状态 一下', { extraPatterns: [pattern] }), '自定义触发词应命中');
  assert.equal(matchCommandShield('普通聊天', { extraPatterns: [pattern] }), null);
  assert.equal(commandTokenPattern('   '), null, '空触发词返回 null');
});

console.log('## 端到端（reserved2）');
await test('#sl 不进入未读队列、不投递 prompt，并私聊通知管理员', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    const event = {
      self_id: 999,
      user_id: 456,
      message_id: 5001,
      message: [{ type: 'text', data: { text: '#sl' } }],
      raw_message: '#sl',
      sender: { nickname: '测试群友', card: '测试群友' }
    };
    await h.handleIncoming('group', '456', event, h.cfg);
    const st = h.socialV2.conversations.get('group:456');
    assert.equal((st?.unread ?? []).length, 0, '被拦截的指令不得进入未读队列');
    assert.equal(h.calls.prompts.length, 0, '被拦截的指令不得投递给 DSH');

    // 管理员通知走 sendToQQ 队列，给一个 tick 让它落进假网关。
    for (let i = 0; i < 50 && !h.calls.sent.some((m) => m.kind === 'private'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const notice = h.calls.sent.find((m) => m.kind === 'private' && String(m.id) === '123');
    assert.ok(notice, '应按 notifyOwner 配置私聊通知管理员');
    assert.match(notice.text, /已拦截系统指令/);
    assert.match(notice.text, /#sl/);
  } finally { await h.close(); }
});

await test('普通群消息仍照常进入未读队列（屏蔽没有掐断整条进线）', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('reserved2');
    const event = {
      self_id: 999,
      user_id: 456,
      message_id: 5002,
      message: [{ type: 'text', data: { text: '大家好呀' } }],
      raw_message: '大家好呀',
      sender: { nickname: '测试群友', card: '测试群友' }
    };
    await h.handleIncoming('group', '456', event, h.cfg);
    const st = h.getSocialV2State('group:456');
    assert.equal((st.unread ?? []).length, 1, '正常消息应进入未读队列');
  } finally { await h.close(); }
});

if (failures) {
  console.error(`\n${failures} 项失败`);
  process.exitCode = 1;
} else {
  console.log('\n全部通过');
}
