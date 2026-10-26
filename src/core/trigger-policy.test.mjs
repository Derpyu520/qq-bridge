import assert from 'node:assert/strict';
import test from 'node:test';
import { createTriggerPolicy, isDirectedAtAi, wakePriority, isTimerWakeReason } from './trigger-policy.mjs';

const policy = (overrides = {}) => createTriggerPolicy({
  nickname: () => '大肥鱼',
  mustReplyKeywords: () => ['小鲸鱼', '在吗'],
  random: () => 0.99,
  ...overrides,
});

const group = (text, extra = {}) => ({
  self_id: 2039693365,
  user_id: 777,
  group_id: 681528723,
  sender: { card: '', nickname: '某人' },
  message: [{ type: 'text', data: { text } }],
  ...extra,
});

test('私聊一律算直接找她', () => {
  assert.equal(policy().isDirectAddress('随便聊聊', group('随便聊聊'), 'private'), true);
});

test('群里 @ 她、叫昵称、必回关键词、针对 AI 的提问都算', () => {
  const p = policy();
  const at = group('', { message: [{ type: 'at', data: { qq: '2039693365' } }] });
  assert.equal(p.isDirectAddress('[CQ:at,qq=2039693365] 在吗', at, 'group'), true);
  assert.equal(p.isDirectAddress('大肥鱼你觉得呢', group('x'), 'group'), true);
  assert.equal(p.isDirectAddress('小鲸鱼出来', group('x'), 'group'), true);
  assert.equal(p.isDirectAddress('你有claude一半强吗', group('x'), 'group'), true);
});

test('普通闲聊不算', () => {
  assert.equal(policy().isDirectAddress('今天食堂的饭好咸', group('x'), 'group'), false);
});

test('isMustReplyText 不依赖 event，只看文字', () => {
  const p = policy();
  assert.equal(p.isMustReplyText('大肥鱼在干嘛'), true);
  assert.equal(p.isMustReplyText('在吗'), true);
  assert.equal(p.isMustReplyText('随便水一句'), false);
});

test('isDirectedAtAi：问 AI 的话都算，夸天气不算', () => {
  for (const text of ['你有claude一半强吗', 'deepseek 好用吗', '你是真人吗', '在不在，理我一下', '你是人类还是ai']) {
    assert.equal(isDirectedAtAi(text), true, text);
  }
  for (const text of ['今天天气不错', '晚上吃什么', '我先睡了']) {
    assert.equal(isDirectedAtAi(text), false, text);
  }
});

test('唤醒判定：私聊和 anyMessage 最高优先', () => {
  const p = policy();
  assert.equal(p.evaluateWake({ triggers: {} }, group('x'), 'private', 'x', 'x', false), 'private');
  assert.equal(p.evaluateWake({ triggers: { anyMessage: true } }, group('x'), 'group', 'x', 'x', false), 'anyMessage');
});

test('at 段指向自己才算 atMention，引用自己也算', () => {
  const p = policy();
  const cfg = { triggers: { atMention: true } };
  const atSelf = group('', { message: [{ type: 'at', data: { qq: '2039693365' } }] });
  const atOther = group('', { message: [{ type: 'at', data: { qq: '123456' } }] });
  assert.equal(p.evaluateWake(cfg, atSelf, 'group', '', '', false), 'atMention');
  assert.equal(p.evaluateWake(cfg, atOther, 'group', '', '', false), null);
  assert.equal(p.evaluateWake(cfg, atOther, 'group', '', '', true), 'atMention', '引用一条自己的消息也算');
});

test('引用块里出现昵称不算叫她（用 plainContent 判名字）', () => {
  // 这是踩过的坑：textContent 含 `[引用 某人：原文]`，引用一段夸她的旧消息
  // 曾经会把整个回合当「被叫了名字」去付费唤醒。
  const p = policy();
  const cfg = { triggers: { nameMention: true } };
  const textContent = '[引用 某人：大肥鱼真棒啊] 对啊对啊';
  assert.equal(p.evaluateWake(cfg, group(''), 'group', textContent, '对啊对啊', false), null);
  assert.equal(p.evaluateWake(cfg, group(''), 'group', '大肥鱼你在吗', '大肥鱼你在吗', false), 'nameMention');
});

test('短英文关键词用词边界，长关键词用子串', () => {
  const p = policy();
  const short = { triggers: { keywords: ['ds'] } };
  assert.equal(p.evaluateWake(short, group(''), 'group', 'ADS 投放又涨了', 'ADS 投放又涨了', false), null, 'ADS 不该命中 ds');
  assert.equal(p.evaluateWake(short, group(''), 'group', 'ds 你怎么看', 'ds 你怎么看', false), 'keyword:ds');
  const long = { triggers: { keywords: ['新版本'] } };
  assert.equal(p.evaluateWake(long, group(''), 'group', '这个新版本有问题', '这个新版本有问题', false), 'keyword:新版本');
});

test('question 只在文字确实在问才触发', () => {
  const p = policy();
  const cfg = { triggers: { question: true } };
  assert.equal(p.evaluateWake(cfg, group(''), 'group', '你是真人吗', '你是真人吗', false), 'question');
  assert.equal(p.evaluateWake(cfg, group(''), 'group', '我出门了', '我出门了', false), null);
});

test('speakerIds 命中时把发言人名字带进原因', () => {
  const p = policy();
  const cfg = { triggers: { speakerIds: [777] } };
  const event = group('随便说点', { sender: { card: '老王', nickname: 'wang' } });
  assert.equal(p.evaluateWake(cfg, event, 'group', '', '', false), 'speaker:老王');
});

test('概率触发用注入的随机源，不是全局 Math.random', () => {
  const cfg = { triggers: { probability: 0.5 } };
  assert.equal(policy({ random: () => 0.1 }).evaluateWake(cfg, group(''), 'group', 'x', 'x', false), 'probability');
  assert.equal(policy({ random: () => 0.9 }).evaluateWake(cfg, group(''), 'group', 'x', 'x', false), null);
});

test('昵称是运行时取的，连上协议端之后才生效', () => {
  let nick = '';
  const p = policy({ nickname: () => nick });
  const cfg = { triggers: { nameMention: true } };
  assert.equal(p.evaluateWake(cfg, group(''), 'group', '大肥鱼在吗', '大肥鱼在吗', false), null);
  nick = '大肥鱼';
  assert.equal(p.evaluateWake(cfg, group(''), 'group', '大肥鱼在吗', '大肥鱼在吗', false), 'nameMention');
});

test('唤醒原因带子类型时按冒号前算优先级', () => {
  assert.equal(wakePriority('private'), 100);
  assert.equal(wakePriority('keyword:小鲸鱼'), 60);
  assert.equal(wakePriority('speaker:老王'), 75);
  assert.equal(wakePriority('atMention@seq194'), 90);
  assert.equal(wakePriority('什么都不是'), 0);
});

test('定时器类原因和消息类原因的区分', () => {
  for (const reason of ['timeout', 'replyCheck', 'proactiveCheck', 'bootstrap', 'admin', 'timeout@seq12']) {
    assert.equal(isTimerWakeReason(reason), true, reason);
  }
  for (const reason of ['atMention', 'keyword:ds', 'probability', null]) {
    assert.equal(isTimerWakeReason(reason), false, String(reason));
  }
});