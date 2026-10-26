// 安全版 QQ MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 安全设计：
// - 只暴露聊天所需的**安全动作子集**（查状态/查群/查消息/发消息）；禁言、踢人、文件上传
//   下载等管理动作一律不暴露。
// - **唯一例外**：`qq_admin`（改群名片 / 群名 / 群头像 / QQ 资料 / 头像）。它不靠"模型自律"，
//   而靠桥接侧的两条硬约束：① 必须带本会话的 agent token；② 只有 owner 私聊（key ===
//   private:<ownerQQ>）会直接执行，其它会话只会生成确认卡发到 owner 私聊，owner 回「通过」
//   才动手。所以群友的 prompt injection 最多换来一张确认卡。
// - 发送类工具强制校验白名单：目标群/私聊必须命中 config.json 的
//   allow.groups / allow.private，否则拒绝 —— agent 只能往被允许的地方发消息。
// - 所有调用走 OneBot HTTP API（httpUrl + accessToken）。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
// 出站文本的敏感信息拦截**统一由桥接负责**（bridge.js 的 auditAndSend / 各发送端点的
// SENSITIVE_RE 校验）：所有 QQ 发送都经由桥接 HTTP API，因此 MCP 侧不再重复实现一遍。
// 这里 import 只用于「出站审计口径一致」的说明，不在 MCP 内做拦截——
// 在 MCP 里拦会连「安全拒绝理由」都拿不到，反而让模型无法把话说清楚。
import { SENSITIVE_RE } from './sensitive.js';
import { serializeModelData } from './qq-model-view.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

const cfg = loadConfig();

function getConfig() {
  return loadConfig();
}

function getAccess() {
  const c = getConfig();
  return {
    allowGroups: (c.allow?.groups ?? []).map(String),
    allowPrivate: (c.allow?.private ?? []).map(String),
    denyGroups: (c.deny?.groups ?? []).map(String),
    denyPrivate: (c.deny?.private ?? []).map(String),
    allowAllWhenEmpty: c.allowAllWhenEmpty === true
  };
}

function getOneBotConfig() {
  const c = getConfig();
  return {
    httpUrl: (c.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    token: c.snowluma?.accessToken ?? ''
  };
}

// 与 bridge.allowed 保持一致：allow 列表为空时按 allowAllWhenEmpty 放行
function isAllowed(allowList, denyList, id, allowAllWhenEmpty) {
  const s = String(id);
  if (denyList.includes(s)) return false;
  if (allowList.length > 0) return allowList.includes(s);
  return allowAllWhenEmpty;
}

// 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
function unquoteJsonString(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch {}
  }
  return value;
}

// 说明：本文件曾经有一对 escapeCqText() / messageSegments()，用于在 MCP 侧构造消息段。
// 它们从来没有被任何工具调用（发送一律走桥接的 /api/send/*，由桥接统一构造文本段并做
// CQ 转义，见 bridge.js 的 onebotSend），属于"看起来在防护、实际是死代码"的假安全。
// 这里直接删除，避免以后有人以为 MCP 侧还有一道 CQ 转义而放松桥接那一层。

async function onebot(action, params = {}) {
  const { httpUrl, token } = getOneBotConfig();
  const res = await fetch(`${httpUrl}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) {
    const hint = res.status === 426 ? '；HTTP 426 通常表示 httpUrl 指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址' : '';
    throw new Error(`HTTP ${res.status}${hint}`);
  }
  const body = await res.json();
  if (body.status !== 'ok' || body.retcode !== 0) {
    throw new Error(`OneBot ${action} 失败: retcode=${body.retcode} ${body.wording ?? ''}`);
  }
  return body.data;
}

// 桥接控制台/内部 Agent API 访问：二代仿真模式的状态工具都通过这里读写桥接内存态。
function agentApiBase() {
  const port = Number(getConfig().consolePort) || 3100;
  return `http://127.0.0.1:${port}`;
}
function readConsoleToken() {
  // 每次请求都重新读取，优先 config.json 里的 consoleToken，其次 state/console-token，
  // 避免 token 变化后 MCP 仍使用启动时缓存的旧值导致一直 401。
  //
  // 必须与桥接的校验口径**完全一致**（bridge.js 的 startConsoleServer：长度 16~128、
  // 只允许 [A-Za-z0-9_-]，不合法就忽略并回退 state/console-token）。否则用户手填一个
  // 短令牌时桥接会正常运行，而 MCP 拿着这个桥接根本不认的值去请求 —— 每个工具都 401，
  // 且错误信息里看不出原因是"config.json 里的令牌格式不合法"。
  try {
    const c = getConfig();
    const configured = String(c.consoleToken ?? '').trim();
    if (/^[A-Za-z0-9_-]{16,128}$/.test(configured)) return configured;
  } catch {}
  try {
    const tokenFile = path.join(ROOT, 'state', 'console-token');
    return fs.readFileSync(tokenFile, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * 把桥接返回的 `error` 变成可读文本。
 *
 * 为什么必须有：桥接个别分支会回一个**对象**（例如 `{code, message}`），直接
 * `new Error(obj)` 会把它 String 成 "[object Object]" —— 模型和运维都读不到任何信息。
 * r3 的已知未修项里就记着 `qq_wait_for_messages` 出现过 `error: "\"Error: [object Object]\""`。
 */
function errorText(value, fallback) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object') {
    try {
      const text = JSON.stringify(value);
      if (text && text !== '{}') return text.slice(0, 500);
    } catch {}
    const message = value.message ?? value.msg ?? value.error;
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 500);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

async function agentApi(path, init = {}) {
  const timeoutMs = init.timeoutMs || 15000;
  const { timeoutMs: _omit, ...rest } = init;
  const headers = agentHeaders(rest.headers);
  const res = await fetch(`${agentApiBase()}${path}`, { ...rest, headers, signal: AbortSignal.timeout(timeoutMs) });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    throw new Error(errorText(body?.error, `桥接 API HTTP ${res.status}`));
  }
  // 桥接的部分端点会用 200 + {ok:false,error} 表达业务失败（例如发送被审计拦截）。
  // 不检查 body.ok 会把「被拦截」当成「发送成功」上报给模型 —— 模型据此认为消息已发出，
  // 于是不再重试也不告诉用户，是典型的静默错误。
  if (body && typeof body === 'object' && body.ok === false) {
    throw new Error(errorText(body.error, '桥接 API 返回 ok:false（未说明原因）'));
  }
  return body;
}

/**
 * 桥接 API 请求头（含控制台令牌、x-agent-call 与调用方附加头）。
 * 拆出来是为了长轮询通道复用同一套鉴权，避免两条通路口径漂移。
 */
function agentHeaders(extra = {}) {
  const consoleToken = readConsoleToken();
  const headers = {
    'content-type': 'application/json',
    ...(consoleToken ? { 'x-console-token': consoleToken } : {}),
    ...(extra ?? {})
  };
  // 声明「这是一次智能体调用」。桥接据此把「没带会话令牌」判定为**拒绝**，而不是
  // 退化成「管理端全权」——所以这个头绝不能随 token 一起被省略。历史上 331/355/379/877
  // 行用 `...(token ? {headers:{...}} : {})` 把整个头省掉了，于是「模型漏传 token」
  // 不是被拒绝，反而提权成控制台权限（confused deputy）。
  // 令牌本身仍然只在真有时才发：/api/status 的模式探测（legacyReadToolAllowed）本来就是
  // 无令牌调用，桥接对它单独放行并按最小对象返回。
  headers['x-agent-call'] = '1';
  return headers;
}

/**
 * 长轮询专用 POST（`node:http`，不经过 undici）。
 *
 * 为什么必须单独一条：Node 的全局 `fetch` 是 undici，自带 300 秒 `headersTimeout`。
 * 而 `qq_wait_for_messages` 的常规用法就是 `timeoutMs=300000` 的沉睡前观察 ——
 * 客户端会在第 301 秒以 `fetch failed / Headers Timeout Error` 断掉，桥接侧的
 * 长轮询却还在跑满自己的预算：AI 拿不到结果只能重试，而 `activeWaits` 仍占着会话
 * （重新等待被 429），于是空转烧 token（见 issue #24）。`node:http` 没有默认响应超时，
 * 超时完全由这里的计时器按调用方预算控制。
 */
function agentApiLongPoll(path, init = {}) {
  const timeoutMs = Math.max(1000, Number(init.timeoutMs) || 15000);
  const url = new URL(`${agentApiBase()}${path}`);
  const body = init.body == null ? '' : String(init.body);
  const headers = agentHeaders(init.headers);
  headers['content-length'] = Buffer.byteLength(body);
  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    let res;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      const error = new Error(`等待超时（${Math.round(timeoutMs / 1000)}s）`);
      finish(error);
      req?.destroy(error);
      res?.destroy();
    }, timeoutMs);
    timer.unref?.();
    try {
      req = http.request({
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method: init.method || 'GET',
        headers,
        timeout: 0
      }, (response) => {
        res = response;
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          if (settled) return;
          size += chunk.length;
          // 桥接的 wait 响应本来就是小 JSON；超过 4MB 说明对端异常，别把内存吃光。
          if (size > 4 * 1024 * 1024) {
            finish(new Error('等待响应体过大，已中止'));
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', (error) => finish(error));
        response.on('aborted', () => finish(new Error('等待响应中断')));
        response.on('close', () => { if (!response.complete) finish(new Error('等待响应中断')); });
        response.on('end', () => {
          if (settled) return;
          let parsed = null;
          try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { parsed = null; }
          const status = response.statusCode || 0;
          if (status < 200 || status >= 300) {
            finish(new Error(errorText(parsed?.error, `桥接 API HTTP ${status}`)));
            return;
          }
          if (parsed && typeof parsed === 'object' && parsed.ok === false) {
            finish(new Error(errorText(parsed.error, '桥接 API 返回 ok:false（未说明原因）')));
            return;
          }
          finish(null, parsed);
        });
      });
      req.on('error', (error) => finish(error));
      req.end(body);
    } catch (error) {
      finish(error);
      req?.destroy();
    }
  });
}

async function authorizeRead(key) {
  // 会话令牌必须显式携带：桥接已把空令牌的请求一律拒绝（避免把该端点变成免鉴权入口）。
  // 旧只读工具没有令牌，因此它们改由 legacyReadToolAllowed() 做模式判定，不再调用本函数。
  throw new Error('旧只读工具没有会话令牌；请使用带会话令牌的 v2 读工具');
}

// 旧只读工具（qq_status 之外的 qq_list_groups / qq_get_group_members / qq_get_group_history）
// 没有会话令牌，因此**只能在封闭 agent（管理员私聊）里使用**。
//
// 这里用「确认是 closed-agent 才放行」的白名单写法，而不是「看到 reserved2 就拒绝」的黑名单写法：
// 桥接的 /api/status 在「带 agent 令牌」时返回的是最小状态对象（不含 mode 字段），
// 用 `status?.mode === 'reserved2'` 判断会得到 undefined ⇒ 黑名单判定为假 ⇒ 旧工具被放行，
// 等于在二代仿真模式下把白名单群名、群成员名单注入模型上下文。
async function legacyReadToolAllowed() {
  const status = await agentApi('/api/status');
  return String(status?.mode ?? '') === 'closed-agent';
}

