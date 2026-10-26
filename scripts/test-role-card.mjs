// 人格卡按仿真模式取用（src/role-card.js）的离线单测。
// 保证：模式标记能被正确识别与剥离、未标记的老卡片行为不变、真实人格卡可用。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { applyRoleAssignment, canonicalRoleKey, mergeRoleState, normalizeRoleState, parseBehaviorContract, parseRoleSections, resolveRoleName, roleCharStats, roleSectionReport, selectRoleText } from '../src/role-card.js';

const CARD = [
  '# 角色卡：测试',
  '',
  '## 一、你是谁',
  '- 你是群里的测试角色。',
  '',
  '## 二、分条方式 〔一代〕',
  '- 想分条就用空格分隔；想沉默就输出 [SILENT]。',
  '',
  '## 三、发言方式 〔二代〕',
  '- 用 qq_send_message 的数组分条，潜水走 qq_mark_read。',
  '',
  '## 四、说话风格',
  '- 简短、口语化。',
].join('\n');

test('模式标记能被识别，未标记的小节两种模式都注入', () => {
  const sections = parseRoleSections(CARD);
  const byHeading = Object.fromEntries(sections.filter((s) => s.heading).map((s) => [s.heading, s.mode]));
  assert.equal(byHeading['一、你是谁'], 'all');
  assert.equal(byHeading['二、分条方式'], 'v1');
  assert.equal(byHeading['三、发言方式'], 'v2');
  assert.equal(byHeading['四、说话风格'], 'all');
});

test('按模式筛选：只保留公共小节 + 该模式专属小节', () => {
  const v1 = selectRoleText(CARD, 'v1');
  const v2 = selectRoleText(CARD, 'v2');
  // 公共内容两边都有
  for (const text of [v1, v2]) {
    assert.match(text, /你是群里的测试角色/);
    assert.match(text, /简短、口语化/);
  }
  // 专属内容互不串场
  assert.match(v1, /空格分隔/);
  assert.doesNotMatch(v1, /qq_send_message/);
  assert.match(v2, /qq_send_message/);
  assert.doesNotMatch(v2, /\[SILENT\]/);
});

