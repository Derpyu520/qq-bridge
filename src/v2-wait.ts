// 二代仿真模式：等待/结束回合相关的轻量判断工具。
// 这些是“提示/软信号”，不是硬规则；最终是否等待、是否发催话仍由 AI 自主决定。

// 常见“话说一半/没说完”的结尾特征。
const UNFINISHED_TAIL_RE =
  /(?:你知道|等一下|我跟你讲|其实吧|但是|所以说|然后|那个|就是|我想说|对了|等我|等等|我看看|还有|再说|主要是|毕竟|因为|所以|但是吧|回头|回头说|待会|晚点|等会|再说吧)$/;

// 以中文逗号/顿号/分号/冒号等“非终止标点”结尾，也常表示还没说完。
const UNFINISHED_PUNCT_RE = /[，、；：,;:]$/;

// 明确以终止标点/省略号结尾的消息视为说完。
const FINISHED_TAIL_RE = /[。！？!?…～~]+$/;

export function looksLikeUnfinished(text: unknown): boolean {
  const s = String(text ?? '').trim();
  if (!s) return false;
  if (FINISHED_TAIL_RE.test(s)) return false;
  if (UNFINISHED_TAIL_RE.test(s)) return true;
  if (UNFINISHED_PUNCT_RE.test(s)) return true;
  return false;
}

// AI 等不到下文时可以用的“催话”短句。
export const UNFINISHED_PROMPT_REPLIES: string[] = ['什么', '啥', '你说啊', '然后呢', '？'];

// 建议的“结束前再等一轮”的等待时长范围（毫秒）。
export const END_ROUND_WAIT_MIN_MS = 5 * 60 * 1000;
export const END_ROUND_WAIT_MAX_MS = 10 * 60 * 1000;