const server = new McpServer({ name: 'snowluma-safe', version: '0.2.1-r1' });

// ── 工具开关必须在**注册期**生效，而不是只在校验期 ──────────────────────────
//
// 为什么：每个工具的描述 + 参数 schema 都会随 system prompt 在**每一次**请求里重发
// （实测 41 个工具约 8.8k token）。只在校验时 403 的话，被关掉的工具依然占着上下文、
// 依然会让模型看见并调用它（然后拿到一个错误），等于「关了个寂寞」。
//
// 这里用一个注册过滤器统一处理：开关关闭 ⇒ 该工具根本不注册 ⇒ 既省 token 又不给模型误调的机会。
// DSH 在启动时读取工具清单，所以关掉/打开后需要重启 DSH 才会刷新（控制台面板已注明）。
//
// 只列**各模式共用的工具不在其中**：qq_send_group_message / qq_send_private_message / qq_reply
// 同时服务 chat / reserved / closed-agent 模式，用 v2 的开关去决定它们是否注册会误伤其它模式，
// 所以这三个仍然只在调用时由桥接校验。
const TOOL_CONFIG_FLAGS = {
  qq_get_prompt: 'getPrompt',
  qq_context: 'getContext',
  qq_person_get: 'person',
  qq_person_note: 'person',
  qq_person_forget: 'person',
  qq_send_image: 'sendImage',
  qq_react: 'react',
  qq_transcribe_voice: 'transcribeVoice',
  qq_ocr_image: 'ocr',
  qq_recall: 'recall',
  qq_search_history: 'searchHistory',
  qq_read_document: 'readDocument',
  qq_group_sign: 'groupSign',
  qq_like: 'like',
  qq_share_card: 'shareCard',
  qq_revise_message: 'revise',
  qq_get_unread_messages: 'getUnread',
  qq_get_recent_messages: 'getRecent',
  qq_social_state: 'socialState',
  qq_mark_read: 'markRead',
  qq_set_wake_config: 'setWakeConfig',
  qq_send_burst: 'sendBurst',
  qq_send_message: 'sendMessage',
  qq_wait_for_messages: 'waitMessages',
  qq_report_feedback: 'feedback',
  qq_get_my_recent_messages: 'getMyRecent',
  qq_get_message_detail: 'getMessageDetail',
  qq_get_active_members: 'getActiveMembers',
  qq_get_group_members: 'getGroupMembers',
  qq_memory_append: 'memory',
  qq_memory_query: 'memory',
  qq_memory_remove: 'memory',
  qq_memory_clear: 'memory',
  qq_slang_query: 'slangQuery',
  qq_slang_submit: 'slangSubmit',
  qq_send_voice: 'sendVoice',
  qq_list_voices: 'sendVoice',
  // 下面这些曾经漏登记。漏一个不是"多注册一个工具"那么轻：桥接那边按 `v2ToolEnabled(flag)`
  // 在**调用期**一律 403，而这里不登记就等于"控制台显示已关闭、模型每次请求仍收到它的完整
  // 描述与参数 schema，然后调用它、再拿到 403"——既白烧 token（本文件开头 176 行起就是为省这份
  // token 才改注册期过滤的），又诱导模型误调。`qq_set_sticker_remark` 默认就是 `false`
  // （见 bridge.js 的 socialV2.tools 默认表），所以此前它一直是"默认关闭却仍然可见"。
  qq_send_poke: 'sendPoke',
  qq_get_message_images: 'getImages',
  qq_get_forward_msg: 'getForwardMsg',
  qq_list_stickers: 'listStickers',
  qq_get_sticker_image: 'getStickerImage',
  qq_send_sticker: 'sendSticker',
  qq_collect_sticker: 'collectSticker',
  qq_delete_sticker: 'deleteSticker',
  qq_get_self_image: 'getSelfImage',
  qq_sticker_note: 'stickerNote',
  qq_set_sticker_remark: 'setStickerRemark',
  // QQ 资料 / 空间（默认开启；权限与配额在桥接侧判定）
  qq_get_user_profile: 'getUserProfile',
  qq_qzone_read: 'qzoneRead',
  qq_qzone_post: 'qzonePost',
};
const disabledTools = [];
{
  const registerTool = server.tool.bind(server);
  server.tool = (name, ...rest) => {
    const flag = TOOL_CONFIG_FLAGS[name];
    if (flag && cfg.socialV2?.tools?.[flag] === false) {
      disabledTools.push(`${name}(${flag})`);
      return undefined;
    }
    return registerTool(name, ...rest);
  };
}

