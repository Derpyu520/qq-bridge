// 白名单与模式判定：谁能驱动这个桥。
//
// 这两条规则写错的后果不是「功能坏了」，是「群里任何人都能操作本机」，
// 所以单独测，而且把历史踩过的兼容写法（复数 key、int64 数字 id）都钉住。
import { allowed, modeAllowed } from '../src/access-rules.js';

let pass = 0;
const failures = [];
function test(name, fn) {
  try { fn(); pass++; console.log(`PASS ${name}`); }
  catch (e) { failures.push(name); console.log(`FAIL ${name} — ${e.message}`); }
}
function eq(actual, expected, msg = '') {
  if (actual !== expected) throw new Error(`${msg} 期望 ${expected}，实际 ${actual}`);
}

const cfg = (over = {}) => ({
  allow: { group: [], private: [], ...(over.allow || {}) },
  deny: { group: [], private: [], ...(over.deny || {}) },
  allowAllWhenEmpty: over.allowAllWhenEmpty ?? false,
  ownerQQ: over.ownerQQ ?? 3475994805
});

test('allow 列表为空 + allowAllWhenEmpty=true 时放行', () => {
  eq(allowed('group', 123, cfg({ allowAllWhenEmpty: true })), true);
});

test('allow 列表为空 + allowAllWhenEmpty=false 时拒绝', () => {
  eq(allowed('group', 123, cfg({ allowAllWhenEmpty: false })), false);
});

test('allow 列表命中才放行（不再看 allowAllWhenEmpty）', () => {
  const c = cfg({ allow: { group: [123] }, allowAllWhenEmpty: false });
  eq(allowed('group', 123, c), true);
  eq(allowed('group', 456, c), false);
});

test('deny 优先于 allow', () => {
  const c = cfg({ allow: { private: [999] }, deny: { private: [999] }, allowAllWhenEmpty: true });
  eq(allowed('private', 999, c), false);
});

test('id 是数字还是字符串都一样（int64 序列化差异）', () => {
  const c = cfg({ allow: { private: ['3475994805'] } });
  eq(allowed('private', 3475994805, c), true);
  eq(allowed('private', '3475994805', c), true);
});

test('配置写复数 groups/privates 也认', () => {
  eq(allowed('group', 42, { allow: { groups: [42] }, deny: {}, allowAllWhenEmpty: false }), true);
  eq(allowed('private', 42, { allow: { privates: [42] }, deny: {}, allowAllWhenEmpty: false }), true);
});

test('deny 写复数 groups 也认', () => {
  eq(allowed('group', 42, { allow: {}, deny: { groups: [42] }, allowAllWhenEmpty: true }), false);
});

test('modeAllowed：closed-agent 只认 owner 私聊，白名单里的第二个人也不行', () => {
  const c = cfg({ allow: { private: [111, 3475994805] } });
  eq(modeAllowed('private:3475994805', 'private', 3475994805, c, 'closed-agent'), true);
  eq(modeAllowed('private:111', 'private', 111, c, 'closed-agent'), false);
});

test('modeAllowed：closed-agent 下 ownerQQ 为空时只认 "private:undefined" 之外的都不行', () => {
  const c = cfg({ ownerQQ: '' });
  eq(modeAllowed('private:3475994805', 'private', 3475994805, c, 'closed-agent'), false);
});

test('modeAllowed：chat/reserved/reserved2 一律走白名单', () => {
  const c = cfg({ allow: { group: [681528723] } });
  for (const mode of ['chat', 'reserved', 'reserved2']) {
    eq(modeAllowed('group:681528723', 'group', 681528723, c, mode), true, `${mode}:`);
    eq(modeAllowed('group:1', 'group', 1, c, mode), false, `${mode}:`);
  }
});

console.log('');
if (failures.length) { console.log(`${failures.length} 项失败`); process.exit(1); }
console.log('全部通过');
