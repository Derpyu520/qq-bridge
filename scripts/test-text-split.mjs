// src/qq-text-split.js 的单测。
//
// 这批函数原本长在 bridge.js 的 main() 里，测试只能把源码抠出来 eval（见 test-voice.mjs
// 里那段历史）。2026-10-26 抽成模块后，这里正面钉住它们的行为：
//   1. 长段落切分：URL 整条保留、代理对（emoji）不被切成半个、不丢内容；
//   2. 空格分条：AI 用空格表示"这里要断一条"，中英混排也认；
//   3. singleLineForQQ：换行折成空格、连续空白压成一个；
//   4. planSocialTimeline：关分条时整条只做安全硬拆，开分条时按空格拆。
import assert from 'node:assert/strict';
import {
  isCjkChar, planSocialTimeline, singleLineForQQ, splitByCjkSpaces, splitLongSegment,
} from '../src/qq-text-split.js';

let failures = 0;
function test(name, run) {
  try { run(); console.log('PASS', name); }
  catch (error) { failures += 1; console.error('FAIL', name, '—', error?.stack ?? error); }
}

test('singleLineForQQ 把换行折成空格并压掉多余空白', () => {
  assert.equal(singleLineForQQ('第一行\n第二行'), '第一行 第二行');
  // 注意：只压「连续两个以上」的空格/制表符，单个 tab 原样保留 —— 这是既有行为，
  // 在 QQ 里不显形；为了好看改它只会多一处不可预期的回归面。
  assert.equal(singleLineForQQ('  多   个空格  '), '多 个空格');
  assert.equal(singleLineForQQ(null), '');
});

test('isCjkChar 只认汉字，不认中文标点和全角符号', () => {
  assert.equal(isCjkChar('你'), true);
  assert.equal(isCjkChar('，'), false);
  assert.equal(isCjkChar('A'), false);
  assert.equal(isCjkChar(''), false);
});

test('短文本原样返回一条', () => {
  assert.deepEqual(splitLongSegment('短消息', 500), ['短消息']);
  assert.deepEqual(splitLongSegment('', 500), []);
  assert.deepEqual(splitLongSegment(null, 500), []);
});

test('长文本被切开，但内容一点不丢', () => {
  const src = '啊'.repeat(1200);
  const parts = splitLongSegment(src, 500);
  assert.ok(parts.length >= 3, `应至少切 3 段，实际 ${parts.length}`);
  assert.equal(parts.join(''), src, '拼回去必须与原文一致');
  for (const p of parts) assert.ok(p.length <= 500, `单段不得超过 500：${p.length}`);
});

test('URL 在任意长度下都整条保留，不漏 NUL 占位符', () => {
  const url = 'https://example.com/very/long/path?q=1&x=2';
  for (let n = 1; n <= 520; n++) {
    const parts = splitLongSegment('啊'.repeat(n) + url, 500);
    const joined = parts.join('');
    assert.ok(joined.includes(url), `长度 ${n} 时 URL 被切断`);
    assert.ok(!joined.includes('\u0000'), `长度 ${n} 时漏出 NUL`);
    assert.ok(!joined.includes('URL0'), `长度 ${n} 时漏出占位符字面量`);
  }
});

test('两个 URL 都保留，且不会被拼成一条超长的', () => {
  const url = 'https://example.com/a?b=1';
  const joined = splitLongSegment('啊'.repeat(600) + url + '中间' + url, 500).join('');
  assert.equal(joined.split(url).length - 1, 2, '两个 URL 都要在');
});

test('emoji 不被切成半个代理对', () => {
  const emoji = '🐟';
  const parts = splitLongSegment('啊'.repeat(499) + emoji + '啊'.repeat(200), 500);
  for (const p of parts) {
    // 孤立代理：字符串里出现高位代理但下一位不是低位代理
    for (let i = 0; i < p.length; i++) {
      const code = p.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = p.charCodeAt(i + 1);
        assert.ok(next >= 0xdc00 && next <= 0xdfff, `第 ${i} 位是孤立高位代理`);
      }
    }
  }
  assert.ok(parts.join('').includes(emoji), 'emoji 本身不能丢');
});

test('max 非法时退回 500', () => {
  const parts = splitLongSegment('啊'.repeat(1200), NaN);
  for (const p of parts) assert.ok(p.length <= 500, `NAX 非法时单段仍应 ≤500：${p.length}`);
});

test('splitByCjkSpaces 按"有意的空格"分条，纯英文句子不拆', () => {
  assert.deepEqual(splitByCjkSpaces('好的 我看看'), ['好的', '我看看']);
  assert.deepEqual(splitByCjkSpaces('hello world'), ['hello world']);
  assert.deepEqual(splitByCjkSpaces('行 React 那个 我去查'), ['行', 'React', '那个', '我去查']);
  assert.deepEqual(splitByCjkSpaces('   '), []);
});

test('planSocialTimeline 关分条时整条只做硬拆', () => {
  const r = planSocialTimeline('你好 世界', { burstEnabled: false, maxReplyChars: 500 });
  assert.deepEqual(r.main, ['你好 世界'], '关分条不该按空格拆');
  assert.equal(r.followUp, null);
});

test('planSocialTimeline 开分条时按空格拆成多条', () => {
  const r = planSocialTimeline('第一句 第二句 第三句', { burstEnabled: true, maxReplyChars: 500 });
  assert.deepEqual(r.main, ['第一句', '第二句', '第三句']);
});

test('planSocialTimeline 空输入给空数组', () => {
  assert.deepEqual(planSocialTimeline('   ', {}), { main: [], followUp: null });
  assert.deepEqual(planSocialTimeline(null, {}), { main: [], followUp: null });
});

test('planSocialTimeline 的 maxReplyChars 非法时退回 500', () => {
  const r = planSocialTimeline('啊'.repeat(1200), { burstEnabled: false, maxReplyChars: 'x' });
  for (const part of r.main) assert.ok(part.length <= 500, `单段应 ≤500：${part.length}`);
});

if (failures > 0) {
  console.log(`\n${failures} 项失败`);
  process.exit(1);
}
console.log('\n全部通过');