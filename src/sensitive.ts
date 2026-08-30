// 共享的敏感信息审计正则：桥接回复、MCP 发送、审批/提问文本等统一使用，避免两处维护不一致。
// 拦截本机路径/凭据特征；凭据关键词需带赋值关系才判定，避免误伤正常聊天。
export const SENSITIVE_RE =
  /((?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'<>|]+|\\\\([^\\]+\\\\)+|(?<![A-Za-z0-9])(?:\/home\/|\/Users\/|\/etc\/|\/var\/)[^\s"'<>|]*|(?:token|密码|密钥|口令|password|passwd|secret|api[_-]?key|authorization|bearer|access[_-]?key|credential)(?:\s*(?:[:=：]|是|为)\s*[^\s，。；、]{3,}|\s+[A-Za-z0-9_\-./]{3,}))/i;
