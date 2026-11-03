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
//
// ── 伪装归一化（为什么需要）────────────────────────────────────────────────
//
// 上面那条正则是**逐字匹配**的，而攻击者只需要让文本"看起来一样、字节不同"就能绕过：
//
//   `C:\Users\…`  →  `C：＼Users＼…`（全角冒号 + 全角反斜杠，NFKC 归一后相同）
//   `C:\Users\…`  →  `C:` + U+200B + `\Users\…`（零宽空格，肉眼不可见）
//   `token=abc`   →  base64(`token=abc`)（整段编码）
//
// 因此判定前先把文本**归一化成若干等价形式**，逐一看是否命中：
//   · 规范形式：NFKC 归一 + 剥掉零宽/双向控制字符；
//   · 紧凑形式：再吃掉空白与 `.` `_` `-`（`t o k e n = a b c` / `to-ken=abc`）；
//   · base64 解码形式：对看起来是 base64 的片段**尝试解码**，解码结果同样过一遍。
//     只接受"能严格往返"的候选（重新编码后与原文一致）与合法 UTF-8，
//     避免把随机的十六进制串误当 base64 而误伤正常消息。
//
// 注意：归一化只影响**判定**，不改写要发送的原文（脱敏仍在原文上做替换）。

/** NFKC 归一 + 剥掉零宽与双向控制字符。 */
export function normalizeSensitiveText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u00ad\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g, '');
}

/** 生成一份文本的等价形式集合，供逐条判定。 */
export function sensitiveTextForms(value) {
  const canonical = normalizeSensitiveText(value);
  const compact = (text) => text.replace(/[\s._-]+/g, '');
  const forms = new Set([canonical, compact(canonical)]);
  // 只解码"看起来像 base64"的片段，且要求严格往返 —— 否则随机十六进制串会被误判。
  for (const form of [...forms]) {
    for (const match of form.matchAll(/[A-Za-z0-9+/_-]{16,}={0,2}/g)) {
      const raw = match[0].replace(/-/g, '+').replace(/_/g, '/');
      const padded = raw.replace(/=+$/, '');
      if (padded.length % 4 === 1) continue;
      const buffer = Buffer.from(padded, 'base64');
      if (buffer.length === 0) continue;
      if (buffer.toString('base64').replace(/=+$/, '') !== padded) continue; // 非严格 base64
      const decoded = buffer.toString('utf8');
      if (!Buffer.from(decoded, 'utf8').equals(buffer)) continue;           // 非合法 UTF-8
      const text = normalizeSensitiveText(decoded);
      forms.add(text);
      forms.add(compact(text));
    }
  }
  return [...forms];
}

const BASE_SENSITIVE_RE = /((?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'<>|]+|\\\\[^\\\s"'<>|]+\\[^\s"'<>|]+|(?<![A-Za-z0-9])(?:\/home\/|\/Users\/|\/etc\/|\/var\/|\/root\/)[^\s"'<>|]*|(?:token|密码|密钥|口令|password|passwd|secret|api[_-]?key|authorization|bearer|access[_-]?key|credential)["']?(?:\s*(?:[:=：]|是|为)\s*["']?[^\s，。；、"']{3,}|\s+[A-Za-z0-9_\-./]{3,}))/i;

/**
 * 结构化敏感判定：`.test()` 会先归一化再匹配（伪装形态也能命中）。
 *
 * 保持 `RegExp` 的形状（`source` / `flags` / `.test()`）是为了不改动既有调用方 ——
 * 桥接里有 15 处直接用 `SENSITIVE_RE.test(...)`，还有一处用 `SENSITIVE_RE.source`
 * 动态补 `g` 做替换。
 */
export const SENSITIVE_RE = new class StructuredSensitiveRegExp extends RegExp {
  test(value) {
    return sensitiveTextForms(value).some((form) => BASE_SENSITIVE_RE.test(form));
  }
}(BASE_SENSITIVE_RE.source, BASE_SENSITIVE_RE.flags);

/** 供需要"原始正则"的调用方使用（例如做替换时）。 */
export const SENSITIVE_PATTERN = BASE_SENSITIVE_RE;
