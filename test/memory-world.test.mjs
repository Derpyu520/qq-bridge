import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createMemoryWorld, dayKey, oneLine, buildDiaryTranscript, buildDiaryPrompt, cleanDiaryText } from '../src/memory-world.mjs';

function tmpWorld() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-'));
  return { dir, world: createMemoryWorld({ dir }) };
}

test('oneLine 压缩空白并截断', () => {
  assert.equal(oneLine('  a\n b\tc  ', 10), 'a b c');
  assert.equal(oneLine('1234567890', 5), '1234…');
});

test('dayKey 用本地时区', () => {
  assert.match(dayKey(Date.now()), /^\d{4}-\d{2}-\d{2}$/);
});

test('人物事实按文本去重并累计 hits', () => {
  const { world } = tmpWorld();
  const a = world.addFact({ qq: '10001', name: '小明', text: '生日 6 月 3 日', origin: 'group:1' });
  const b = world.addFact({ qq: '10001', name: '小明', text: '生日 6 月 3 日', origin: 'group:1' });
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);
  const p = world.getPerson('10001');
  assert.equal(p.facts.length, 1);
  assert.equal(p.facts[0].hits, 2);
});

test('群聊注入：私聊来源的事实绝不出现，别的群的来源带提示', () => {
  const { world } = tmpWorld();
  world.addFact({ qq: '10001', name: '小明', text: '怕黑', origin: 'private:10001' });
  world.addFact({ qq: '10001', name: '小明', text: '养了只猫', origin: 'group:2' });
  const text = world.compose({
    key: 'group:1',
    speakers: [{ qq: '10001', name: '小明' }],
    ownerQQ: '90000'
  });
  assert.ok(text.includes('养了只猫'));
  assert.ok(text.includes('来源：群2'));
  assert.ok(!text.includes('怕黑'));
});

test('私聊注入：只带这个人的来源，别人的私聊与群来源规则正确', () => {
  const { world } = tmpWorld();
  world.addFact({ qq: '10001', name: '小明', text: '怕黑', origin: 'private:10001' });
  world.addFact({ qq: '10001', name: '小明', text: '养了只猫', origin: 'group:2' });
  world.addFact({ qq: '10001', name: '小明', text: '别人的秘密', origin: 'private:20002' });
  const text = world.compose({ key: 'private:10001', speakers: [{ qq: '10001', name: '小明' }] });
  assert.ok(text.includes('怕黑'));
  assert.ok(text.includes('养了只猫'));
  assert.ok(!text.includes('别人的秘密'));
});

test('日记默认只对主人私聊可见', () => {
  const { world } = tmpWorld();
  world.writeDiary(Date.now(), '今天群里聊了原神，我插了两句。');
  const owner = world.compose({ key: 'private:90000', ownerQQ: '90000', diaryInject: 'owner' });
  const group = world.compose({ key: 'group:1', ownerQQ: '90000', diaryInject: 'owner' });
  const friend = world.compose({ key: 'private:10001', ownerQQ: '90000', diaryInject: 'owner' });
  assert.ok(owner.includes('最近的日记'));
  assert.ok(!group.includes('最近的日记'));
  assert.ok(!friend.includes('最近的日记'));
});

test('日记 all 模式下任何会话可见', () => {
  const { world } = tmpWorld();
  world.writeDiary(Date.now(), '今天很开心。');
  assert.ok(world.compose({ key: 'group:1', diaryInject: 'all' }).includes('最近的日记'));
});

test('消息日志按天落盘、同毫秒同文本去重、可读回', () => {
  const { world } = tmpWorld();
  const ts = Date.now();
  assert.equal(world.recordMessage({ key: 'group:1', sender: '小明', qq: '10001', text: '你好', ts }), true);
  assert.equal(world.recordMessage({ key: 'group:1', sender: '小明', qq: '10001', text: '你好', ts }), false);
  world.recordMessage({ key: 'private:10001', sender: '小明', qq: '10001', text: '在吗', ts: ts + 1 });
  const day = world.readMessages(ts);
  assert.equal(day.length, 2);
  assert.equal(day[0].x, '你好');
});

test('房间备注只在本房间注入', () => {
  const { world } = tmpWorld();
  world.addRoomNote({ key: 'group:1', text: '这个群喜欢玩梗' });
  world.addRoomNote({ key: 'group:2', text: '这个群在聊考试' });
  const g1 = world.compose({ key: 'group:1' });
  assert.ok(g1.includes('这个群喜欢玩梗'));
  assert.ok(!g1.includes('这个群在聊考试'));
});

test('soul 全局注入且相同', () => {
  const { world } = tmpWorld();
  world.setSoul('我是大肥鱼，DeepSeek 的鲸鱼形象。');
  assert.ok(world.compose({ key: 'group:1' }).includes('我是大肥鱼'));
  assert.ok(world.compose({ key: 'private:1' }).includes('我是大肥鱼'));
});

test('旧版 memberImpressions 可迁移为占位人物', () => {
  const { world } = tmpWorld();
  const n = world.mergeLegacyImpressions({
    key: 'group:1',
    impressions: { 小明: { traits: ['程序员', '话多'], interactionCount: 3 } }
  });
  assert.equal(n, 2);
  const p = world.getPerson('alias:小明');
  assert.ok(p);
  assert.equal(p.facts.length, 2);
});

test('昵称里带 QQ 号的旧印象直接落到真实 QQ 下', () => {
  const { world } = tmpWorld();
  world.mergeLegacyImpressions({
    key: 'group:1',
    impressions: { '小鲸鱼(3404946607)': { traits: ['爱发语音'] } }
  });
  const p = world.getPerson('3404946607');
  assert.ok(p);
  assert.equal(p.placeholder, false);
  assert.equal(p.facts.length, 1);
  assert.equal(p.names['小鲸鱼'], 1);
});

test('日记摘要按房间分组并限流', () => {
  const items = [];
  items.push({ k: 'group:1', s: '我', x: '我回了一句', me: true, t: 0 });
  for (let i = 0; i < 20; i++) items.push({ k: 'group:1', s: '小明', x: `群消息${i}`, t: i + 1 });
  items.push({ k: 'private:2', s: '小红', x: '私聊一句', t: 99 });
  const text = buildDiaryTranscript(items, { perRoom: 5 });
  assert.ok(text.includes('【群 1】'));
  assert.ok(text.includes('【私聊】'));
  assert.ok(text.includes('我：我回了一句'));
  assert.ok(text.includes('（其余略）'));
  assert.ok(!text.includes('群消息19'));
});

test('日记 prompt 与输出清理', () => {
  const p = buildDiaryPrompt('2026-10-31', '【群 1】\n小明：你好');
  assert.ok(p.includes('2026-10-31'));
  assert.ok(p.includes('约 100 字'));
  assert.equal(cleanDiaryText('```text\n今天很开心。\n```', 140), '今天很开心。');
  assert.equal(cleanDiaryText('日记：今天很开心。', 140), '今天很开心。');
  assert.equal(cleanDiaryText('一二三四五', 3), '一二…');
});
