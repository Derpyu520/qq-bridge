import { describe, it, expect } from 'vitest';
import {
  looksLikeUnfinished,
  UNFINISHED_PROMPT_REPLIES,
  END_ROUND_WAIT_MIN_MS,
  END_ROUND_WAIT_MAX_MS,
} from '../src/v2-wait.js';

describe('looksLikeUnfinished', () => {
  const unfinished = ['你知道', '等一下', '我跟你讲', '但是', '所以说', '然后', '那个', '就是', '我想说', '对了', '等我', '等等', '我看看', '还有', '再说', '主要是', '回头说', '待会', '再说吧', '你听我说，'];
  it.each(unfinished)('未说完判定 true: %s', (text) => {
    expect(looksLikeUnfinished(text)).toBe(true);
  });

  const finished = ['', '好的', '今天好累', 'B站搜猫踩奶视频 解压一绝', '那去看跳伞第一视角视频', '你再说一遍试试', '？', '哦牛批', '这么刺激', '你说完了。'];
  it.each(finished)('已说完/普通判定 false: %s', (text) => {
    expect(looksLikeUnfinished(text)).toBe(false);
  });
});

describe('等待相关常量', () => {
  it('提供催话短句', () => {
    expect(Array.isArray(UNFINISHED_PROMPT_REPLIES)).toBe(true);
    expect(UNFINISHED_PROMPT_REPLIES.length).toBeGreaterThan(0);
  });
  it('结束前等待 5~10 分钟常量正确', () => {
    expect(END_ROUND_WAIT_MIN_MS).toBeGreaterThanOrEqual(5 * 60 * 1000);
    expect(END_ROUND_WAIT_MAX_MS).toBeGreaterThanOrEqual(END_ROUND_WAIT_MIN_MS);
  });
});
