// 共享的敏感信息审计正则：桥接回复、MCP 发送、审批/提问文本等统一使用，避免两处维护不一致。
// 拦截本机路径/凭据特征；凭据关键词需带赋值关系才判定，避免误伤正常聊天。
// UNC 的主机/共享名之间只有一个反斜杠；JSON 键名可能带引号。
// 这是内容审计的启发式规则，不能代替会话权限控制或对已知令牌的精确拦截。
//
// 两道内容闸门是**有意互补**的，不是重复实现：
//   ① 这里（启发式）：抓"长得像路径 / 像凭据赋值"的文本，任何一条出站文本都能过；
//   ② KNOWN_AGENT_TOKENS 精确名单（bridge.js）：抓**已知的**会话令牌原文，
//      覆盖 onebotSend / redactKnownTokensOnly 这类刻意不跑 SENSITIVE_RE 的发送路径。
// 为什么第二条不可省：32 位十六进制的裸会话令牌**不匹配**下面的正则（它既不是路径，
// 也没有 token= 这种赋值形态），只有精确名单能拦住它。
// 反过来，**不要**为了让这条正则"顺带"覆盖裸 32-hex 而往里加 [0-9a-f]{32}：
// 表情 md5、图片 URL、消息里的十六进制串本身就是 32-hex，加进去会把正常的表情包与消息
// 整条拦掉/打码（误伤面远大于收益）。要收紧令牌泄漏，请走精确名单那条路。
// 两条分支分开维护：路径分支用于"整段拦截"，凭据分支用于 closed-agent 里**允许路径**
// 但仍要拦凭据的场景（管理员看自己的本机路径是正常的，凭据外发则没理由放行）。
const PATH_SOURCE = String.raw`(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'<>|]+|\\\\[^\\\s"'<>|]+\\[^\s"'<>|]+|(?<![A-Za-z0-9])(?:\/home\/|\/Users\/|\/etc\/|\/var\/|\/root\/)[^\s"'<>|]*`;
const CREDENTIAL_SOURCE = String.raw`(?:token|密码|密钥|口令|password|passwd|secret|api[_-]?key|authorization|bearer|access[_-]?key|credential)["']?(?:\s*(?:[:=：]|是|为)\s*["']?[^\s，。；、"']{3,}|\s+[A-Za-z0-9_\-./]{3,})`;

export const SENSITIVE_RE = new RegExp(`(${PATH_SOURCE}|${CREDENTIAL_SOURCE})`, 'i');
/** 只含"凭据赋值"分支：给那些允许出现路径、但绝不允许凭据外发的场景用。 */
export const CREDENTIAL_RE = new RegExp(CREDENTIAL_SOURCE, 'i');

/**
 * 审计前的文本归一：NFKC 折叠全角/兼容字符（`Ｃ：＼Users` → `C:\Users`），
 * 并删掉格式类/控制类字符（零宽空格 U+200B、BOM U+FEFF、换行等）。
 *
 * 为什么必须做：`SENSITIVE_RE` 是字面匹配，插一个零宽字符就能让整条路径隐身，
 * 而 QQ 里复制出来的文本经常带这些东西。
 */
export function normalizeForAudit(value) {
  return String(value ?? '').normalize('NFKC').replace(/[\p{Cf}\p{Cc}]/gu, '');
}

/**
 * 出站**整批**内容审计（启发式 + 已知令牌名单）。
 *
 * 为什么不能只逐条审计：模型可以把一句话拆成多个数组元素（qq_send_message / qq_send_burst），
 * 单条看都不像路径 —— `"C:\\"` 加 `"Users\\me\\x.txt"`，或者把 32 位会话令牌对半拆 ——
 * 拼起来才成立。逐条都放行，这道闸门就等于不存在。
 *
 * @param {string|string[]} messages 即将一起发出的文本（数组按顺序拼接）
 * @param {Iterable<string>} [knownTokens] 已知会话令牌原文（精确匹配，不受正则覆盖限制）
 * @param {{allowPaths?: boolean}} [options] allowPaths=true 时只拦凭据/令牌，放行本机路径
 *        （closed-agent 的 owner 私聊：管理员本来就拥有本机全权，路径对他不是秘密，
 *         但 QQ 服务器是第三方且多端同步，凭据与会话令牌仍然必须拦）
 * @returns {{sensitive: boolean, knownToken: string|null, normalized: string}}
 */
export function auditOutboundBatch(messages, knownTokens = [], { allowPaths = false } = {}) {
  const list = Array.isArray(messages) ? messages : [messages];
  // 先逐条归一，再拼：这样跨条拆分的路径/令牌也能被拼出来。
  const normalized = normalizeForAudit(list.map((m) => String(m ?? '')).join(''));
  const compact = normalized.replace(/\s+/g, '');
  const tokens = typeof knownTokens?.[Symbol.iterator] === 'function' ? [...knownTokens] : [];
  const knownToken = tokens.find((t) => t && (normalized.includes(t) || compact.includes(t))) ?? null;
  const pattern = allowPaths ? CREDENTIAL_RE : SENSITIVE_RE;
  const sensitive = Boolean(knownToken)
    || pattern.test(normalized)
    || pattern.test(compact);
  return { sensitive, knownToken, normalized };
}
