import { describe, it, expect } from 'vitest';
import {
  randInt,
  singleLineForQQ,
  splitLongSegment,
  planSocialTimeline,
  findCjkSpaceWarning,
  findSplitBoundaryWarning,
  computeGapsV2,
  clampGapV2,
} from '../src/format.js';

describe('randInt', () => {
  it('结果落在 [min, max] 区间', () => {
    for (let i = 0; i < 100; i++) {
      const n = randInt(3, 8);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(8);
    }
  });
  it('min > max 时自动交换', () => {
    for (let i = 0; i < 50; i++) {
      const n = randInt(8, 3);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(8);
    }
  });
});

describe('singleLineForQQ / splitLongSegment', () => {
  it('压缩换行与多余空格', () => {
    expect(singleLineForQQ('a\n  b\t c')).toBe('a b c');
  });
  it('按长度切分并保留 URL', () => {
    const parts = splitLongSegment('看这个 https://example.com/abc 然后继续', 10);
    expect(parts.join('')).toBe('看这个 https://example.com/abc 然后继续');
  });
});

describe('planSocialTimeline', () => {
  it('中文空格拆成多条', () => {
    const r = planSocialTimeline('第一句 第二句 第三句', { maxReplyChars: 500, burstEnabled: true });
    expect(r.main).toEqual(['第一句', '第二句', '第三句']);
  });
  it('禁用拆条时合并为一条', () => {
    const r = planSocialTimeline('第一句 第二句', { maxReplyChars: 500, burstEnabled: false });
    expect(r.main).toEqual(['第一句 第二句']);
  });
});

describe('findCjkSpaceWarning', () => {
  it('中文空格给出提示', () => {
    expect(findCjkSpaceWarning(['你 好'])).toContain('第 1 条');
  });
  it('无中文空格返回 null', () => {
    expect(findCjkSpaceWarning(['你好 hello world'])).toBeNull();
  });
});

describe('findSplitBoundaryWarning', () => {
  it('识别逗号结尾的拆句', () => {
    expect(findSplitBoundaryWarning(['我想说，', '第二句'])).toContain('1、2');
  });
  it('完整短句不误报', () => {
    expect(findSplitBoundaryWarning(['好的', '知道了'])).toBeNull();
  });
});

describe('computeGapsV2', () => {
  it('单条消息无间隔', () => {
    expect(computeGapsV2(['a'], 'auto', undefined, undefined, {})).toEqual([]);
  });
  it('fixed 模式逐条间隔', () => {
    const gaps = computeGapsV2(['a', 'b', 'c'], 'fixed', 1500, undefined, { burstIntervalMinMs: 1000, maxGapMs: 10000 });
    expect(gaps).toEqual([1500, 1500]);
  });
  it('byLength 按字数计算', () => {
    const gaps = computeGapsV2(['你好', '世界'], 'byLength', undefined, undefined, { gapBaseMs: 800, gapPerCharMs: 20, burstIntervalMinMs: 1000, maxGapMs: 10000 });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toBeGreaterThanOrEqual(800);
  });
  it('clampGapV2 限制在 min/max 内', () => {
    expect(clampGapV2(10, { burstIntervalMinMs: 1000, maxGapMs: 10000 })).toBe(1000);
    expect(clampGapV2(99999, { burstIntervalMinMs: 1000, maxGapMs: 10000 })).toBe(10000);
  });
});
