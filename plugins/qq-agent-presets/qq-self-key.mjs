// 会话绑定（SELF_KEY）的**唯一**编解码权威实现，由 qq-tool-restrict.mjs 与
// qq-self-key-scope.mjs 共用（一份实现，避免两处漂移后出现「一个拦一个不拦」）。
//
// ── 为什么需要它 ────────────────────────────────────────────────────────────
//
// DSH 的 MCP 桥（dsh-mcp-client 的 syncTools → tools/call）**只传 name + arguments**，
// 协议里没有任何「这次调用来自哪个会话」的字段。于是桥接的 MCP server 只能按
// **模型给的 key** 去解析会话令牌（src/mcp-snowluma-safe.js 的 resolveAgentTokenFor(key)）——
// 模型（或被注入的群友文本）只要把 key 换成别的群号，就能读到那个群的会话状态。
//
// 但 DSH 的**插件侧**是知道身份的：工具执行记录 exec 上挂着 exec.agent，
// 而 exec.agent.id 就是当前这次调用所属的 DSH 会话 id（见 @deepseek-ai/dsh-agent 的
// `Agent.id: SessionId` 与 dsh-tools 的 `ToolExecutionInput.agent?: Agent`）。
//
// 因此桥接在建会话时**预分配**一个把 QQ 会话 key 编码进去的 sessionId；插件侧把它
// 解回来就是可信的「我是谁」，再与模型给的 key 比对即可，完全不依赖模型自律。
//
// ⚠️ 安全前提：模型**无法**选择或影响 sessionId —— 它由桥接在 session/create 时传入
//    （dsh-host-apiproxy：`request.payload.sessionId ?? session-${randomUUID()}`），
//    模型既看不到也改不了。这正是本方案与「信任 arguments.key」的本质区别。

/** sessionId 前缀：`qqb-<g|p>-<id>`（qq bridge bound）。 */
const BOUND_ID_RE = /^qqb-([gp])-(\d{1,20})(?:-[a-f0-9]{32})?$/;

/**
 * 把 QQ 会话 key 编码成桥接预分配的 DSH sessionId。
 * @param {string} key - `group:群号` 或 `private:QQ号`。
 * @returns {string} 可安全用作单一路径段的 sessionId；key 不合法时返回 ''。
 */
export function encodeSelfKey(key) {
  const m = /^(group|private):(\d{1,20})$/.exec(String(key ?? '').trim());
  if (!m) return '';
  const id = Number(m[2]);
  // 与桥接的 canonicalKey 同口径：必须是正的 safe integer，否则 `group:0001` 之类
  // 会编码成与 `group:1` 不同的字符串，绕开「同一个会话」的判定。
  if (!Number.isSafeInteger(id) || id <= 0) return '';
  return `qqb-${m[1] === 'group' ? 'g' : 'p'}-${id}`;
}

/**
 * 从 sessionId 解回可信的 QQ 会话 key。
 * @param {string} sessionId - 任意 sessionId（含 DSH 自己生成的 `session-…`）。
 * @returns {string} `group:群号` / `private:QQ号`；不是桥接绑定的 id 时返回 ''。
 */
export function decodeSelfKey(sessionId) {
  const m = BOUND_ID_RE.exec(String(sessionId ?? '').trim());
  if (!m) return '';
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return '';
  return `${m[1] === 'g' ? 'group' : 'private'}:${id}`;
}

/**
 * 统一「会话不可用」文案。
 *
 * 所有「非当前会话」的拒绝都必须**不可区分**，否则攻击者能从文案差异里反推
 * 「这个群有没有会话状态」（群号枚举 oracle）。因此这里刻意不说明是「没绑定」
 * 还是「绑定了别的会话」。
 */
export const SESSION_UNAVAILABLE = '该会话不可用';

/**
 * 从一次工具执行记录里读出可信会话 key。
 *
 * 取 exec.agent.id（DSH 里 Agent.id 就是 SessionId），退回 exec.agent.session.id
 * 以兼容可能的结构变化。
 * @param {{agent?: {id?: string, session?: {id?: string}}}} exec - DSH 的工具执行记录。
 * @returns {string} 可信 key；无 agent / 未绑定 / id 不可解时返回 ''。
 */
export function trustedSelfKeyOf(exec) {
  const id = exec?.agent?.id ?? exec?.agent?.session?.id;
  return decodeSelfKey(id);
}
