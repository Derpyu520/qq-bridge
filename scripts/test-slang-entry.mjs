// publicSlangEntry 的字段兜底：控制台、提示词注入、导出接口三处共用同一个形状。
import { publicSlangEntry } from '../src/slang-entry.js';
import { SLANG_STATUS } from '../src/slang-learner.js';

let pass = 0;
const failures = [];
function test(name, fn) {
  try { fn(); pass++; console.log(`PASS ${name}`); }
  catch (e) { failures.push(name); console.log(`FAIL ${name} — ${e.message}`); }
}
function eq(a, b, msg = '') { if (a !== b) throw new Error(`${msg} 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`); }

test('完整条目原样带出', () => {
  const out = publicSlangEntry({
    id: 'x1', content: 'yyds', meaning: '永远的神', usage: '夸人',
    example: 'yyds 了', risk: 'low', status: SLANG_STATUS.CONFIRMED,
    source: 'admin', count: 7, updatedAt: '2026-10-26T00:00:00.000Z'
  });
  eq(out.content, 'yyds');
  eq(out.meaning, '永远的神');
  eq(out.status, SLANG_STATUS.CONFIRMED);
  eq(out.count, 7);
});

test('空对象也不会漏字段：status 回 candidate、source 回 ai、count 回 0', () => {
  const out = publicSlangEntry({});
  eq(out.status, SLANG_STATUS.CANDIDATE);
  eq(out.source, 'ai');
  eq(out.count, 0);
  for (const k of ['id', 'content', 'meaning', 'usage', 'example', 'risk', 'updatedAt']) eq(out[k], '', `${k}:`);
});

test('undefined / null 输入同样安全', () => {
  for (const input of [undefined, null]) {
    const out = publicSlangEntry(input);
    eq(out.status, SLANG_STATUS.CANDIDATE);
    eq(out.count, 0);
  }
});

test('count 是脏值时收敛成 0（不是 NaN）', () => {
  eq(publicSlangEntry({ count: 'abc' }).count, 0);
  eq(publicSlangEntry({ count: null }).count, 0);
});

test('不允许的 status 原样透传（这里只做兜底，不做校验）', () => {
  eq(publicSlangEntry({ status: 'weird' }).status, 'weird');
});

console.log('');
if (failures.length) { console.log(`${failures.length} 项失败`); process.exit(1); }
console.log('全部通过');
