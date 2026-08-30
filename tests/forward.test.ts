import { describe, it, expect } from 'vitest';
import {
  sanitizeForwardId,
  extractForwardIds,
  formatForwardResponse,
  nodeText,
} from '../src/forward.js';

describe('sanitizeForwardId', () => {
  it('接受普通 id 与常见符号', () => {
    expect(sanitizeForwardId('abc_123-456')).toBe('abc_123-456');
    expect(sanitizeForwardId('a/b:c=d+e@f.g')).toBe('a/b:c=d+e@f.g');
  });
  it('拒绝空白/控制字符', () => {
    expect(sanitizeForwardId('abc def')).toBe('');
    expect(sanitizeForwardId('a\tb')).toBe('');
  });
  it('拒绝超长 id 与空值', () => {
    expect(sanitizeForwardId('x'.repeat(300))).toBe('');
    expect(sanitizeForwardId('')).toBe('');
    expect(sanitizeForwardId(null)).toBe('');
  });
});

describe('extractForwardIds', () => {
  const segments = [
    { type: 'text', data: { text: '看这个' } },
    { type: 'forward', data: { id: 'fwd_001' } },
    { type: 'forward', data: { res_id: 'fwd_002' } },
    { type: 'forward', data: { id: 'fwd_001' } },
    { type: 'forward', data: { id: 'bad id' } },
  ];
  it('提取并去重', () => {
    expect(extractForwardIds(segments)).toEqual(['fwd_001', 'fwd_002']);
  });
  it('忽略非法 id', () => {
    expect(extractForwardIds(segments)).not.toContain('bad id');
  });
  it('非数组返回空', () => {
    expect(extractForwardIds(null)).toEqual([]);
  });
});

describe('formatForwardResponse / nodeText', () => {
  const data = {
    messages: [
      { sender: { nickname: '张三', user_id: 10001 }, time: 1700000000, message: [{ type: 'text', data: { text: '第一句' } }, { type: 'image', data: { url: 'https://example.com/a.jpg' } }, { type: 'forward', data: { id: 'nested_001' } }] },
      { sender: '李四', time: 1700000001, message: '第二句' },
      { sender: { card: '王五', user_id: 10003 }, time: 1700000002, content: [{ type: 'at', data: { qq: 10001 } }, { type: 'text', data: { text: ' 你好' } }] },
    ],
  };
  it('total 与发送者/文本提取', () => {
    const fmt = formatForwardResponse(data);
    expect(fmt.total).toBe(3);
    expect(fmt.messages).toHaveLength(3);
    expect(fmt.messages[0].sender).toBe('张三');
    expect(fmt.messages[0].text).toBe('第一句[图片][转发]');
    expect(fmt.messages[1].sender).toBe('李四');
    expect(fmt.messages[1].text).toBe('第二句');
  });
  it('nodeText 兼容 content 数组', () => {
    expect(nodeText(data.messages[2])).toBe('@10001 你好');
  });
  it('暴露图片 media 与嵌套 forward id', () => {
    const fmt = formatForwardResponse(data);
    expect(fmt.messages[0].media).toHaveLength(1);
    expect((fmt.messages[0].media[0] as any).url).toBe('https://example.com/a.jpg');
    expect(fmt.messages[0].nestedForwardIds).toEqual(['nested_001']);
  });
  it('暴露 messageId/messageSeq', () => {
    const fmt = formatForwardResponse(data);
    expect(fmt.messages[1].messageId).toBeNull();
    expect(fmt.messages[1].messageSeq).toBeNull();
  });
  it('按数量/字符截断', () => {
    const truncated = formatForwardResponse(data, { maxMessages: 2, maxCharsPerMessage: 1 });
    expect(truncated.total).toBe(3);
    expect(truncated.truncated).toBe(true);
    expect(truncated.messages).toHaveLength(2);
    expect(truncated.messages[0].text.length).toBeLessThanOrEqual(1);
    expect(truncated.textTruncated).toBe(true);
  });
  it('空 messages', () => {
    const empty = formatForwardResponse({ messages: [] });
    expect(empty.total).toBe(0);
    expect(empty.truncated).toBe(false);
    expect(empty.messages).toHaveLength(0);
  });
  it('sender 空 nickname 回退到 card', () => {
    const r = formatForwardResponse({ messages: [{ sender: { nickname: '', card: '王五', user_id: 10003 }, message: 'x' }] });
    expect(r.messages[0].sender).toBe('王五');
  });
  it('兼容标准 node.data 结构', () => {
    const nodeData = { messages: [{ type: 'node', data: { name: '张三', uin: '10001', time: 1700000000, content: [{ type: 'text', data: { text: '你好' } }] } }] };
    const fmtNode = formatForwardResponse(nodeData);
    expect(fmtNode.messages[0].sender).toBe('张三');
    expect(fmtNode.messages[0].text).toBe('你好');
    expect(fmtNode.messages[0].userId).toBe('10001');
    expect(fmtNode.messages[0].time).toBe(1700000000);
  });
  it('nodeText 清洗 CQ 字符串', () => {
    expect(nodeText({ message: '[CQ:image,file=x]' })).toBe('[媒体]');
  });
});
