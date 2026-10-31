// 会话绑定（SELF_KEY）的**唯一**编解码权威实现，由 qq-tool-restrict.mjs 使用
// （一份实现，避免两处漂移后出现「一个拦一个不拦」）。
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

/** 归一化 QQ 会话 key（与桥接 canonicalV2Key 同口径：去掉前导零、校验正整数）。 */
export function canonicalKeyOf(value) {
  const m = /^(group|private):(\d{1,20})$/.exec(String(value ?? '').trim());
  if (!m) return '';
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return '';
  return `${m[1]}:${id}`;
}

// 只有这些既有只读工具无需 key。发送工具必须从真实目标参数派生身份；
// 新 QQ 工具默认要求可信会话，不能因模型省略 key 而跳过守卫。
const QQ_TOOLS_WITHOUT_SESSION_KEY = new Set(['qq_status', 'qq_list_groups', 'qq_get_group_history']);
const QQ_LEGACY_SEND_TARGETS = {
  qq_send_group_message: ['group', 'groupId'], qq_reply: ['group', 'groupId'],
  qq_send_private_message: ['private', 'userId'], qq_send_burst: ['group', 'groupId']
};
const QQ_TARGET_ALIAS_TOOLS = new Set(['qq_send_message', 'qq_get_message_detail']);

/**
 * 执行期会话绑定判定：这次工具调用是否指向**当前会话**。
 *
 * 按 QQ 工具声明判定是否必须携带 key，不能因为运行时 arguments 缺 key 就跳过。
 * qq_send_message / qq_get_message_detail 的 target 是 key 的显式别名，同样受限。
 * 返回空串表示放行；否则返回统一文案。
 *
 * **未绑定的会话一律拒绝**：如果这里放行，攻击者只要让调用落在一个解不出身份的会话里
 * （例如旧版本留下的 session-… 映射）就能恢复跨会话读取。升级时桥接会把这些旧映射
 * 一次性退役重建，所以正常部署不会走到「未绑定」这条分支。
 *
 * @param {object} exec - DSH 的工具执行记录（含 agent）。
 * @param {object} args - 本次调用的参数（含 key）。
 * @returns {string} 拒绝理由；空串表示放行。
 */
export function sessionBindingDenial(exec, args) {
  const name = /^mcp__snowluma__(.+)$/.exec(String(exec?.name ?? ''))?.[1] ?? '';
  const requiresKey = name !== '' && !QQ_TOOLS_WITHOUT_SESSION_KEY.has(name);
  const input = args && typeof args === 'object' ? args : {};
  const hasKey = Object.prototype.hasOwnProperty.call(input, 'key');
  const hasTarget = QQ_TARGET_ALIAS_TOOLS.has(name) && Object.prototype.hasOwnProperty.call(input, 'target');
  const legacyTarget = Object.prototype.hasOwnProperty.call(QQ_LEGACY_SEND_TARGETS, name) ? QQ_LEGACY_SEND_TARGETS[name] : null;
  if (legacyTarget) {
    const [kind, field] = legacyTarget;
    const canonical = canonicalKeyOf(`${kind}:${String(input[field] ?? '').trim()}`);
    const self = trustedSelfKeyOf(exec);
    if (!self || !canonical || canonical !== self) return SESSION_UNAVAILABLE;
    if (hasKey && canonicalKeyOf(input.key) !== canonical) return SESSION_UNAVAILABLE;
    if (Object.prototype.hasOwnProperty.call(input, 'target') && canonicalKeyOf(input.target) !== canonical) return SESSION_UNAVAILABLE;
    return '';
  }
  if (!hasKey && !hasTarget) return requiresKey ? SESSION_UNAVAILABLE : '';
  const self = trustedSelfKeyOf(exec);
  const canonical = canonicalKeyOf(hasKey ? input.key : input.target);
  if (hasKey && hasTarget && canonical !== canonicalKeyOf(input.target)) return SESSION_UNAVAILABLE;
  if (!self || !canonical || canonical !== self) return SESSION_UNAVAILABLE;
  return '';
}
