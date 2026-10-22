// 系统指令屏蔽（command shield）。
//
// 背景：SnowLuma 自带一条“状态指令”（默认 `#sl`，可在 SnowLuma 的 OneBot 配置里
// 改触发词/关闭）。命中时是 **SnowLuma 自己**直接回复一条系统信息：
//
//   SnowLuma 状态
//   版本: 2.1.1
//   平台: win32-x64
//   运行时长: …
//
// 这条回复发生在 OneBot 适配器把事件交给桥接**之前**（见 SnowLuma 的
// `handleStatusCommand`），所以桥接的出站审计（auditAndSend / SENSITIVE_RE）
// 完全看不到它；同时默认 `swallow:false` 会把原消息继续投递给 agent，
// 群友还能顺手诱导 AI 补充“你跑在什么系统/什么版本/在哪台机器上”。
//
// 本模块负责**进线侧**这一层：在 handleIncoming 里命中即丢弃，消息不会进入
// 未读队列、上下文、黑话学习窗口，模型根本看不到，也就无从复述。
// 上游那层（让 SnowLuma 根本不回）见 scripts/harden-snowluma-status.mjs；
// 两层都要有：只做上游，SnowLuma 升级/改配置后会静默失效；只做下游，
// 群里已经先看到 SnowLuma 的那条回复了。
//
// 规则刻意做成“少量明确词 + 可扩展正则”，不做“所有 # 开头都算命令”——
// 中文群里 `#话题` 这种写法并不罕见，误杀正常聊天的代价比漏一条高。

/**
 * 命中规则：
 *   - kind='token'：ASCII 命令词（#sl / #help / #version…）。后面允许跟空白或标点，
 *     但**不允许紧跟中文**（否则 `#slim`、`#statusbar` 这类会误伤；
 *     `输入#sl试试` 也不算调用，SnowLuma 本身也不会命中）。
 *   - kind='word'：中文命令词（#状态 / #帮助 / #版本…）。要求命令之后只剩空白/标点，
 *     避免把 `#命令行`、`#版本号`、`#状态栏` 这类正常话题标签当成指令。
 */
const RULES = [
  { id: 'snowluma-status', label: 'SnowLuma 状态指令', kind: 'token', core: String.raw`sl|snowluma` },
  { id: 'status', label: '状态指令', kind: 'token', core: 'status' },
  { id: 'status', label: '状态指令', kind: 'word', core: '状态' },
  { id: 'help', label: '帮助/指令列表', kind: 'token', core: String.raw`help|command|commands|cmd` },
  { id: 'help', label: '帮助/指令列表', kind: 'word', core: String.raw`帮助|指令|命令` },
  { id: 'version', label: '版本/信息指令', kind: 'token', core: String.raw`version` },
  { id: 'version', label: '版本/信息指令', kind: 'word', core: '版本' },
  { id: 'lifecycle', label: '重启/停止类指令', kind: 'token', core: String.raw`restart|reload|stop|shutdown|exit` },
  { id: 'lifecycle', label: '重启/停止类指令', kind: 'word', core: String.raw`重载|重启|停止|关机|退出` }
];

// 词边界（前缀）：命令前必须是开头、空白、标点或中文——中文群里常见“输入#sl”这种写法。
const EDGE = String.raw`(?:^|[\s\u3000,，。.!！?？~～、;；:：()\[\]{}《》「」『』"'“”‘’\u4e00-\u9fff])`;
// 命令之后的边界：结尾、空白或标点。**刻意不含中文**，见 RULES 的注释。
const TAIL = String.raw`(?=$|[\s\u3000,，。.!！?？~～、;；:：()\[\]{}《》「」『』"'“”‘’])`;
const TRAILING_PUNCT = String.raw`[\s\u3000,，。.!！?？~～、;；:：]*$`;

const COMPILED = RULES.map((rule) => ({
  id: rule.id,
  label: rule.label,
  // 第一个捕获组只包住命令本身（不含边界字符），日志里展示更干净。
  re: rule.kind === 'word'
    ? new RegExp(`${EDGE}(#\\s*(?:${rule.core}))${TRAILING_PUNCT}`, 'i')
    : new RegExp(`${EDGE}(#\\s*(?:${rule.core}))${TAIL}`, 'i')
}));

/**
 * 把任意触发词（例如 SnowLuma 配置里被改过的状态指令）编译成一条
 * “带词边界、在归一化文本上搜索”的正则源码，供 extraPatterns 使用。
 *
 * 为什么要它：SnowLuma 的触发词是可配置的。默认 `#sl` 已被内置规则覆盖，
 * 但如果管理员把它改成 `#查状态`，桥接就得按**实际配置**补一条，否则依旧漏。
 *
 * @param {string} trigger 原样触发词
 * @returns {string|null}
 */
