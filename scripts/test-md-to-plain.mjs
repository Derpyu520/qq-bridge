// md-to-plain 纯函数回归测试（不依赖 SnowLuma / DSH / QQ）。
// 用法：node scripts/test-md-to-plain.mjs
import { mdToPlain, splitForQQ } from '../src/md-to-plain.js';

let failed = 0;
const assert = (name, cond, extra = '') => {
  if (!cond) failed += 1;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
};

// ── mdToPlain ────────────────────────────────────────────────────────────
assert('代码块去围栏（含语言标注）', mdToPlain('a\n```js\nconsole.log(1)\n```\nb') === 'a\nconsole.log(1)\nb');
assert('行内代码', mdToPlain('use `npm i` now') === 'use npm i now');
assert('链接保留文字+地址', mdToPlain('[docs](https://x.com/a)') === 'docs (https://x.com/a)');
assert('图片保留替代文字', mdToPlain('![logo](https://x.com/l.png)') === 'logo');
assert('粗体/斜体/删除线', mdToPlain('**bold** *it* ~~del~~') === 'bold it del');
assert('标题符', mdToPlain('# 标题\n## 二级') === '标题\n二级');
assert('引用符', mdToPlain('> 引用') === '引用');
assert('列表符', mdToPlain('- 甲\n- 乙\n1. 丙') === '• 甲\n• 乙\n1. 丙');

// ── splitForQQ ───────────────────────────────────────────────────────────
// 长 emoji 文本：不允许切断代理对
const emoji = '😀'.repeat(3000);
const parts = splitForQQ(emoji, 4000);
assert('emoji 长文本被切分', parts.length > 1);
assert('emoji 无断裂代理对', parts.every((p) => {
  for (let i = 0; i < p.length; i++) {
    const c = p.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF) return i + 1 < p.length && p.charCodeAt(i + 1) >= 0xDC00 && p.charCodeAt(i + 1) <= 0xDFFF;
  }
  return true;
}));
assert('emoji 内容完整保留', parts.join('') === emoji);

// 长行文本：换行处切断时换行符必须保留（拼接后与原文一致）
const lines = 'abc\n'.repeat(2000);
const parts2 = splitForQQ(lines, 4000);
assert('换行切分', parts2.length > 1);
assert('换行内容完整保留', parts2.join('') === lines);

// 混合内容
const mixed = ('第一行内容😀\n第二行内容🀄\n'.repeat(1000)) + '尾部';
assert('混合内容完整保留', splitForQQ(mixed, 4000).join('') === mixed);

// 短文本不切
assert('短文本不切分', splitForQQ('你好世界', 4000).length === 1);

if (failed > 0) {
  console.log(`\n❌ ${failed} 项失败`);
  process.exit(1);
}
console.log('\n🎉 md-to-plain 全部通过');
