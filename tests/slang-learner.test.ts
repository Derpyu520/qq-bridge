import { describe, it, expect } from 'vitest';
import {
  normalizeSlangEntry,
  createSlangEntry,
  parseResearchJson,
  parseExtractionJson,
  buildResearchPrompt,
  buildSlangContext,
  buildExtractionPrompt,
  mergeEvidence,
  upsertSlangEntry,
  SLANG_STATUS,
} from '../src/slang-learner.js';
import type { SlangEntry } from '../src/slang-learner.js';

describe('normalizeSlangEntry', () => {
  it('保留/清洗 sources，过滤空串并限长', () => {
    const e = normalizeSlangEntry({
      content: 'yyds',
      sources: ['https://example.com/a', '', ' https://example.com/b '],
    });
    expect(e.sources).toEqual(['https://example.com/a', 'https://example.com/b']);
  });
});

describe('createSlangEntry', () => {
  it('支持 sources', () => {
    const e = createSlangEntry({ content: 'xswl', sources: ['https://example.com'] });
    expect(e.sources).toEqual(['https://example.com']);
  });
});

describe('parseResearchJson', () => {
  it('解析 sources', () => {
    const out = parseResearchJson('[{"content":"yyds","meaning":"永远的神","sources":["https://a",""]}]');
    expect(out).toHaveLength(1);
    expect(out[0].sources).toEqual(['https://a']);
  });
});

describe('parseExtractionJson', () => {
  it('解析 content/source_id', () => {
    const out = parseExtractionJson('[{"content":"yyds","source_id":"1"},{"content":"xswl"}]');
    expect(out).toEqual([
      { content: 'yyds', source_id: '1' },
      { content: 'xswl', source_id: '' },
    ]);
  });
  it('容忍非 JSON 包裹文本', () => {
    const out = parseExtractionJson('结果如下：[{"content":"yyds","source_id":"1"}]');
    expect(out).toEqual([{ content: 'yyds', source_id: '1' }]);
  });
});

describe('buildResearchPrompt', () => {
  it('要求深度联网与 sources', () => {
    const prompt = buildResearchPrompt([{ content: 'yyds', evidence: [{ text: '这波 yyds' }] } as unknown as SlangEntry]);
    expect(prompt).toContain('web_fetch');
    expect(prompt).toContain('"sources"');
    expect(prompt).toContain('深度联网考究');
  });
});

describe('buildSlangContext', () => {
  it('只注入已确认且有含义的词条', () => {
    const ctx = buildSlangContext([
      { content: 'a', meaning: '甲', status: SLANG_STATUS.CONFIRMED, count: 2 },
      { content: 'b', meaning: '', status: SLANG_STATUS.CONFIRMED, count: 1 },
      { content: 'c', meaning: '丙', status: SLANG_STATUS.CANDIDATE, count: 9 },
    ] as unknown as SlangEntry[], 8);
    expect(ctx).toContain('a：甲');
    expect(ctx).not.toContain('b：');
    expect(ctx).not.toContain('c：丙');
  });
});

describe('buildExtractionPrompt', () => {
  it('转义不可信文本', () => {
    const prompt = buildExtractionPrompt([{ sender: '<x>', text: 'a & b' }]);
    expect(prompt).toContain('&lt;x&gt;');
    expect(prompt).toContain('a &amp; b');
  });
});

describe('mergeEvidence', () => {
  it('去重并限长', () => {
    const merged = mergeEvidence([{ text: 'a' }], [{ text: 'a' }, { text: 'b' }]);
    expect(merged).toEqual([{ text: 'a' }, { text: 'b' }]);
  });
});

describe('upsertSlangEntry', () => {
  it('新增候选', () => {
    const entries: SlangEntry[] = [];
    const r = upsertSlangEntry(entries, 'yyds');
    expect(r.created).toBe(true);
    expect(r.entry?.content).toBe('yyds');
    expect(r.entry?.status).toBe(SLANG_STATUS.CANDIDATE);
  });
  it('已存在则累计次数', () => {
    const entries: SlangEntry[] = [createSlangEntry({ content: 'yyds' })];
    const r = upsertSlangEntry(entries, 'yyds');
    expect(r.created).toBe(false);
    expect(r.entry?.count).toBe(2);
  });
});
