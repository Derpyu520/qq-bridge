// 黑话条目的「对外形状」。
//
// 从 bridge.js 的 main() 里搬出来：它不碰任何闭包状态，只做字段兜底，
// 但被控制台、注入提示词、导出接口三处共用，字段少了会在某处静默变成 undefined。
import { SLANG_STATUS } from './slang-learner.js';

export function publicSlangEntry(e) {
  return {
    id: e?.id ?? '',
    content: e?.content ?? '',
    meaning: e?.meaning ?? '',
    usage: e?.usage ?? '',
    example: e?.example ?? '',
    risk: e?.risk ?? '',
    status: e?.status ?? SLANG_STATUS.CANDIDATE,
    source: e?.source ?? 'ai',
    count: Number(e?.count) || 0,
    updatedAt: e?.updatedAt ?? ''
  };
}