server.tool(
  'qq_status',
  '查询 QQ 机器人登录状态与账号信息（只读）。',
  {},
  async () => {
    try {
      const login = await onebot('get_login_info');
      let status = {};
      try { status = await onebot('get_status'); } catch {}
      return { content: [{ type: 'text', text: serializeModelData({ ...login, online: status.online, good: status.good }) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 旧只读工具：**按启动时的桥接模式决定是否注册** ─────────────────────────
//
// 为什么必须在注册期就砍掉（而不是只在调用期 403）：
//   每个工具的描述 + 参数 schema 都随 system prompt 在**每一次**请求里重发。
//   实测一份 reserved2 会话的请求头是「58 个工具 / 45.5 KB schema（≈14k token/次）」，
//   其中 3 个旧只读工具在 reserved2 下**必然**返回 403，却照样占着 2500+ 字节；
//   更要命的是它们会诱导模型误调（实测 turn10 有一次 qq_get_group_members → 403，白烧一步）。
//   本文件开头（TOOL_CONFIG_FLAGS 那段）已经为「关掉的工具」立过同样的规矩，这里补齐模式维度。
//
// 语义：旧只读工具没有会话令牌，`legacyReadToolAllowed()` 只放行 closed-agent。
//   所以只有在 closed-agent 下注册它们才有意义。探测失败（读不到状态文件）时按「注册」处理：
//   那种情况下所有 QQ 工具都不可用，少注册只会让模型看到更少的失败路径，不必激进。
//
// ⚠️ 为什么读 `state/mode.json` 而**不**去问 `/api/status`：
//   注册发生在模块加载期，走网络就得用 top-level await；而本文件会被若干离线回归
//   （test-audit-security-mcp.mjs）用 `vm`/`new Function` 求值，那里没有 TLA —— 会直接
//   `ReferenceError: await is not defined`，把整批断言打红。模式文件是桥接每次切换模式时
//   原子写出的（bridge.js 的 writeMode），与 `/api/status` 同源，读盘既准确又是同步的。
const bootBridgeMode = (() => {
  try {
    const raw = fs.readFileSync(path.join(ROOT, 'state', 'mode.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return String(parsed?.mode ?? '').trim();
  } catch { return ''; }
})();
const registerLegacyReadTools = bootBridgeMode === '' || bootBridgeMode === 'closed-agent';
if (!registerLegacyReadTools) {
  console.error(`[snowluma-safe] 当前桥接模式 ${bootBridgeMode}：不注册旧只读工具（qq_list_groups / qq_get_group_history），改用带令牌的 v2 读工具`);
}

if (registerLegacyReadTools) {
server.tool(
  'qq_list_groups',
  '列出机器人所在的全部 QQ 群（只读）：群号、群名。',
  {},
  async () => {
    // 旧只读工具没有 agent token：只允许在封闭 agent（管理员私聊）里使用。
    // 判定失败一律拒绝（fail-closed），不依赖「看到某个模式才拒绝」的黑名单写法。
    try {
      if (!(await legacyReadToolAllowed())) {
        return { content: [{ type: 'text', text: '旧只读工具仅在封闭 agent（管理员私聊）模式可用；其它模式请使用带会话令牌的 v2 读工具' }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `无法确认当前模式，拒绝执行：${error?.message ?? error}` }], isError: true };
    }
    try {
      const a = getAccess();
      const data = await onebot('get_group_list');
      const list = (Array.isArray(data) ? data : (data?.data ?? []))
          .filter((g) => isAllowed(a.allowGroups, a.denyGroups, g.group_id, a.allowAllWhenEmpty))
          .map((g) => ({ group_id: g.group_id, group_name: g.group_name }));
      return { content: [{ type: 'text', text: serializeModelData(list) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);
}

// 群成员列表：**换成 v2 形态**（key + token）。
//
// 为什么不再沿用旧的无令牌版本：它是 qq-chat-v2 预设里唯一被点名的"拿 QQ 号"的途径
// （见 dsh/agent-presets/qq-chat-v2/agent.cordis.yml 第 6 条），但旧版在 reserved2 下必然 403
// —— 预设教模型用一个永远失败的工具，等于每次都白烧一步。改成 v2 后同一个名字在两种模式下都成立。
server.tool(
  'qq_get_group_members',
  '列出指定群的成员（只读）：QQ 号、昵称、群名片。等特定的人、要 @ 某个人、或需要确认谁在群里时用；QQ 号取返回里的 userId。只返回白名单群，且只读取桥接允许的会话。',
  {
    key: z.string().describe('会话 key，格式 group:群号'),
    token: z.string().optional().describe('会话令牌（见唤醒提示中的【会话令牌】；closed-agent 模式不需要）'),
    limit: z.number().optional().describe('最多返回多少成员，默认 50，最大 100')
  },
  async ({ key, token, limit }) => {
    try {
      const q = new URLSearchParams({ key });
      if (limit != null) q.set('limit', String(limit));
      // token 可选：closed-agent（管理员私聊）里代理没有会话令牌，走的是操作者路径；
      // 桥接那边的白名单/模式判定对**这条**请求同样生效（不依赖 header 是否存在）。
      const data = await agentApi(`/api/socialV2/group-members?${q.toString()}`, token ? { headers: { 'x-agent-token': token } } : {});
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取群成员失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

if (registerLegacyReadTools) {
server.tool(
  'qq_get_group_history',
  '获取指定群的最近消息历史（只读）。messageSeq 可选：从该消息序号往前取。注意：是否可用取决于 SnowLuma 是否实现 get_group_msg_history。',
  { groupId: z.union([z.number(), z.string()]).describe('群号'), messageSeq: z.number().optional().describe('起始消息序号（可选）') },
  async ({ groupId, messageSeq }) => {
    const g = String(groupId);
    try {
      if (!(await legacyReadToolAllowed())) {
        return { content: [{ type: 'text', text: '旧只读工具仅在封闭 agent（管理员私聊）模式可用；其它模式请使用带会话令牌的 v2 读工具' }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `无法确认当前模式，拒绝读取：${error?.message ?? error}` }], isError: true };
    }
    const a = getAccess();
    if (!isAllowed(a.allowGroups, a.denyGroups, g, a.allowAllWhenEmpty)) {
      return { content: [{ type: 'text', text: `拒绝：群 ${g} 不在只读白名单中` }], isError: true };
    }
    try {
      const params = { group_id: Number(g) };
      if (messageSeq !== undefined) params.message_seq = messageSeq;
      const data = await onebot('get_group_msg_history', params);
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);
}

server.tool(
  'qq_send_group_message',
  '向指定 QQ 群发送一条纯文本消息；如需引用某条消息，可传 replyToMessageId（非零整数，可为负数），可先用 qq_get_recent_messages / qq_get_message_detail 查询。二代模式（reserved2）下这是可用的发送工具之一，但优先使用 qq_send_message；reserved2 下调用时必须携带会话令牌 token，否则会被拒绝。不要在发送后输出“已发送”类汇报。目标群必须命中系统白名单（config.json 的 allow.groups），否则拒绝。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    message: z.string().describe('消息文本，纯文本，不要用 Markdown 或 CQ 码'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填；closed-agent 模式不需要）')
  },
  async ({ groupId, message, replyToMessageId, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/group', {
        method: 'POST',
        // token 既放 body（兼容旧调用）又放 header：桥接的「agent 流量」判定基于 header，
        // 只带 body 会让这条请求在桥接眼里像控制台请求，绕过 agent 专用的闸门与审计。
        ...(token ? { headers: { 'x-agent-token': token } } : {}),
        body: JSON.stringify({ groupId: String(groupId), message: cleanMessage, replyToMessageId, token: token || undefined })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_reply',
  '在指定 QQ 群里引用/回复某条消息，并发送一条文本。适合群消息很多、需要明确“我回的是哪条”时使用；replyToMessageId 是被引用消息的 id（非零整数，QQ 消息 id 可能为负数），可先用 qq_get_recent_messages / qq_get_unread_messages / qq_get_message_detail 查到具体消息内容和 id。发送前桥接会校验该 id 存在且属于当前会话。二代模式下这是你正常可用的引用工具，但不要每条都引用。只有以下情况才需要引用：① 你这条消息指向的人或消息并非最新一条别人的消息（也就是你在回更早的某条）；② 你连续几句话里不同消息指代的是不同的消息或不同的人。其他情况（上下文唯一、刚在接同一条最新消息）不要引用，别让对方猜，也别为了用工具而用。reserved2 下调用时必须携带会话令牌 token。目标群必须命中系统白名单（config.json 的 allow.groups），否则拒绝。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    replyToMessageId: z.union([z.number(), z.string()]).describe('被引用/回复的消息 id（非零整数，可为负数）'),
    message: z.string().describe('要发送的文本，纯文本，不要用 Markdown 或 CQ 码'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填；closed-agent 模式不需要）')
  },
  async ({ groupId, replyToMessageId, message, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/reply', {
        method: 'POST',
        ...(token ? { headers: { 'x-agent-token': token } } : {}),
        body: JSON.stringify({ groupId: String(groupId), replyToMessageId, message: cleanMessage, token: token || undefined })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_private_message',
  '向指定 QQ 好友发送一条私聊消息。若提供 replyToMessageId，会以 QQ 引用/回复形式发出（引用条 + 文本）。replyToMessageId 必须是非零整数消息 id（QQ 消息 id 可能为负数），可先用 qq_get_message_detail 查询。二代模式（reserved2）下这是可用的发送工具之一，但优先使用 qq_send_message；调用时必须携带会话令牌 token，否则会被拒绝。不要在发送后输出“已发送”类汇报。目标 QQ 必须命中系统白名单（config.json 的 allow.private），否则拒绝。',
  {
    userId: z.union([z.number(), z.string()]).describe('好友 QQ 号（必须在白名单内）'),
    message: z.string().describe('消息文本，纯文本，不要用 Markdown 或 CQ 码'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填；closed-agent 模式不需要）')
  },
  async ({ userId, message, replyToMessageId, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/private', {
        method: 'POST',
        ...(token ? { headers: { 'x-agent-token': token } } : {}),
        body: JSON.stringify({ userId: String(userId), message: cleanMessage, replyToMessageId, token: token || undefined })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 二代仿真模式（reserved2）工具 ─────────────────────────────────────────
server.tool(
  'qq_get_prompt',
  '查看当前二代仿真模式的提示词/角色/推荐值/可用工具/当前唤醒配置（只读）。',
  { key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'), token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）') },
  async ({ key, token }) => {
    try {
      const data = await agentApi(`/api/socialV2/prompt?key=${encodeURIComponent(key)}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取提示词失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_context',
  '一次取齐当前会话的上下文：最近摘要、消息快照、记忆、唤醒配置、限额使用。优先用它替代 get_prompt + get_unread + social_state 多次调用；返回里的 snapshot 已含消息，不必重复查。',
  { key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'), token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）') },
  async ({ key, token }) => {
    try {
      const data = await agentApi(`/api/socialV2/context?key=${encodeURIComponent(key)}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取上下文失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_person_get',
  '查看人物卡：群友的称呼、熟悉度、事实、边界、最近互动。userId 可传 QQ 号；不传则返回该会话所有人物卡。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    userId: z.string().optional().describe('要查的群友 QQ 号；不传返回全部')
  },
  async ({ key, token, userId }) => {
    try {
      const query = `key=${encodeURIComponent(key)}${userId ? `&userId=${encodeURIComponent(userId)}` : ''}`;
      const data = await agentApi(`/api/socialV2/people?${query}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `读取人物卡失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_person_note',
  '给某个人物卡记一条有证据的印象：fact=事实/偏好，boundary=雷区/别做的事，episode=一次具体互动，alias=称呼。只在真的值得记时写，不要逐条记流水账。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    userId: z.string().describe('群友 QQ 号（或已有称呼）'),
    category: z.enum(['fact', 'boundary', 'episode', 'alias']).describe('记录类型'),
    text: z.string().describe('要记的内容，尽量短，最多 200 字')
  },
  async ({ key, token, userId, category, text }) => {
    try {
      const data = await agentApi('/api/socialV2/person-note', {
        method: 'POST',
        headers: { 'x-agent-token': token },
        body: JSON.stringify({ key, userId, category, text })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记录人物卡失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_person_forget',
  '删除人物卡里的一条事实/边界/互动/称呼，用于纠正错误记忆。只能删除当前会话里存在的记录。',
  {
    key: z.string().describe('会话 key'),
    token: z.string().describe('会话令牌'),
    userId: z.string().describe('群友 QQ 号（或已有称呼）'),
    category: z.enum(['fact', 'boundary', 'episode', 'alias']).describe('记录类型'),
    text: z.string().describe('要删除的原文')
  },
  async ({ key, token, userId, category, text }) => {
    try {
      const data = await agentApi('/api/socialV2/person-forget', {
        method: 'POST', headers: { 'x-agent-token': token },
        body: JSON.stringify({ key, token, userId, category, text })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `删除人物记忆失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_image',
  '从媒体库发一张图片（只接受 media/ 目录下的文件名，不接受路径/URL/base64）。可选 caption 作为图片前的文字说明。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    file: z.string().describe('media/ 下的图片文件名，例如 cat.png'),
    caption: z.string().optional().describe('可选文字说明，最多 500 字')
  },
  async ({ key, token, file, caption }) => {
    try {
      const data = await agentApi('/api/socialV2/send-image', {
        method: 'POST',
        headers: { 'x-agent-token': token },
        body: JSON.stringify({ key, token, file, caption })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送图片失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_react',
  '给当前会话里的一条最近消息加 QQ 表情回应（不说话也能表示看到/接梗）。emoji 支持 like/laugh/wow/cry/clap/eyes/ok/party，或数字 emoji id。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messageId: z.union([z.number(), z.string()]).describe('要回应的消息 id（来自消息对象或 qq_get_message_detail）'),
    emoji: z.string().describe('like/laugh/wow/cry/clap/eyes/ok/party 或数字 emoji id')
  },
  async ({ key, token, messageId, emoji }) => {
    try {
      const data = await agentApi('/api/socialV2/react', {
        method: 'POST',
        headers: { 'x-agent-token': token },
        body: JSON.stringify({ key, token, messageId: String(messageId), emoji })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `表情回应失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_transcribe_voice',
  '把一条语音消息转成文字（走网关的语音转写，不下载音频）。用于“他刚才语音说了什么”。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messageId: z.union([z.number(), z.string()]).describe('语音消息 id')
  },
  async ({ key, token, messageId }) => {
    try {
      const data = await agentApi('/api/socialV2/transcribe', {
        method: 'POST', headers: { 'x-agent-token': token },
        body: JSON.stringify({ key, token, messageId: String(messageId) })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `语音转写失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_ocr_image',
  '对一条图片/表情消息做 OCR，返回图片里的文字。图片必须还在当前会话缓存里。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messageId: z.union([z.number(), z.string()]).describe('图片消息 id')
  },
  async ({ key, token, messageId }) => {
    try {
      const data = await agentApi('/api/socialV2/ocr', {
        method: 'POST', headers: { 'x-agent-token': token },
        body: JSON.stringify({ key, token, messageId: String(messageId) })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `OCR 失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_recall',
  '撤回机器人自己最近发的一条消息（只能撤自己的；用于发错了/改口）。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messageId: z.union([z.number(), z.string()]).describe('要撤回的消息 id（机器人自己发的）')
  },
  async ({ key, token, messageId }) => {
    try {
      const data = await agentApi('/api/socialV2/recall', {
        method: 'POST', headers: { 'x-agent-token': token },
        body: JSON.stringify({ key, token, messageId: String(messageId) })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `撤回失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_search_history',
  '在当前会话的最近缓存消息里按关键词搜索，用于接旧话题/兑现承诺。返回时间、说话人和原文片段。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    query: z.string().describe('搜索关键词'),
    limit: z.number().optional().describe('最多返回几条，默认 8，最大 20')
  },
  async ({ key, token, query, limit }) => {
    try {
      const qs = new URLSearchParams({ key, token, q: query, limit: String(limit ?? 8) });
      const data = await agentApi(`/api/socialV2/search-history?${qs.toString()}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `搜索失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_read_document',
  '读取聊天里的一条文件消息并提取文字。支持 txt/md、PDF 文字层、DOCX、XLSX；扫描版 PDF 需 OCR，不在支持范围。默认只能读最近缓存，读历史文件需要管理员开启「允许读取历史文件」。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messageId: z.union([z.number(), z.string()]).describe('文件消息 id')
  },
  async ({ key, token, messageId }) => {
    try {
      const data = await agentApi('/api/socialV2/document', {
        method: 'POST', headers: { 'x-agent-token': token },
        body: JSON.stringify({ key, token, messageId: String(messageId) })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `读取文档失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_group_sign',
  '在当前群签到。默认关闭，需要管理员在控制台开启；每天只能签一次。',
  {
    key: z.string().describe('群会话 key，格式 group:群号'),
    token: z.string().describe('会话令牌')
  },
  async ({ key, token }) => {
    try {
      const data = await agentApi('/api/socialV2/group-sign', { method: 'POST', headers: { 'x-agent-token': token }, body: JSON.stringify({ key, token }) });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `群签到失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_like',
  '给当前会话里的人点赞。默认关闭；群聊必须传 userId，且只能点本会话出现过的人；每人每天一次。',
  {
    key: z.string().describe('会话 key'),
    token: z.string().describe('会话令牌'),
    userId: z.string().optional().describe('群聊要点赞的群友 QQ 号；私聊可省略'),
    times: z.number().optional().describe('点赞次数 1~10，默认 5')
  },
  async ({ key, token, userId, times }) => {
    try {
      const data = await agentApi('/api/socialV2/like', { method: 'POST', headers: { 'x-agent-token': token }, body: JSON.stringify({ key, token, userId, times }) });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `点赞失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_share_card',
  '发一张图文分享卡片（标题/描述/跳转链接）。默认关闭；jumpUrl 和 previewUrl 必须是 http(s)。',
  {
    key: z.string().describe('会话 key'),
    token: z.string().describe('会话令牌'),
    title: z.string().describe('卡片标题，最多 80 字'),
    desc: z.string().describe('卡片描述，最多 200 字'),
    jumpUrl: z.string().describe('点击跳转的 http(s) 链接'),
    previewUrl: z.string().optional().describe('可选预览图 http(s) 链接')
  },
  async ({ key, token, title, desc, jumpUrl, previewUrl }) => {
    try {
      const data = await agentApi('/api/socialV2/share-card', { method: 'POST', headers: { 'x-agent-token': token }, body: JSON.stringify({ key, token, title, desc, jumpUrl, previewUrl }) });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `分享卡片失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_revise_message',
  '撤回机器人自己刚发的一条消息，并重发改好的文本。用于打错字/说错话/改口；只能改自己最近发的消息。',
  {
    key: z.string().describe('会话 key'),
    token: z.string().describe('会话令牌'),
    messageId: z.union([z.number(), z.string()]).describe('要撤回的自己消息 id'),
    text: z.string().describe('改好后的文本')
  },
  async ({ key, token, messageId, text }) => {
    try {
      const data = await agentApi('/api/socialV2/revise', { method: 'POST', headers: { 'x-agent-token': token }, body: JSON.stringify({ key, token, messageId: String(messageId), text }) });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `改口失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_unread_messages',
  '查看未读消息，不自动标记已读。大量积压或快照 partial=true 时，用 afterSeq=readThroughSeq 从水位后按时间顺序补读；从最早未读开始传 0。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 30，最大 100'),
    afterSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('读取本地 seq 大于此水位的最早一页；省略则沿用返回最新一页的旧行为')
  },
  async ({ key, token, limit, afterSeq }) => {
    try {
      const data = await agentApi(`/api/socialV2/unread?key=${encodeURIComponent(key)}&limit=${limit ?? 30}${afterSeq === undefined ? '' : `&afterSeq=${afterSeq}`}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取未读消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_recent_messages',
  '查看指定会话的最近消息（只读），支持 offset 扩大范围。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 20，最大 100'),
    offset: z.number().optional().describe('跳过最近 N 条，用于向前翻看更早消息，默认 0')
  },
  async ({ key, token, limit, offset }) => {
    try {
      const data = await agentApi(`/api/socialV2/recent?key=${encodeURIComponent(key)}&limit=${limit ?? 20}&offset=${offset ?? 0}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取最近消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_social_state',
  '查看指定会话的二代仿真状态：WakeConfig、未读数、上次唤醒原因、上次发言时间等（只读）。',
  { key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'), token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）') },
  async ({ key, token }) => {
    try {
      const data = await agentApi(`/api/socialV2/state?key=${encodeURIComponent(key)}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取状态失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_mark_read',
  '将指定会话已查看的未读消息标记为已读。throughSeq 使用最近读取结果的 readThroughSeq，避免清除读取后才到达的新消息；省略 throughSeq 会按旧行为清空当前全部未读，因此推荐始终带上水位。注意：收尾前先看唤醒提示里的【沉睡前观察】/【收尾】段落——要求观察时，先用 qq_wait_for_messages 等够它给出的 timeoutMs（短等待不算），没人说话再 mark_read 收尾；提示说没有开启观察，就直接收尾，不用等。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    throughSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('本次确认已读的消息水位，使用已查看结果中的 readThroughSeq；不会清除更晚到达的消息')
  },
  async ({ key, token, throughSeq }) => {
    try {
      const data = await agentApi('/api/socialV2/mark-read', { method: 'POST', body: JSON.stringify({ key, throughSeq }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `标记已读失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_set_wake_config',
  '设置指定会话的二代唤醒配置：mode/无限期或有限时间/提前唤醒条件（@、名字、关键词、提问、拍一拍、概率、anyMessage、指定成员）。triggers.speakerIds 是可选的“指定群友发言唤醒”：填一个或多个群友 QQ 号后，只要其中任意一位在群里发言就会唤醒你；不设置则不启用。适合在等某个人回复、或某人反应慢怕错过时使用。triggers.poke 开启后，群里有人拍一拍（包括拍你或拍别人）会唤醒你。注意：收尾前先看唤醒提示里的【沉睡前观察】/【收尾】段落——要求观察时先用 qq_wait_for_messages 等够它给出的 timeoutMs（短等待不算）；提示说没有开启观察，就直接设置并沉睡，不用等。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    throughSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('可同时确认已读：使用已查看结果中的 readThroughSeq，省去额外 qq_mark_read；不传则只设置唤醒配置。若 markRead 工具被关闭，该水位会被忽略，本工具只设置唤醒配置'),
    config: z.object({
      mode: z.enum(['diving', 'active']).optional().describe('diving=潜水，active=活跃（anyMessage 开启）'),
      infinite: z.boolean().optional().describe('true=无限期，只有条件命中才唤醒；false=有限时间'),
      sleepMs: z.number().optional().describe('有限潜水毫秒数（从当前时间起算）'),
      sleepUntil: z.string().optional().describe('有限潜水截止时间 ISO 字符串，优先级高于 sleepMs'),
      triggers: z.object({
        atMention: z.boolean().optional().describe('被 @ 或引用自己时唤醒'),
        nameMention: z.boolean().optional().describe('被叫名字/昵称时唤醒'),
        speakerIds: z.array(z.union([z.number(), z.string()])).max(20).optional().describe('指定群友 QQ 号数组：这些群友中任意一位发言时唤醒（可选，最多 20 个，不设置则不启用；私聊不适用，设置会被桥接清除；可从 qq_get_active_members / qq_get_group_members / qq_get_message_detail 的 userId/user_id 获取）'),
        keywords: z.array(z.string()).optional().describe('出现任意关键词时唤醒'),
        question: z.boolean().optional().describe('被直接提问/点名挑战时唤醒'),
        poke: z.boolean().optional().describe('有人拍一拍时唤醒（群聊包括拍你和拍别人，私聊为对方拍你）'),
        anyMessage: z.boolean().optional().describe('任意新消息都唤醒（活跃模式）'),
        probability: z.number().optional().describe('普通消息按该概率随机唤醒（0~1）')
      }).optional(),
      batchWindowMs: z.number().optional().describe('多条消息合并唤醒窗口（毫秒，>=1000）')
    }).describe('要设置的唤醒配置，缺省字段保留原值')
  },
  async ({ key, token, config, throughSeq }) => {
    try {
      const data = await agentApi('/api/socialV2/wake-config', { method: 'POST', body: JSON.stringify({ key, config, throughSeq }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `设置唤醒配置失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_burst',
  '在指定 QQ 群分多条发送消息（二代仿真模式专用），桥接会按真人化随机间隔发送。暂不支持引用，需要引用请用 qq_reply。注意：数组里的每个字符串就是一条 QQ 消息，字符串内部不要用空格分隔中文短句，需要多条请用数组元素；每条消息要读起来完整，不要把同一句话拆到两条里。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messages: z.union([z.array(z.string()).min(1), z.string()]).describe('要发送的消息数组，每条为纯文本；也兼容传入 JSON 数组字符串')
  },
  async ({ groupId, token, messages }) => {
    try {
      const key = `group:${groupId}`;
      let finalMessages = messages;
      if (typeof finalMessages === 'string') {
        const trimmed = finalMessages.trim();
        // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        } else if (trimmed.startsWith('"')) {
          // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') finalMessages = parsed;
            else if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        }
      }
      const data = await agentApi('/api/socialV2/send-burst', {
        method: 'POST',
        body: JSON.stringify({ key, messages: finalMessages }),
        headers: { 'x-agent-token': token },
        timeoutMs: 300000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `分条发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_message',
  '统一发送工具：可发一条或多条，可引用某条消息，可自定义/按字数计算条间时间差。二代仿真模式专用。注意：字符串=一条消息，数组=多条消息；每个字符串内部不要用空格分隔中文短句，需要多条请用数组元素；每条消息要读起来完整，不要把同一句话拆到两条里。只有以下情况才需要传 replyToMessageId 引用：① 你这条消息指向的人或消息并非最新一条别人的消息（也就是你在回更早的某条）；② 你连续几句话里不同消息指代的是不同的消息或不同的人。其他情况（上下文唯一、刚在接同一条最新消息）不要引用，别让对方猜，也别为了用工具而用。管理员让你去别的群/会话说一句时，把 key 指向那个会话即可（需要控制台「跨会话代发消息」权限；被拒时如实转告，不要反复重试）。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messages: z.union([z.string(), z.array(z.string()).min(1)]).describe('要发送的内容：字符串=一条；数组=分多条'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊中用于点名某个人；与引用二选一即可，不要滥用）'),
    gapMode: z.enum(['auto', 'fixed', 'byLength']).optional().describe('auto=桥接随机；fixed=固定间隔；byLength=按字数计算'),
    gapMs: z.number().optional().describe('fixed 模式下的统一间隔（毫秒）'),
    gaps: z.array(z.number()).optional().describe('fixed 模式下逐条间隔（长度=条数-1）')
  },
  async ({ key, token, messages, replyToMessageId, atUserId, gapMode, gapMs, gaps }) => {
    try {
      let finalMessages = messages;
      if (typeof finalMessages === 'string') {
        const trimmed = finalMessages.trim();
        // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        } else if (trimmed.startsWith('"')) {
          // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') finalMessages = parsed;
            else if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        }
      }
      const data = await agentApi('/api/socialV2/send-message', {
        method: 'POST',
        body: JSON.stringify({ key, messages: finalMessages, replyToMessageId, atUserId: atUserId ?? null, gapMode, gapMs, gaps }),
        headers: { 'x-agent-token': token },
        timeoutMs: 300000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

if (cfg.socialV2?.tools?.sendPoke !== false) {
  server.tool(
    'qq_send_poke',
    '发送 QQ 拍一拍（群聊/私聊）。适合用“戳一下”代替一句废话、提醒对方、自然回应别人的拍一拍，或偶尔主动戳一下正在聊的人/熟人——这样更拟真；但别频繁，真人不会一直戳人。群聊必须传 targetUserId（要拍的群友 QQ 号，可从 qq_get_active_members / qq_get_message_detail 的 userId 获取）；私聊可不传 targetUserId（默认拍当前私聊对象）。reserved2 下必须携带会话令牌 token，发送会受桥接白名单与发送频率限制。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      targetUserId: z.union([z.number(), z.string()]).optional().describe('要拍的群友 QQ 号（群聊必填；私聊可选）')
    },
    async ({ key, token, targetUserId }) => {
      try {
        const data = await agentApi('/api/socialV2/send-poke', {
          method: 'POST',
          body: JSON.stringify({ key, targetUserId: targetUserId != null ? String(targetUserId) : '' }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `拍一拍失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

server.tool(
  'qq_wait_for_messages',
  '等待分两种用途。首答前已读消息、只想确认有没有补充：用 purpose="reply"，按最后来信时间补足 quietMs 静默，已安静足够就立即返回；读取/思考时新到的消息也会返回，新消息重算静默。timeoutMs 是最长预算，不要求等满；预算到但 quiet=false 不代表对方已说完。此用途绝不代替沉睡前观察。等对方继续说、等回复或睡前观察：用默认 purpose="messages"；先等新消息，收到后才按 quietMs 等静默，没有新消息会等到 timeoutMs，单传 quietMs 不会缩短总等待。静默下限由后台配置，默认 10000ms。**返回里的 canSleepNow / countsAsObservation / hint 直接告诉你现在能不能收尾、该用多大的 timeoutMs——照它做，不要反复试**：canSleepNow=true 就可以直接 mark_read / set_wake_config；false 时按 hint 给的 timeoutMs 一次等满（更短的等待不算沉睡前观察，满足不了闸门）。直接看 newMessages、unreadCount 和 readThroughSeq，返回消息无需重复查询；仍有未展示未读才补读。收尾时以唤醒提示里的【沉睡前观察】/【收尾】段落为准：要求观察，再用默认用途、按它给出的 timeoutMs 等够，不能放在首答之前；没要求就直接收尾。全程无人说话返回 preSleepWaitSatisfied=true；观察期间来了新消息返回 preSleepWaitObserved=true，读后不需参与可收尾，参与回复则下次收尾重新观察。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    purpose: z.enum(['messages', 'reply']).optional().describe('默认 messages：等新消息/回复/睡前观察；reply：回复前短静默，计入最后来信后已过去的时间，绝不授予睡前观察资格'),
    timeoutMs: z.number().optional().describe('等待预算毫秒数，默认 30000、最大 600000；reply 达到静默即返回，不必等满；沉睡前观察用 messages，timeoutMs 取唤醒提示里给的值'),
    minNewMessages: z.number().optional().describe('仅 messages 用途：至少等到多少条新消息才进入静默窗口，默认 1；reply 用途会忽略它'),
    quietMs: z.number().optional().describe('静默窗口毫秒数，建议 10000~12000；reply 从最后来信开始计时，messages 只在等到新消息后计时；后台默认至少 10000')
  },
  async ({ key, token, purpose, timeoutMs, minNewMessages, quietMs }) => {
    try {
      // 必须走长轮询通道：全局 fetch（undici）有 300s headersTimeout，
      // 而沉睡前观察的预算就是 300s（见 agentApiLongPoll 的说明）。
      const data = await agentApiLongPoll('/api/socialV2/wait', {
        method: 'POST',
        body: JSON.stringify({ key, purpose, timeoutMs, minNewMessages, quietMs }),
        headers: { 'x-agent-token': token },
        timeoutMs: Math.min(725000, (Number(timeoutMs) || 30000) + Math.max(Number(quietMs) || 0, 10000) + 20000)
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `等待失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_report_feedback',
  '向控制台/管理端反馈 AI 遇到的问题、困惑或需要管理员介入的情况。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    level: z.enum(['info', 'warning', 'error']).optional().describe('反馈级别，默认 info'),
    message: z.string().describe('反馈内容')
  },
  async ({ key, token, level, message }) => {
    try {
      const data = await agentApi('/api/socialV2/feedback', {
        method: 'POST',
        body: JSON.stringify({ key, level, message }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `反馈失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_my_recent_messages',
  '查看自己最近发过的消息（只读），避免重复/保持人设。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 10，最大 50')
  },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/socialV2/my-recent?key=${encodeURIComponent(key)}&limit=${limit ?? 10}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取自己消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_message_detail',
  '按 message_id / 本地 seq 查看单条消息的发送者、引用信息与正文（只读）。注意：正文最多返回 200 字符，textTruncated=true 表示被截断，这里不是读取长消息全文的入口。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messageId: z.union([z.number(), z.string()]).describe('要查看的消息 id（QQ 消息 id 可能为负数）')
  },
  async ({ key, token, messageId }) => {
    try {
      const data = await agentApi(`/api/socialV2/message-detail?key=${encodeURIComponent(key)}&messageId=${encodeURIComponent(String(messageId))}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取消息详情失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_active_members',
  '查看最近活跃成员列表（只读），帮助判断话题参与者。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回人数，默认 10，最大 20')
  },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/socialV2/active-members?key=${encodeURIComponent(key)}&limit=${limit ?? 10}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取活跃成员失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_append',
  '记录一条轻量记忆：activeTopic=进行中的话题；pendingThought=你想说但还没说的话；memberImpression=对某位群友的印象。记忆会持久化，并在后续唤醒/qq_get_prompt 中自动出现。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).describe('记忆类别'),
    content: z.string().describe('记忆内容，例如话题、想说的话、对某人的印象标签'),
    extra: z.object({
      target: z.string().optional().describe('memberImpression 时的群友名字/昵称'),
      participants: z.array(z.string()).optional().describe('activeTopic 的参与者列表'),
      pendingQuestion: z.string().optional().describe('activeTopic 里还没问出口的问题'),
      motivation: z.string().optional().describe('pendingThought 的动机，如 curiosity/sociability'),
      expiresAtMs: z.number().optional().describe('pendingThought 过期毫秒数，默认 2 小时')
    }).optional().describe('附加信息')
  },
  async ({ key, token, category, content, extra }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-append', {
        method: 'POST',
        body: JSON.stringify({ key, category, content, extra: extra || {} }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆写入失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_query',
  '查看当前会话的轻量记忆：进行中的话题、你想说但还没说的话、对群友的印象（只读）。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).optional().describe('可选：只看某一类记忆')
  },
  async ({ key, token, category }) => {
    try {
      const q = new URLSearchParams({ key });
      if (category) q.set('category', category);
      const data = await agentApi(`/api/socialV2/memory?${q.toString()}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆读取失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_remove',
  '删除一条轻量记忆：activeTopic/pendingThought 用 content 匹配原文删除；memberImpression 用 target 参数指定群友名字删除。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).describe('记忆类别'),
    content: z.string().optional().describe('要删除的话题/想法原文（memberImpression 不需要）'),
    target: z.string().optional().describe('memberImpression 时要删除的群友名字')
  },
  async ({ key, token, category, content, target }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-remove', {
        method: 'POST',
        body: JSON.stringify({ key, category, content: content || '', target: target || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆删除失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_clear',
  '清空轻量记忆：不传 category 清空全部；传 activeTopic/pendingThought/memberImpression 只清空对应类别。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).optional().describe('要清空的类别，缺省清空全部')
  },
  async ({ key, token, category }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-clear', {
        method: 'POST',
        body: JSON.stringify({ key, category: category || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆清空失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_slang_query',
  '查看当前已确认的群聊黑话/梗/网络表达（只读）。返回已确认词条列表和格式化黑话表；遇到不熟悉的词可先查这里，再决定是否搜索/使用。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().min(1).describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    q: z.string().optional().describe('可选搜索词，按词条/含义/用法/示例过滤')
  },
  async ({ key, token, q }) => {
    try {
      const query = q ? `&q=${encodeURIComponent(String(q))}` : '';
      const data = await agentApi(`/api/socialV2/slang/query?key=${encodeURIComponent(key)}${query}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询黑话失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_slang_submit',
  '把你在群里经常看到但不确定含义/用法的陌生词、黑话、梗或网络表达提交给管理员筛选。提交后进入候选库，管理员确认后会被写入黑话提示词，成为你后续可查询和使用的记忆。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    content: z.string().describe('要提交的陌生词/黑话/梗（最多 50 字）'),
    context: z.string().optional().describe('可选：你是在什么语境/哪条消息里看到的，帮助管理员判断')
  },
  async ({ key, token, content, context }) => {
    try {
      const data = await agentApi('/api/socialV2/slang/submit', {
        method: 'POST',
        body: JSON.stringify({ key, content, context: context || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `提交黑话失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 图片/表情查看工具（一代/二代仿真共用） ─────────────────────────────────
if (cfg.socialV2?.tools?.getImages !== false) {
  server.tool(
    'qq_get_message_images',
    '获取指定 QQ 消息中的图片/表情，并直接以图像内容返回给模型（视觉模型可“看懂”）。当消息文本里出现 [图片]、[表情] 或 hasMedia=true 时调用。支持一条消息里的多张图片/表情；二代模式下必须携带会话令牌。**动图（GIF/动态表情）会被桥接抽帧拼成多格图再给你**：说明里会写「动图 N 帧/…s，已抽 X 帧拼成 A×B 网格，行优先 左上→右下」——按格子顺序理解动作即可，不要把它当成一张九宫格照片；没有这类说明就是静态图。体积过大的图会被自动缩放/重编码，说明里会给出原始尺寸与体积；如果真的压不到可用体积，返回里会直接写明原因（例如「超过上限」），此时如实告诉对方你看不到，不要编造画面。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      messageId: z.union([z.number(), z.string()]).describe('要查看的消息 id（QQ 消息 id 可为负数；二代也可用本地 seq）'),
      token: z.string().optional().describe('二代会话令牌（reserved2 下必填，见唤醒提示中的【会话令牌】）')
    },
    async ({ key, messageId, token }) => {
      try {
        const q = new URLSearchParams({ key, messageId: String(messageId) });
        const data = await agentApi(`/api/images/message?${q.toString()}`, {
          headers: token ? { 'x-agent-token': token } : {},
          timeoutMs: 180000
        });
        const images = Array.isArray(data?.images) ? data.images : [];
        if (!images.length) {
          return { content: [{ type: 'text', text: `消息 ${messageId} 没有可返回的图片/表情：${data?.note || '未找到'}` }] };
        }
        const content = [];
        const textParts = [];
        for (const img of images) {
          if (img?.data && img?.mimeType) {
            textParts.push(`[${img.kind === 'face' ? '表情' : '图片'}${img.index ?? ''}${img.text ? ' ' + img.text : ''}]`);
            content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
          } else {
            textParts.push(`[${img.kind === 'face' ? '表情' : '图片'}${img.index ?? ''}${img.text ? ' ' + img.text : '（获取失败）'}]`);
          }
        }
        if (textParts.length) {
          content.unshift({ type: 'text', text: `消息 ${messageId} 的媒体内容（${images.length} 项）：\n${textParts.join('\n')}` });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 表情包体系工具（二代仿真模式） ─────────────────────────────────────────
if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.listStickers !== false) {
  server.tool(
    'qq_list_stickers',
    '查看 QQ 账号上已收藏的表情包（自定义表情）列表：包含 emoji_id、备注 desc、本地笔记 localNote、标签 tags、使用次数等。可通过 query 按备注/笔记/标签搜索；无备注的表情可以先调用 qq_get_sticker_image 看图理解，再用 qq_sticker_note 记下含义；确实该清理的（糊图/重复/用不上）可以用 qq_delete_sticker 删掉。刚新增/删除表情后如需立即同步，请传 refresh=true。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      query: z.string().optional().describe('可选搜索词，按备注/本地笔记/标签/用法过滤'),
      count: z.number().optional().describe('最多返回条数，默认 100（够覆盖整个收藏），受 socialV2.sticker.maxListCount 配置上限约束（当前通常 100）'),
      refresh: z.boolean().optional().describe('是否强制从 QQ 重新同步收藏表情，默认 false（走缓存）')
    },
    async ({ key, token, query, count, refresh }) => {
      try {
        // 强制同步走 POST：GET 上的 refresh 参数会让「读接口」产生写副作用
        // （真的去问 OneBot 拉收藏表情并落盘 state/stickers.json），
        // 从而绕开控制台对所有非 GET 请求的 CSRF 防护（一个 <img src=...> 就能触发）。
        const data = await agentApi('/api/socialV2/sticker-list', {
          method: 'POST',
          headers: { 'x-agent-token': token },
          body: JSON.stringify({ key, query: query ? String(query) : '', count, refresh: refresh === true, token })
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取表情列表失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.getStickerImage !== false) {
  server.tool(
    'qq_get_sticker_image',
    '获取指定收藏表情的图片内容并直接以图像返回给模型（视觉模型可“看懂”）。当 qq_list_stickers 返回的表情 desc/localNote 为空、或你想确认表情实际长什么样时调用。stickerId 可用 qq_list_stickers 返回的 id / md5 / url。动图表情会被抽帧拼成多格图（行优先：左上→右下），说明里会写帧数与网格尺寸；体积过大时会自动缩放，说明里会给出原始尺寸。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）')
    },
    async ({ key, token, stickerId }) => {
      try {
        const q = new URLSearchParams({ key, stickerId: String(stickerId) });
        const data = await agentApi(`/api/socialV2/sticker-image?${q.toString()}`, { headers: { 'x-agent-token': token }, timeoutMs: 180000 });
        if (!data?.image?.data || !data?.image?.mimeType) {
          return { content: [{ type: 'text', text: `表情没有可返回的图片：${errorText(data?.error, '未知')}` }], isError: true };
        }
        const content = [
          { type: 'text', text: `表情 ${data.sticker?.id || stickerId}${data.sticker?.desc ? '（备注：' + data.sticker.desc + '）' : ''} 的图片内容：${data.note ? '（' + data.note + '）' : ''}` },
          { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
        ];
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取表情图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.sendSticker !== false) {
  server.tool(
    'qq_send_sticker',
    '在指定会话发送一个 QQ 收藏表情包（自定义表情）。stickerId 用 qq_list_stickers 返回的 id / md5 / url。注意：一条消息只能是一张表情，不能在同一气泡里附带文字；想说的话请先用 qq_send_message / qq_reply 作为单独气泡发送，再单独发这张表情。需要引用/点名时可用 replyToMessageId / atUserId（群聊）。真人偶尔用表情包很自然，但别刷屏。发送频率受控制台「表情包参数 → 发送频率档位」限制（不发表情/少量/适中/较多/完全根据人设来）：被拒（429/403）就自然收手，不要连发重试，也不要跟群友解释系统限制。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
      atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊中可选，私聊不可用）')
    },
    async ({ key, token, stickerId, replyToMessageId, atUserId }) => {
      try {
        const data = await agentApi('/api/socialV2/send-sticker', {
          method: 'POST',
          body: JSON.stringify({ key, stickerId: String(stickerId), replyToMessageId, atUserId: atUserId ?? null }),
          headers: { 'x-agent-token': token },
          timeoutMs: 300000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送表情失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.collectSticker !== false) {
  server.tool(
    'qq_collect_sticker',
    '收藏当前会话里别人发的一张表情/图片到你的 QQ 收藏表情，并可写一句简短备注（如“好图偷了，兄弟”）。messageId 用 qq_get_unread_messages / qq_get_recent_messages 返回的 messageId 或 seq。注意：不要频繁收藏，只在真的觉得有意思/好用/戳中你时才偷图；收藏后你可以在 qq_list_stickers 里看到并继续使用。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      messageId: z.string().describe('要收藏的那条消息的 messageId 或 seq（来自 qq_get_unread_messages / qq_get_recent_messages）'),
      remark: z.string().optional().describe('简短备注，最多 20 字，例如“好图偷了，兄弟”')
    },
    async ({ key, token, messageId, remark }) => {
      try {
        const data = await agentApi('/api/socialV2/collect-sticker', {
          method: 'POST',
          body: JSON.stringify({ key, messageId: String(messageId), remark: remark || '' }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `收藏表情失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.deleteSticker !== false) {
  server.tool(
    'qq_delete_sticker',
    '从你的 QQ 收藏表情里删除**一个**表情（不可恢复：除非有人再发一次同一张图，否则就没了）。'
    + '只在确实该删时用：糊得看不清、重复、完全用不上、或者让人不适/不合适的。'
    + '**不要一次删一堆、不要因为一时情绪清空收藏**；删之前先用 qq_list_stickers 确认 id/备注，'
    + '一次只传一个 stickerId（id / md5 / url 都行）。'
    + '权限：默认「仅应要求」——只有管理员本人要求（或刚说过话）才删得动；群友让删会被拒绝，'
    + '管理员没开这个能力时直接 403。有每分钟/每小时/每天上限。'
    + '返回 verified=true 表示删除后重新拉列表确实看不到它了；verified=false 时如实说“可能还没同步”，'
    + '不要编造已删除。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('要删除的表情标识：emoji_id / md5 / url（来自 qq_list_stickers）')
    },
    async ({ key, token, stickerId }) => {
      try {
        const data = await agentApi('/api/socialV2/delete-sticker', {
          method: 'POST',
          body: JSON.stringify({ key, stickerId: String(stickerId) }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        const d = data?.deleted ?? {};
        const label = d.desc || d.localNote || d.id || stickerId;
        const lines = [`已删除收藏表情：${label}${d.id ? `（id=${d.id}）` : ''}`];
        lines.push(data?.verified === true
          ? '回读确认：重新拉取收藏列表后已经看不到它了（verified=true）。'
          : '回读确认：暂时没能确认（可能还在同步）。不要宣称已经确认删除。');
        if (Number.isFinite(Number(data?.remaining))) lines.push(`剩余收藏：${data.remaining} 个`);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `删除表情失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.voice?.enabled !== false && cfg.socialV2?.tools?.sendVoice !== false) {
  server.tool(
    'qq_send_voice',
    '在指定会话发一条 QQ 语音（把语音库里准备好的音频当语音条发出去）。voice 传 qq_list_voices 返回的 name（文件名，可带子目录），也可以直接传语音库里的文件名（不带扩展名也能匹配）。注意：① 只能发语音库（qq-bridge/audio/）里的文件，不能发任意本地路径，也不能发 URL/base64；② 受时长与频率上限约束（见 qq_list_voices 的 limits），超限会被拒绝；③ 语音是「开口说话」的强表达，别滥用，闲聊里偶尔发一条即可；④ 返回的 verified=true 表示已经用 get_msg 回读到这条消息的 record 段（语音确实落地了）—— 只有 verified=true 才能对用户说你发了语音；⑤ readback 只对「收到的」语音有意义（QQ 会转写别人的语音），自己发的语音一般拿不到转写文本，默认关闭，别依赖它。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      voice: z.string().describe('语音库里的文件名（来自 qq_list_voices 的 name，可带子目录/可省略扩展名）'),
      label: z.string().optional().describe('可选：写进会话记录里的说明，如「说了句晚安」'),
      verify: z.boolean().optional().describe('是否回读校验语音已落地（默认 true，建议保持开启）'),
      readback: z.boolean().optional().describe('是否额外索取 QQ 转写文本（自己发的语音通常没有，默认 false）')
    },
    async ({ key, token, voice, label, verify, readback }) => {
      try {
        const data = await agentApi('/api/socialV2/send-voice', {
          method: 'POST',
          body: JSON.stringify({
            key,
            voice: String(voice),
            label: label || '',
            verify: verify !== false,
            readback: readback === true,
            token
          }),
          headers: { 'x-agent-token': token },
          timeoutMs: 300000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送语音失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );

  server.tool(
    'qq_list_voices',
    '查看可用的语音库（qq-bridge 的 audio 目录里准备好的音频文件）：文件名、时长、大小。想发语音前先调用这个看有哪些能发（名字用返回的 name）。返回里 limits 是时长/体积/频率上限。语音库里没有合适内容时不要硬发，也不要假装发了语音。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      probe: z.boolean().optional().describe('是否逐个探测时长（默认 true；文件多时可传 false 加快）')
    },
    async ({ key, token, probe }) => {
      try {
        const q = new URLSearchParams({ key });
        if (probe === false) q.set('probe', '0');
        const data = await agentApi(`/api/socialV2/voices?${q.toString()}`, { headers: { 'x-agent-token': token } });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取语音库失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.tools?.getSelfImage !== false) {
  server.tool(
    'qq_get_self_image',
    '查看你现在的 QQ 头像（取不到时回退到默认 Q 版形象）。被问“你长什么样/发张自拍/你是什么形象”时调用；返回的图片会直接进入你的视觉上下文——按图片里真实的样子描述，不要背设定里的外观。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）')
    },
    async ({ key, token }) => {
      try {
        const q = new URLSearchParams({ key });
        const data = await agentApi(`/api/socialV2/self-image?${q.toString()}`, { headers: { 'x-agent-token': token } });
        if (!data?.image?.data || !data?.image?.mimeType) {
          return { content: [{ type: 'text', text: `没有可返回的形象图片：${errorText(data?.error, '未知')}` }], isError: true };
        }
        return {
          content: [
            { type: 'text', text: data.source === 'default' ? '没读到当前 QQ 头像，这是默认 Q 版形象（描述时说明“这可能不是最新头像”）：' : '这是你现在的 QQ 头像，按图里的样子回答：' },
            { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
          ]
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取形象图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 别人的 QQ 资料 / 头像 / QQ 空间（默认开启）──────────────────────────────
//
// 边界（与 RULES.md、bridge 的 profileTargetAllowed 一致）：
//   · 只能查「本会话/本群确实出现过的人」、私聊对端、机器人自己或 owner；
//     要查其他人必须由管理员本人在私聊里明确要求（管理员发话时可指定任意 QQ 号）。
//   · 每个会话 10 分钟内最多查 profile.maxPer10Min 次（资料与空间读共用预算）。
//   · 头像只从 qlogo 固定地址取（数字 QQ 号拼出来的），不接受任何外部图片 URL。
//   · 发说说走管理员动作队列：owner 本人要求直连，其他人要求会生成确认卡；另有
//     每小时/每天上限与「同样内容不重复发」。
if (cfg.socialV2?.tools?.getUserProfile !== false) {
  server.tool(
    'qq_get_user_profile',
    '查看某个 QQ 号的公开资料，并把头像以图像形式返回给模型（视觉模型能“看懂”）。'
    + '合适时机：想接住对方头像/签名/等级相关的梗、判断对方是不是熟人、被问到“你看看这人”。'
    + '**不要查与当前对话无关的人，也不要一次查一大串 QQ 号**（有每会话配额）。'
    + '只能查本会话/本群出现过的人、私聊对端、你自己或 owner；其他人会被拒绝（让管理员私聊里指定）。'
    + '返回里 profile 是白名单字段（昵称/备注/性别/年龄/签名/等级/Q 龄/在线），avatar 是头像图片；'
    + 'avatarError 表示头像没取到（资料仍然有效），如实说明即可，不要编造长相。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      userId: z.union([z.number(), z.string()]).describe('目标 QQ 号（从消息/成员列表的 userId 拿，不要凭记忆编）'),
      avatar: z.boolean().optional().describe('是否连头像一起返回（默认 true；只想看资料文字时传 false 省上下文）')
    },
    async ({ key, token, userId, avatar }) => {
      try {
        const q = new URLSearchParams({ key, userId: String(userId), avatar: avatar === false ? '0' : '1' });
        const data = await agentApi(`/api/socialV2/user-profile?${q.toString()}`, {
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        const p = data?.profile;
        if (!p) return { content: [{ type: 'text', text: `没有拿到资料：${errorText(data?.error, '网关返回为空')}` }], isError: true };
        const lines = [];
        const from = data?.source?.profile === 'cache' ? '缓存' : '实时';
        lines.push(`QQ ${p.userId} 的资料（${from}）：`);
        lines.push(`昵称：${p.nickname || '（空）'}${p.remark ? `｜你给他的备注：${p.remark}` : ''}`);
        const bits = [`性别：${p.sexLabel || '未知'}`];
        if (p.age != null) bits.push(`年龄：${p.age}`);
        if (p.level != null) bits.push(`QQ 等级：${p.level}`);
        if (p.accountYears != null) bits.push(`Q 龄：${p.accountYears} 年`);
        if (p.vip) bits.push(`会员：是${p.vipLevel ? `（SVIP${p.vipLevel}）` : ''}`);
        lines.push(bits.join('｜'));
        lines.push(`在线：${p.online?.label || '未知'}`);
        if (p.signature) lines.push(`个性签名：${p.signature}`);
        if (p.isSelf) lines.push('（这就是你自己）');
        const content = [{ type: 'text', text: lines.join('\n') }];
        if (data?.avatar?.data && data?.avatar?.mimeType) {
          content.push({ type: 'text', text: '头像如下（按图里真实的样子描述，不要背设定）：' });
          content.push({ type: 'image', mimeType: data.avatar.mimeType, data: data.avatar.data });
        } else if (data?.avatarError) {
          content.push({ type: 'text', text: `（头像没取到：${data.avatarError}；资料仍然有效）` });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `查看 QQ 资料失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.tools?.qzoneRead !== false) {
  server.tool(
    'qq_qzone_read',
    '读取 QQ 空间动态（只读）：scope="self" 读你自己最近发的说说；scope="friends" 读好友动态。'
    + '合适时机：想回顾自己之前发过什么、想接住好友说说的梗、或确认刚才的说说是否真的发出去了。'
    + '返回的是精简后的文本（作者/时间/正文/评论数/图片数），不会把整页 HTML 塞进来。'
    + '**不要频繁翻空间**：它和 qq_get_user_profile 共用每会话配额，且好友动态只有第一页可靠。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      scope: z.enum(['self', 'friends']).optional().describe('self=自己的说说（默认），friends=好友动态'),
      count: z.number().optional().describe('最多返回几条（默认由配置决定，通常 10）')
    },
    async ({ key, token, scope, count }) => {
      try {
        const q = new URLSearchParams({ key, scope: scope === 'friends' ? 'friends' : 'self' });
        if (count != null) q.set('count', String(count));
        const data = await agentApi(`/api/socialV2/qzone?${q.toString()}`, {
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `读取 QQ 空间失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.tools?.qzonePost !== false) {
  server.tool(
    'qq_qzone_post',
    '发一条 QQ 空间说说（公开广播，全好友可见）。**只有管理员明确要求时才发**；群友起哄不算要求。'
    + '权限：管理员本人要求 → 直接发；其他人要求 → 桥接会把确认卡发到管理员私聊，你只会拿到 status="pending"，'
    + '此时不要说已经发了，也不要在确认前反复调用。'
    + '内容：content 是正文（限长）；images 只能填媒体库 media/ 里的**文件名**（不能是 URL/路径/base64，最多 9 张）。'
    + '可见范围 ugcRight：1=所有人（默认）/4=好友/16=部分好友/64=仅自己/128=部分好友不可见；16/128 要配 targetUins。'
    + '有每小时/每天上限与「同样内容不重复发」。返回 verified=true 才代表回读到了这条说说；'
    + 'verified=false 时如实说“可能还在同步”，不要编造 tid。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      content: z.string().describe('说说正文（建议 1~3 句，别写成小作文）'),
      images: z.array(z.string()).optional().describe('配图文件名数组（来自媒体库 media/，最多 9 张）'),
      ugcRight: z.union([z.number(), z.string()]).optional().describe('可见范围：1 所有人（默认）/4 好友/16 部分可见/64 仅自己/128 部分不可见'),
      targetUins: z.array(z.union([z.number(), z.string()])).optional().describe('ugcRight=16/128 时的 QQ 号名单')
    },
    async ({ key, token, content, images, ugcRight, targetUins }) => {
      try {
        const payload = { key, token, content };
        if (Array.isArray(images) && images.length) payload.images = images.map(String);
        if (ugcRight !== undefined && ugcRight !== null && String(ugcRight).trim() !== '') payload.ugcRight = ugcRight;
        if (Array.isArray(targetUins) && targetUins.length) payload.targetUins = targetUins;
        const data = await agentApi('/api/socialV2/qzone-post', {
          method: 'POST',
          body: JSON.stringify(payload),
          headers: { 'x-agent-token': token },
          timeoutMs: 120000
        });
        if (data?.status === 'pending') {
          return { content: [{ type: 'text', text: `${data.message ?? '已发送确认请求'}\n（${data.summary ?? '发说说'}）` }] };
        }
        const verified = data?.verified === true;
        const lines = [`已发布：${data?.summary ?? content}`];
        if (data?.tid) lines.push(`tid：${data.tid}`);
        lines.push(verified ? '回读确认：已在你的空间最新一条里看到它（verified=true）。' : '回读确认：暂时没在最新一条里看到（可能还在同步），不要编造 tid 或宣称已确认。');
        if (data?.images) lines.push(`配图：${data.images} 张`);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      } catch (error) {
        const msg = String(error?.message ?? error);
        if (msg.includes('persona_veto')) {
          return { content: [{ type: 'text', text: `按人设拒绝了这次发说说（persona_veto）：${msg}。不要重试，也不要说已经发了。` }] };
        }
        return { content: [{ type: 'text', text: `发说说失败：${msg}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.stickerNote !== false) {
  server.tool(
    'qq_sticker_note',
    '给一个收藏表情记录你自己的理解/备注/标签/用法，供以后选择表情时参考。这是本地记忆，不会修改 QQ 账号的官方备注；适合对没有备注的表情看图后记住含义。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      note: z.string().optional().describe('你理解的表情含义/适合场景，最多 200 字'),
      tags: z.array(z.string()).optional().describe('可选标签，如 ["嘲讽","笑哭","怼人"]'),
      usage: z.string().optional().describe('可选用法说明，最多 200 字')
    },
    async ({ key, token, stickerId, note, tags, usage }) => {
      try {
        const payload = { key, stickerId: String(stickerId) };
        if (note !== undefined && note !== null) payload.note = String(note);
        if (tags !== undefined && tags !== null) payload.tags = Array.isArray(tags) ? tags.map(String) : [];
        if (usage !== undefined && usage !== null) payload.usage = String(usage);
        const data = await agentApi('/api/socialV2/sticker-note', {
          method: 'POST',
          body: JSON.stringify(payload),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `记录表情备注失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.setStickerRemark !== false) {
  server.tool(
    'qq_set_sticker_remark',
    '修改 QQ 账号里收藏表情的官方备注（desc）。这是写操作，会直接影响 QQ 账号的表情备注；仅在管理员明确允许（socialV2.tools.setStickerRemark=true）时可用。一般优先用 qq_sticker_note 记录自己的理解，不要随意改官方备注。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      remark: z.string().describe('新的表情备注，最多 50 字')
    },
    async ({ key, token, stickerId, remark }) => {
      try {
        const data = await agentApi('/api/socialV2/sticker-remark', {
          method: 'POST',
          body: JSON.stringify({ key, stickerId: String(stickerId), remark: String(remark || '') }),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `修改表情备注失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 合并转发消息查看工具（二代仿真模式） ────────────────────────────────────
if (cfg.socialV2?.tools?.getForwardMsg !== false) {
  server.tool(
    'qq_get_forward_msg',
    '查看当前会话中出现的合并转发消息/聊天记录内容（只读）。当消息文本里出现 `[转发消息 id=...]`，或 `qq_get_unread_messages` / `qq_get_recent_messages` / `qq_get_message_detail` 返回的某条消息带 `forwardIds` / `hasForward: true` 时调用。只能查看当前会话确实收到过的转发消息 id，不能任意读取。返回内容会包含每条消息的 text、media（图片/表情元数据）与 nestedForwardIds；如果合并转发里有图片，工具会直接把最多 5 张图片以图像内容返回给视觉模型；如果里面有嵌套合并转发，会附带嵌套转发 id 和前几条预览，必要时可继续用本工具查看嵌套 id。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      id: z.string().describe('合并转发消息 id（来自消息里的 [转发消息 id=...] 或 forwardIds 数组）')
    },
    async ({ key, token, id }) => {
      try {
        const q = new URLSearchParams({ key, id: String(id) });
        const data = await agentApi(`/api/socialV2/forward-message?${q.toString()}`, {
          headers: { 'x-agent-token': token },
          timeoutMs: 120000
        });
        const content = [{ type: 'text', text: serializeModelData(data) }];
        // 收集所有层级的图片/表情元数据（含嵌套预览），最多返回 5 张。
        const images = [];
        const seen = new Set();
        const collectMedia = (msgs) => {
          if (!Array.isArray(msgs)) return;
          for (const m of msgs) {
            if (!m || typeof m !== 'object') continue;
            for (const media of Array.isArray(m.media) ? m.media : []) {
              if (!media || typeof media !== 'object') continue;
              const keyId = media.url || media.file || media.faceId || '';
              if (!keyId || seen.has(keyId)) continue;
              seen.add(keyId);
              images.push(media);
            }
          }
        };
        collectMedia(data?.messages);
        if (Array.isArray(data?.nestedPreviews)) {
          for (const np of data.nestedPreviews) collectMedia(np?.messages);
        }
        const MAX_IMAGES = 5;
        const imageTexts = [];
        if (images.length) {
          try {
            const mediaRes = await agentApi('/api/socialV2/forward-media', {
              method: 'POST',
              body: JSON.stringify({ key, media: images.slice(0, MAX_IMAGES) }),
              headers: { 'x-agent-token': token },
              timeoutMs: 180000
            });
            const mediaImages = Array.isArray(mediaRes?.images) ? mediaRes.images : [];
            for (const img of mediaImages) {
              if (img?.data && img?.mimeType) {
                content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
                imageTexts.push(`[转发内图片${img.index != null ? ' ' + img.index : ''}${img.text ? ' ' + img.text : ''}]`);
              } else {
                imageTexts.push(`[转发内图片${img.index != null ? ' ' + img.index : ''}（${img.text || '获取失败'}）]`);
              }
            }
          } catch (error) {
            imageTexts.push(`[转发内图片（批量获取失败：${error?.message ?? error}）]`);
          }
        }
        if (imageTexts.length) {
          content.unshift({ type: 'text', text: `合并转发 ${id} 的图片内容（${imageTexts.length} 项）：\n${imageTexts.join('\n')}` });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `查看合并转发失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 管理员动作（唯一的管理类工具） ──────────────────────────────────────────
//
// 注册期开关与其它工具同口径：关了就不注册（省 schema 且不给模型误调的机会）。
// 注意这里读的是**当前** config.json：adminOps/ownerQQ 缺失时按默认值放行，
// 真正的权限判定在桥接侧（令牌 + owner 私聊），MCP 侧不做也不该做授权判断。
function adminOpsToolsEnabled() {
  const c = getConfig();
  if (c?.adminOps?.enabled === false) return false;
  return Boolean(c?.ownerQQ);
}
if (adminOpsToolsEnabled()) {
  // ── 头像目录的只读预览 ────────────────────────────────────────────────
  //
  // 为什么模型需要它们：qq_admin 只接受精确文件名，而 assets 里的图往往是 QQ 下载的哈希，
  // 模型看不到目录就只能猜（实测猜过 xuqingjun.png / 2.png，三次都是「文件不存在」）。
  // 这两个工具把"猜"换成"看"，但边界极窄：只读 mediaDir 第一层、只认图片、不接受路径。
  if (getConfig().adminOps?.assetView?.enabled !== false) {
    server.tool(
      'qq_list_assets',
      '列出头像目录（assets/）里可用的图片：文件名 + 大小。**换头像前先调它拿真实文件名，不要猜文件名。**'
      + '返回的名字直接传给 qq_admin 的 file 字段（带不带 assets/ 前缀都行）。'
      + '只返回第一层的图片、不含子目录，也不读文件内容。**仅管理员私聊可用**：群里或非管理员会话调用会被拒绝，'
      + '被群友问起就说到私聊里找管理员。',
      {
        key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
        token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）')
      },
      async ({ key, token }) => {
        try {
          const q = new URLSearchParams({ key });
          const data = await agentApi(`/api/admin/assets?${q.toString()}`, { headers: { 'x-agent-token': token } });
          const files = Array.isArray(data?.files) ? data.files : [];
          if (!files.length) {
            return { content: [{ type: 'text', text: '头像目录里没有可用的图片（png/jpg/webp/gif）。让管理员先把图片放进 assets/。' }] };
          }
          const lines = files.map((f, i) => `${i + 1}. ${f.name}（${(Number(f.size) / 1024 / 1024).toFixed(2)} MB）`);
          const truncated = data?.truncated ? `\n（只列出前 ${files.length} 张，共 ${data.total} 张）` : '';
          return {
            content: [{
              type: 'text',
              text: `assets/ 里可用的头像（${files.length} 张）：\n${lines.join('\n')}${truncated}\n\n`
                + '知道名字就直接填进 qq_admin 的 file；要用外观描述挑（比如“白毛那张”），用 qq_view_asset 逐张看，最多看 3 张就做决定。'
            }]
          };
        } catch (error) {
          return { content: [{ type: 'text', text: `获取头像目录失败：${error?.message ?? error}` }], isError: true };
        }
      }
    );

    server.tool(
      'qq_view_asset',
      '查看头像目录里的某一张图片（name 必须来自 qq_list_assets）。图片会以图像形式进入你的视觉上下文，'
      + '用于按外观挑头像（例如对方说“白毛那张”“蓝头发那个”）。**仅管理员私聊可用**，群聊/非管理员会话会被拒绝。'
      + '一次只看一张，最多看 3 张就换；看完不要把本地图片内容转发或详细复述到群里。'
      + '图片超过约 2MB 或压不进上下文时会直接报错，如实转告管理员，不要编造画面。',
      {
        key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
        token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
        name: z.string().describe('图片文件名，来自 qq_list_assets 返回的 name（不要带路径、不要带 assets/ 前缀）')
      },
      async ({ key, token, name }) => {
        try {
          const q = new URLSearchParams({ key, name: String(name) });
          const data = await agentApi(`/api/admin/asset?${q.toString()}`, {
            headers: { 'x-agent-token': token },
            timeoutMs: 60000
          });
          if (!data?.image?.data || !data?.image?.mimeType) {
            return { content: [{ type: 'text', text: `没有拿到这张图片：${errorText(data?.error, '未知原因')}` }], isError: true };
          }
          const dims = data.width && data.height ? `（${data.width}×${data.height}）` : '';
          const note = data.note ? `；${data.note}` : '';
          return {
            content: [
              { type: 'text', text: `assets/${data.name}${dims}${note}` },
              { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
            ]
          };
        } catch (error) {
          return { content: [{ type: 'text', text: `查看图片失败：${error?.message ?? error}` }], isError: true };
        }
      }
    );
  }

  server.tool(
    'qq_admin',
    '管理员动作：改 QQ 账号/群的真实设置（机器人在某群的名片、QQ 昵称与个性签名、QQ 头像），'
    + '以及只影响自己的小动作（撤回自己刚发的消息、设置在线状态）。'
    + '按控制台「机器人自主操作」的三档决定：不开放＝你根本没这个能力，调用会被拒；'
    + '仅应要求＝只有管理员本人明确要求才做（按 QQ 号判定，不看会话），其他人要求会被桥接转成确认卡；'
    + '人设自主＝你自己判断，可以主动发起，也可能被按人设驳回（返回 persona_veto）。'
    + '被拒时如实转告，不要换个说法重试。persona_veto 不是故障：用你自己的话解释（可以吐槽），或者不提。'
    + '需要确认时会返回 status="pending"，此时不要重复调用，也不要说"已经改好了"。'
    + '头像只接受 assets/ 里的图片（png/jpg/webp/gif），不接受 URL 或任意本机路径；'
    + '**不确定文件名时先调 qq_list_assets，不要猜**（文件名常是哈希；用外观挑图可用 qq_view_asset）。',
    {
      action: z.enum(['setGroupCard', 'setGroupName', 'setGroupPortrait', 'setQqProfile', 'setQqAvatar', 'recallMessage', 'setOnlineStatus'])
        .describe('要执行的动作'),
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      groupId: z.union([z.number(), z.string()]).optional().describe('群号（群级动作必填，必须在白名单内）'),
      card: z.string().optional().describe('新群名片（空字符串=清除，最多 30 字）'),
      name: z.string().optional().describe('新群名（最多 30 字）'),
      nickname: z.string().optional().describe('新 QQ 昵称（最多 36 字）'),
      personalNote: z.string().optional().describe('新个性签名（最多 100 字，空字符串=清空）'),
      file: z.string().optional().describe('头像文件名：来自 qq_list_assets，如「白毛.png」；带 assets/ 前缀也接受'),
      messageId: z.union([z.number(), z.string()]).optional().describe('要撤回的消息 id（必须是机器人自己发的）；qq_send_message 返回里有 messageIds'),
      targetKey: z.string().optional().describe('撤回时可用：group:群号 或 private:QQ号，撤回机器人最近往它发的一条（跨会话代发后常用）'),
      status: z.enum(['online', 'away', 'invisible', 'busy', 'qme', 'dnd']).optional().describe('在线状态（setOnlineStatus 必填）')
    },
    async (params) => {
      const { action, key, token, ...rest } = params;
      const args = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
      try {
        const data = await agentApi('/api/admin/op', {
          method: 'POST',
          body: JSON.stringify({ key, action, args }),
          headers: { 'x-agent-token': token },
          timeoutMs: 30000
        });
        if (data?.status === 'pending') {
          return { content: [{ type: 'text', text: `${data.message ?? '已发送确认请求'}\n（${data.summary ?? action}）` }] };
        }
        return { content: [{ type: 'text', text: `已执行：${data?.summary ?? action}` }] };
      } catch (error) {
        const msg = String(error?.message ?? error);
        // persona_veto 不是故障，是一次「按人设拒绝」：不标 isError，免得模型把它当成工具坏了去重试。
        if (msg.includes('persona_veto')) {
          return { content: [{ type: 'text', text: `按人设拒绝了这次操作（persona_veto）：${msg}。不要重试，也不要说已经做了；用你自己的话说明为什么不做，或者干脆不提。` }] };
        }
        return { content: [{ type: 'text', text: `管理员动作失败：${msg}` }], isError: true };
      }
    }
  );
}

// ── 跨会话委派：让目标会话用它自己的人设说 ──────────────────────────────────
//
// 与 qq_send_message 的分工：
//   · qq_send_message 适合“原样发这段文字”（引述、转发、固定文案）；
//   · qq_delegate 适合“去那个群回复/说一句”——任务投给目标会话，由它用自己的系统提示、
//     历史和人设来写，避免拿当前会话的人设去套（这就是人设串台的根因）。
server.tool(
  'qq_delegate',
  '让另一个白名单会话用**它自己的人设**去说话/回复。管理员让你“去某个群回复/接一句”时优先用它；'
  + 'qq_send_message 会沿用你当前会话的人设，跨会话发言容易串台。投递是异步的：返回 queued 后不要替它写，也不要宣称已经说了。'
  + '需要控制台「跨会话委派」权限；目标会话已静音时会拒绝，先用 /unmute。',
  {
    key: z.string().describe('当前会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('当前会话令牌（见唤醒提示中的【会话令牌】）'),
    targetKey: z.string().describe('目标会话 key，例如 group:123456789'),
    instruction: z.string().describe('要它做什么，例如“回复群里最下面那条：角色甲不用 token；用你平时的语气”')
  },
  async ({ key, token, targetKey, instruction }) => {
    try {
      const data = await agentApi('/api/socialV2/delegate', {
        method: 'POST',
        body: JSON.stringify({ key, targetKey, instruction }),
        headers: { 'x-agent-token': token },
        timeoutMs: 15000
      });
      return { content: [{ type: 'text', text: `已委派给 ${data?.targetKey ?? targetKey}${data?.id ? `（#${data.id}）` : ''}：它会用自己的身份处理，你不用替它写。` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `委派失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

await server.connect(new StdioServerTransport());