export function commandTokenPattern(trigger) {
  const normalized = normalizeCommandText(trigger);
  if (!normalized) return null;
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 捕获组让命中日志只显示触发词本身，不带前后边界字符。
  return `${EDGE}(${escaped})${TAIL}`;
}

/** 配置默认值；config.json 的 security.commandShield 覆盖。 */
export const COMMAND_SHIELD_DEFAULTS = Object.freeze({
  enabled: true,
  // 拦截后是否私聊通知管理员（按 notifyCooldownMs 限频，避免被刷屏）。
  notifyOwner: true,
  notifyCooldownMs: 10 * 60 * 1000,
  // 额外规则：字符串形式的正则源码，在归一化文本上**搜索**（不需要 ^）。
  // 冻结：默认值会被多个会话共享，避免有人原地 push 污染默认配置。
  extraPatterns: Object.freeze([])
});

const EXTRA_CACHE = { key: '', rules: [] };

/**
 * 归一化待匹配文本：全角转半角（＃→#、ｓｌ→sl）、去零宽字符、折叠空白、小写。
 */
export function normalizeCommandText(text) {
  return String(text ?? '')
    .normalize('NFKC')
    // 零宽字符/方向标记：有人会拿它们拆开 `#sl` 绕过简单字符串匹配。
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * 去掉开头的 @ 提及（QQ 把 at 段渲染成 `@昵称`）。
 * 只处理开头连续的提及，不改动正文里的 @，避免把“跟 A 说 #sl”这类
 * 正常文本结构改坏。
 */
export function stripLeadingMentions(text) {
  let s = String(text ?? '').trim();
  for (let i = 0; i < 8; i += 1) {
    const next = s.replace(/^@[^\s@#]{1,64}\s*/, '').trim();
    if (next === s) break;
    s = next;
    if (!s) break;
  }
  return s;
}

function compileExtra(patterns) {
  const list = Array.isArray(patterns) ? patterns : [];
  const key = JSON.stringify(list);
  if (EXTRA_CACHE.key === key) return EXTRA_CACHE.rules;
  const rules = [];
  for (const source of list) {
    if (typeof source !== 'string' || !source.trim() || source.length > 500) continue;
    try {
      rules.push({ id: 'extra', label: '自定义屏蔽规则', re: new RegExp(source, 'i') });
    } catch {
      // 配置里的坏正则不应让整个桥接崩掉：跳过即可，控制台/日志会看到未命中。
    }
  }
  EXTRA_CACHE.key = key;
  EXTRA_CACHE.rules = rules;
  return rules;
}

/** 校验 extraPatterns，返回无法编译的条目（供测试/运维排查）。 */
export function validateCommandShieldPatterns(patterns) {
  const bad = [];
  for (const source of Array.isArray(patterns) ? patterns : []) {
    if (typeof source !== 'string' || !source.trim()) { bad.push(String(source ?? '')); continue; }
    if (source.length > 500) { bad.push(source); continue; }
    try { new RegExp(source, 'i'); } catch { bad.push(source); }
  }
  return bad;
}

/**
 * 判断一条进线文本是否属于“系统指令”。
 *
 * @param {string} text 当前消息自己的文字（不含引用原文）
 * @param {object} [options] security.commandShield 配置
 * @returns {{id:string,label:string,command:string}|null} 命中则返回规则与命中原样
 */
export function matchCommandShield(text, options = {}) {
  const cfg = { ...COMMAND_SHIELD_DEFAULTS, ...(options ?? {}) };
  if (cfg.enabled === false) return null;
  const normalized = normalizeCommandText(text);
  if (!normalized) return null;
  const candidates = [normalized];
  const unmentioned = stripLeadingMentions(normalized);
  if (unmentioned && unmentioned !== normalized) candidates.push(unmentioned);

  const rules = COMPILED.concat(compileExtra(cfg.extraPatterns));
  for (const candidate of candidates) {
    for (const rule of rules) {
      const m = rule.re.exec(candidate);
      if (m) return { id: rule.id, label: rule.label, command: String(m[1] ?? m[0]).trim() };
    }
  }
  return null;
}

export default { COMMAND_SHIELD_DEFAULTS, matchCommandShield, normalizeCommandText, stripLeadingMentions, commandTokenPattern, validateCommandShieldPatterns };
