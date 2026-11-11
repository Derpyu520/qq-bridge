// 人格卡按仿真模式取用（src/text/role-card.js）的离线单测。
// 保证：模式标记能被正确识别与剥离、未标记的老卡片行为不变、真实人格卡可用。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { normalizeRoleCard, parseRoleCardJson, parseRoleSections, roleCardFromText, roleCardToJson, roleCardToText, roleCharStats, roleSectionReport, selectRoleText } from '../../../src/text/role-card.js';

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

test('Markdown 卡可以无损转成 JSON 卡，筛选结果一致', () => {
  const card = roleCardFromText(CARD);
  const parsed = parseRoleCardJson(roleCardToJson(card));
  const text = roleCardToText(parsed);
  assert.equal(selectRoleText(text, 'v1'), selectRoleText(CARD, 'v1'));
  assert.equal(selectRoleText(text, 'v2'), selectRoleText(CARD, 'v2'));
  assert.match(text, /〔一代〕/);
  assert.match(text, /〔二代〕/);
});

test('JSON 卡校验：拒绝坏 JSON / 坏模式 / 空节 / 重复标题 / 未知字段', () => {
  assert.throws(() => parseRoleCardJson('{'), /JSON 解析失败/);
  assert.throws(() => normalizeRoleCard({ sections: [] }), /sections 必须是非空数组/);
  assert.throws(() => normalizeRoleCard({ sections: [{ mode: 'v3', text: 'x' }] }), /mode 只能是/);
  assert.throws(() => normalizeRoleCard({ sections: [{ text: '   ' }] }), /text 不能为空/);
  assert.throws(() => normalizeRoleCard({ sections: [{ heading: 'A', text: 'x' }, { heading: 'A', text: 'y' }] }), /小节重复/);
  // 同一标题按 v1/v2 各写一份是合法用法
  assert.doesNotThrow(() => normalizeRoleCard({ sections: [{ mode: 'v1', heading: 'A', text: 'x' }, { mode: 'v2', heading: 'A', text: 'y' }] }));
  assert.throws(() => normalizeRoleCard({ sections: [{ text: 'x' }], typo: 1 }), /未知字段/);
  // 只有标题没有正文的小节是合法的（顶层标题常见）
  assert.doesNotThrow(() => normalizeRoleCard({ sections: [{ heading: '标题', text: '' }, { text: '正文' }] }));
});

test('真实 JSON 人格卡可用，且筛选不丢公共内容', () => {
  const file = new URL('../../../roles/小鲸鱼.json', import.meta.url);
  const card = parseRoleCardJson(fs.readFileSync(file, 'utf8'));
  const rendered = roleCardToText(card);
  const v2 = selectRoleText(rendered, 'v2');
  const v1 = selectRoleText(rendered, 'v1');
  assert.ok(v2.length > 0 && v1.length > 0);
  // 人设部分两种模式都必须保留
  for (const text of [v1, v2]) {
    assert.match(text, /小鲸鱼/);
    assert.match(text, /AI 味|去 AI 味/);
  }
  // 二代注入的文本里不应再出现一代的分条机制
  assert.doesNotMatch(v2, /空格分隔（例如|\[SILENT\]/);
});