test('注入文本里不再残留模式标记', () => {
  assert.doesNotMatch(selectRoleText(CARD, 'v1'), /〔一代〕|〔二代〕/);
  assert.doesNotMatch(selectRoleText(CARD, 'v2'), /〔一代〕|〔二代〕/);
  // 标题保留但已清洗
  assert.match(selectRoleText(CARD, 'v2'), /## 三、发言方式\n/);
});

test('多种标记写法都认（[v1] / （reserved2） / 2 代）', () => {
  const card = [
    '## A [v1]', '- a',
    '## B （reserved2）', '- b',
    '## C 〔2 代〕', '- c',
    '## D [一代]', '- d',
  ].join('\n');
  const v1 = selectRoleText(card, 'v1');
  const v2 = selectRoleText(card, 'v2');
  assert.match(v1, /- a/); assert.match(v1, /- d/);
  assert.doesNotMatch(v1, /- b/); assert.doesNotMatch(v1, /- c/);
  assert.match(v2, /- b/); assert.match(v2, /- c/);
  assert.doesNotMatch(v2, /- a/); assert.doesNotMatch(v2, /- d/);
});

test('没有模式标记的老卡片：两种模式都完整注入（向后兼容）', () => {
  const legacy = '# 老卡\n\n- 性格：傲娇\n- 说话风格：简短';
  assert.equal(selectRoleText(legacy, 'v1'), legacy);
  assert.equal(selectRoleText(legacy, 'v2'), legacy);
});

test('标题之外的内容（前言）不受影响', () => {
  const card = '开头一句话\n\n## X 〔一代〕\n- x\n\n## Y\n- y';
  assert.match(selectRoleText(card, 'v2'), /开头一句话/);
  assert.doesNotMatch(selectRoleText(card, 'v2'), /- x/);
  assert.match(selectRoleText(card, 'v2'), /- y/);
});

test('统计与小节报告可用于控制台预览', () => {
  const stats = roleCharStats(CARD);
  assert.ok(stats.v1Only > 0 && stats.v2Only > 0, '应能统计出两代各自专属的字符数');
  assert.ok(stats.v1 < stats.total && stats.v2 < stats.total, '筛选后应短于原文');
  assert.notEqual(stats.v1, stats.v2, '两代内容不同，长度不应相等');
  const report = roleSectionReport(CARD, 'v1');
  const v2Section = report.find((r) => r.heading === '三、发言方式');
  assert.equal(v2Section.injected, false, '二代专属小节在一代下应标为不注入');
  const common = report.find((r) => r.heading === '一、你是谁');
  assert.equal(common.injected, true);
});

test('真实人格卡可用，且筛选不丢公共内容', () => {
  const file = new URL('../roles/小鲸鱼.md', import.meta.url);
  const raw = fs.readFileSync(file, 'utf8');
  const v2 = selectRoleText(raw, 'v2');
  const v1 = selectRoleText(raw, 'v1');
  assert.ok(v2.length > 0 && v1.length > 0);
  // 人设部分两种模式都必须保留
  for (const text of [v1, v2]) {
    assert.match(text, /小鲸鱼/);
    assert.match(text, /AI 味|去 AI 味/);
  }
  // 二代注入的文本里不应再出现一代的分条机制
  assert.doesNotMatch(v2, /空格分隔（例如|\[SILENT\]/);
});

// ── 会话级人格（byKey） ─────────────────────────────────────────────────────

test('会话人格解析：例外优先于默认，未指定的会话走默认', () => {
  const state = { role: '小鲸鱼', mode: 'active', byKey: { 'group:123456781': '傲娇助手' } };
  assert.equal(resolveRoleName(state, 'group:123456781'), '傲娇助手');
  assert.equal(resolveRoleName(state, 'group:123456789'), '小鲸鱼');
  assert.equal(resolveRoleName(state, 'private:1000000001'), '小鲸鱼');
  assert.equal(resolveRoleName(state, ''), '小鲸鱼', '拿不到 key 时退回默认人格');
  assert.equal(resolveRoleName({ role: '小鲸鱼', byKey: null }, 'group:1'), '小鲸鱼');
});

test('会话人格解析：默认和例外都为空时返回 null（不扮演）', () => {
  assert.equal(resolveRoleName({ role: null, mode: 'active', byKey: {} }, 'group:1'), null);
  assert.equal(resolveRoleName({}, 'group:1'), null);
  assert.equal(resolveRoleName(null, 'group:1'), null);
});

test('会话 key 归一化：只认 group/private + 正整数，并去掉前导零', () => {
  assert.equal(canonicalRoleKey('group:00123'), 'group:123');
  assert.equal(canonicalRoleKey('private:42'), 'private:42');
  assert.equal(canonicalRoleKey(' group:7 '), 'group:7');
  assert.equal(canonicalRoleKey('group:0'), null);
  assert.equal(canonicalRoleKey('group:abc'), null);
  assert.equal(canonicalRoleKey('friend:1'), null);
  assert.equal(canonicalRoleKey(''), null);
});

test('状态合并：只改 role/mode 时 byKey 原样保留（静默开关不会清空会话人格）', () => {
  const prev = { role: '小鲸鱼', mode: 'active', byKey: { 'group:1': '猫娘' } };
  assert.deepEqual(mergeRoleState(prev, { role: '傲娇助手', mode: 'silent' }), {
    role: '傲娇助手',
    mode: 'silent',
    byKey: { 'group:1': '猫娘' },
  });
  assert.deepEqual(mergeRoleState(prev, { byKey: {} }), { role: '小鲸鱼', mode: 'active', byKey: {} });
  assert.deepEqual(mergeRoleState(prev, {}), prev);
});

test('状态归一化：非法 key / 非字符串人格名 / 脏字符都被挡在读入点', () => {
  const state = normalizeRoleState({
    role: ' 小鲸鱼/../x ',
    mode: 'whatever',
    byKey: {
      'group:001': '猫娘',
      'friend:2': '猫娘',
      'group:0': '猫娘',
      'private:3': '  坏/名 ',
      'group:4': null,
      'group:5': 123,
      'group:6': '',
    },
  });
  assert.equal(state.role, '小鲸鱼x', '路径字符应被清掉');
  assert.equal(state.mode, 'active', '非法 mode 归一为 active');
  assert.deepEqual(state.byKey, { 'group:1': '猫娘', 'private:3': '坏名' });
});

test('状态归一化：byKey 条数受上限约束', () => {
  const byKey = {};
  for (let i = 1; i <= 10; i += 1) byKey[`group:${i}`] = '猫娘';
  const state = normalizeRoleState({ role: null, byKey }, 3);
  assert.equal(Object.keys(state.byKey).length, 3);
});

test('设置/清除会话例外：保留其他会话与默认人格，且不改原对象', () => {
  const prev = { role: '小鲸鱼', mode: 'silent', byKey: { 'group:1': '猫娘', 'group:2': '傲娇助手' } };
  const added = applyRoleAssignment(prev, 'group:3', ' 温柔/助手 ');
  assert.equal(added.role, '小鲸鱼');
  assert.equal(added.mode, 'silent');
  assert.deepEqual(added.byKey, { 'group:1': '猫娘', 'group:2': '傲娇助手', 'group:3': '温柔助手' });
  assert.equal(prev.byKey['group:3'], undefined, '不应修改传入对象');
  const removed = applyRoleAssignment(added, 'group:1', null);
  assert.deepEqual(removed.byKey, { 'group:2': '傲娇助手', 'group:3': '温柔助手' });
  assert.equal(applyRoleAssignment(prev, 'group:x', '猫娘'), null);
});
test('行为合同：反驳主人 / 反驳 都解析成 vetoOwner', () => {
  const card = ['## 行为合同', '- 主动：偶尔插一句', '- 反驳主人：15%'].join('\n');
  assert.equal(parseBehaviorContract(card).vetoOwner, '15%');
  assert.equal(parseBehaviorContract('## 行为合同\n- 反驳：0.2').vetoOwner, '0.2');
  assert.equal(parseBehaviorContract('## 行为合同\n- 主动：正常').vetoOwner, undefined);
});
