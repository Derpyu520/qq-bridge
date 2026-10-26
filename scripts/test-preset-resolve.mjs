// preset 解析的 fail-closed 行为：群聊会话不许回落到 DSH 默认 preset。
//
// 这条规则守的是「群友不能驱动带本地工具的 agent」。回退一次就等于开一个口子，
// 所以每个分支都单独钉住。
import { resolvePresetName } from '../src/preset-resolve.js';

let pass = 0;
const failures = [];
function test(name, fn) {
  try { fn(); pass++; console.log(`PASS ${name}`); }
  catch (e) { failures.push(name); console.log(`FAIL ${name} — ${e.message}`); }
}
function eq(a, b, msg = '') { if (a !== b) throw new Error(`${msg} 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); }

const IDS = ['qq-chat-v2', 'standard'];
const DEF = 'standard';

test('名字在清单里：原样返回（strict 与否都一样）', () => {
  eq(resolvePresetName('qq-chat-v2', { strict: true, presetIds: IDS, defaultPreset: DEF }), 'qq-chat-v2');
  eq(resolvePresetName('qq-chat-v2', { strict: false, presetIds: IDS, defaultPreset: DEF }), 'qq-chat-v2');
});

test('strict 且清单里没有：返回空串，绝不回落到默认 preset', () => {
  eq(resolvePresetName('qq-chat-v2', { strict: true, presetIds: ['standard'], defaultPreset: DEF }), '');
});

test('strict 且清单为空（DSH 没报可用 preset）：返回空串', () => {
  eq(resolvePresetName('qq-chat-v2', { strict: true, presetIds: [], defaultPreset: DEF }), '');
});

test('非 strict 且清单里没有：回落到默认 preset', () => {
  eq(resolvePresetName('qq-chat-v2', { strict: false, presetIds: ['standard'], defaultPreset: DEF }), 'standard');
});

test('非 strict 且清单为空：原样信任请求的名字（closed-agent 场景）', () => {
  eq(resolvePresetName('qq-chat-v2', { strict: false, presetIds: [], defaultPreset: DEF }), 'qq-chat-v2');
});

test('名字为空：strict 返回空串，非 strict 回落默认', () => {
  eq(resolvePresetName('', { strict: true, presetIds: IDS, defaultPreset: DEF }), '');
  eq(resolvePresetName('', { strict: false, presetIds: IDS, defaultPreset: DEF }), 'standard');
  eq(resolvePresetName(undefined, { strict: false, presetIds: IDS, defaultPreset: DEF }), 'standard');
});

test('默认 preset 本身为空时不返回 undefined', () => {
  eq(resolvePresetName('nope', { strict: false, presetIds: IDS, defaultPreset: '' }), '');
});

test('warn 记录两段：先说不认识，再说拒绝回退', () => {
  const msgs = [];
  resolvePresetName('nope', { strict: true, presetIds: IDS, defaultPreset: DEF, warn: (m) => msgs.push(m) });
  eq(msgs.length, 2);
  if (!msgs[0].includes('不在 DSH 可用清单')) throw new Error(`第一段不对：${msgs[0]}`);
  if (!msgs[1].includes('拒绝回退')) throw new Error(`第二段不对：${msgs[1]}`);
});

test('非 strict 只 warn 一次（不该喊「拒绝回退」）', () => {
  const msgs = [];
  resolvePresetName('nope', { strict: false, presetIds: IDS, defaultPreset: DEF, warn: (m) => msgs.push(m) });
  eq(msgs.length, 1);
});

test('名字前后空格会被 trim', () => {
  eq(resolvePresetName('  qq-chat-v2 ', { strict: true, presetIds: IDS, defaultPreset: DEF }), 'qq-chat-v2');
});

console.log('');
if (failures.length) { console.log(`${failures.length} 项失败`); process.exit(1); }
console.log('全部通过');
