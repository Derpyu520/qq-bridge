import { describe, it, expect } from 'vitest';
import { mdToPlain, splitForQQ } from '../src/md-to-plain.js';

describe('mdToPlain', () => {
  it('去掉代码块围栏（含语言标注）', () => {
    expect(mdToPlain('a\n```js\nconsole.log(1)\n```\nb')).toBe('a\nconsole.log(1)\nb');
  });
  it('去掉行内代码反引号', () => {
    expect(mdToPlain('use `npm i` now')).toBe('use npm i now');
  });
  it('链接保留文字+地址', () => {
    expect(mdToPlain('[docs](https://x.com/a)')).toBe('docs (https://x.com/a)');
  });
  it('图片保留替代文字', () => {
    expect(mdToPlain('![logo](https://x.com/l.png)')).toBe('logo');
  });
  it('去除粗体/斜体/删除线标记', () => {
    expect(mdToPlain('**bold** *it* ~~del~~')).toBe('bold it del');
  });
  it('去除标题符', () => {
    expect(mdToPlain('# 标题\n## 二级')).toBe('标题\n二级');
  });
  it('去除引用符', () => {
    expect(mdToPlain('> 引用')).toBe('引用');
  });
  it('列表符转为项目符号', () => {
    expect(mdToPlain('- 甲\n- 乙\n1. 丙')).toBe('• 甲\n• 乙\n1. 丙');
  });
});

describe('splitForQQ', () => {
  it('长 emoji 文本被切分且不切断代理对', () => {
    const emoji = '😀'.repeat(3000);
    const parts = splitForQQ(emoji, 4000);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      for (let i = 0; i < p.length; i++) {
        const c = p.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
          expect(p.charCodeAt(i + 1)).toBeGreaterThanOrEqual(0xdc00);
          expect(p.charCodeAt(i + 1)).toBeLessThanOrEqual(0xdfff);
        }
      }
    }
    expect(parts.join('')).toBe(emoji);
  });

  it('换行切分时内容完整保留', () => {
    const lines = 'abc\n'.repeat(2000);
    const parts = splitForQQ(lines, 4000);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join('')).toBe(lines);
  });

  it('混合内容完整保留', () => {
    const mixed = '第一行内容😀\n第二行内容🀄\n'.repeat(1000) + '尾部';
    expect(splitForQQ(mixed, 4000).join('')).toBe(mixed);
  });

  it('短文本不切分', () => {
    expect(splitForQQ('你好世界', 4000)).toHaveLength(1);
  });
});
