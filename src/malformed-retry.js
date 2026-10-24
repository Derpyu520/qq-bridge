// 坏 JSON 修复重试（bridge 侧最后一道保险）。
//
// 背景（私聊会话三次，群聊没有出现）：
// 模型偶发把**工具调用参数**写成非法 JSON（长中文、裸换行、未转义引号都踩过），
// dsh-llm-deepseek 在 message_stop 之后对每个 tool-call 的 arguments 做 JSON.parse，
// 失败就整轮判 `MALFORMED_RESPONSE`（文案：DeepSeek Messages stream: tool input is invalid JSON）。
// profile 的 retryPolicy 已经把 MALFORMED_RESPONSE 列为可重试，但 provider 的重试**复用同一段上下文**，
// 模型照旧那种写法坏，5 次指数退避（0.5+1+2+4+8≈15.5s）白等，最后一轮直接报错。
//
// 桥接能做的是「换一种问法再试一次」：把一句明确点出问题的话作为新消息投回同一会话，
// 新采样 + 上下文被这句话改变，坏法通常不会再复现；只在冷却窗口内补一次，避免反复烧 token。
// 纯函数放在这里，方便单测（bridge.js 里只留 wire-up）。

/** 同一个会话两次补跑之间的最小间隔。 */
export const MALFORMED_RETRY_COOLDOWN_MS = 5 * 60 * 1000;

/** 补跑时投回的提示：只说清楚「上一轮死在哪儿」，不重述业务内容（上下文里都有）。 */
export const MALFORMED_RETRY_HINT = [
  '（系统提示，不是对方发的话）你上一轮整轮失败了：工具调用参数不是合法 JSON。',
  '请重新做刚才那件事。注意：工具参数尽量短；参数里的文本不要出现裸换行，也不要自己拼长 JSON；',
  '内容长就拆成多条消息分别发。'
].join('');

/** MALFORMED_RESPONSE 判定（大小写不敏感；provider 可能给 'malformed_response'）。 */
export function isMalformedCode(code) {
  return String(code ?? '').trim().toUpperCase() === 'MALFORMED_RESPONSE';
}

/**
 * 申请一次补跑机会。
 * @param {Map<string, number>} store 每个会话最近一次补跑的时间戳
 * @param {string} key 会话键（private:xxx / group:xxx）
 * @param {number} [now] 当前时间
 * @param {number} [cooldownMs] 冷却窗口
 * @returns {boolean} true=可以补跑（已记下本次时间）；false=冷却中或 key 非法
 */
export function claimMalformedRetry(store, key, now = Date.now(), cooldownMs = MALFORMED_RETRY_COOLDOWN_MS) {
  if (!store || typeof store.set !== 'function') return false;
  if (!key || typeof key !== 'string') return false;
  const last = store.get(key) ?? 0;
  if (last && now - last < cooldownMs) return false;
  store.set(key, now);
  return true;
}
// ── 回合被中断的补跑（2026-10-18 加）───────────────────────────────────────
// 现象：DSH UI 里出现 "The tool call was interrupted after it was recorded, but no result
// was durably recorded" / "...interrupted before the Harness recorded it as started"。
// 来源是 dsh-session 的 interruptedTurnClosers()（repair.js:15-24），只在**会话重新打开**时
// 给「开了头却没落盘结果」的回合补合成事件 —— 也就是 Harness 进程在回合中途死了/被强杀。
// 实测一次真实伤害：私聊会话 turn 7，死在 qq_send_message 调用中途，
// 那句回复没发出去，而 bridge 只认 completed/error/aborted，interrupted 被静默丢弃。
// 所以这里补一次「回头检查一下」的补跑，冷却窗口内只补一次。

export const INTERRUPT_RETRY_COOLDOWN_MS = 5 * 60 * 1000;

export const INTERRUPT_RETRY_HINT = '（系统提示，不是对方发的话）你上一轮做到一半被打断了（harness 重启/被杀），可能有一句话没发出去。先自己看一遍：有没有该回还没回的消息、有没有发了一半的回复。需要就补上（别重复已经发出去的内容），确认都回过了就继续潜水，别把这段提示说出来。';

