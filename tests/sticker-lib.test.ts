import { describe, it, expect } from 'vitest';
import {
  normalizeStickerEntry,
  mergeStickerLibrary,
  findSticker,
  formatStickerList,
  buildStickerContext,
  buildStickerStrategyHint,
  applyStickerNote,
  markStickerUsed,
} from '../src/sticker-lib.js';

describe('normalizeStickerEntry', () => {
  it('基本字段归一化', () => {
    const raw = normalizeStickerEntry({ emoji_id: 'a', resId: 'a', url: 'https://x/a', md5: 'abc', desc: '笑死', localNote: '嘲讽', tags: ['怼人'] });
    expect(raw?.id).toBe('a');
    expect(raw?.desc).toBe('笑死');
    expect(raw?.localNote).toBe('嘲讽');
  });
  it('空记录返回 null', () => {
    expect(normalizeStickerEntry({})).toBeNull();
  });
});

describe('mergeStickerLibrary', () => {
  it('新增并更新 QQ 字段、移除 QQ 端已删除表情', () => {
    const base = mergeStickerLibrary([], [
      { emoji_id: 'a', resId: 'a', url: 'https://x/a', md5: 'ABC', desc: '笑死' },
      { emoji_id: 'b', resId: 'b', url: 'https://x/b', md5: 'DEF', desc: '' },
    ]);
    expect(base).toHaveLength(2);
    const merged = mergeStickerLibrary(base, [{ emoji_id: 'a', resId: 'a', url: 'https://x/a2', md5: 'ABC', desc: '笑哭' }]);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe('a');
    expect(merged[0].url).toBe('https://x/a2');
    expect(merged[0].desc).toBe('笑哭');
  });
});

describe('findSticker', () => {
  const list = mergeStickerLibrary([], [
    { emoji_id: 'a', resId: 'a', url: 'https://x/a', md5: 'ABC', desc: '笑死' },
    { emoji_id: 'b', resId: 'b', url: 'https://x/b', md5: 'DEF', desc: '生气' },
  ]);
  it('按 emoji_id / md5 / url 查找', () => {
    expect(findSticker(list, 'a')?.id).toBe('a');
    expect(findSticker(list, 'abc')?.id).toBe('a');
    expect(findSticker(list, 'https://x/b')?.id).toBe('b');
    expect(findSticker(list, '不存在')).toBeNull();
  });
});

describe('formatStickerList', () => {
  const list = [
    normalizeStickerEntry({ emoji_id: 'a', resId: 'a', url: 'https://x/a', md5: 'ABC', desc: '笑死' })!,
    normalizeStickerEntry({ emoji_id: 'b', resId: 'b', url: 'https://x/b', md5: 'DEF', desc: '生气' })!,
    normalizeStickerEntry({ emoji_id: 'c', resId: 'c', url: 'https://x/c', md5: 'GHI', desc: '', localNote: '无语' })!,
  ];
  it('总数与按备注/本地笔记搜索', () => {
    expect(formatStickerList(list, '', 10).total).toBe(3);
    expect(formatStickerList(list, '生气', 10).stickers[0].id).toBe('b');
    expect(formatStickerList(list, '无语', 10).stickers[0].id).toBe('c');
  });
  it('buildStickerContext 包含备注', () => {
    expect(buildStickerContext(list, 8)).toContain('笑死');
  });
  it('策略提示包含发送工具', () => {
    expect(buildStickerStrategyHint()).toContain('qq_send_sticker');
  });
});

describe('applyStickerNote / markStickerUsed', () => {
  it('写入本地认知并记录使用', () => {
    const list = mergeStickerLibrary([], [{ emoji_id: 'a', resId: 'a', url: 'https://x/a', md5: 'ABC', desc: '笑死' }]);
    const noted = applyStickerNote(list, 'a', { note: '嘲讽用', tags: ['怼人'], usage: '别人犯蠢时' });
    expect(noted.entry?.localNote).toBe('嘲讽用');
    expect(noted.entry?.tags).toContain('怼人');
    const used = markStickerUsed(noted.entries, 'a', '接梗');
    expect(used.entry?.useCount).toBe(1);
    expect(used.entry?.lastContext).toBe('接梗');
  });
});
