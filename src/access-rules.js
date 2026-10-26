// 白名单判定：谁能驱动这个桥。
//
// 从 bridge.js 里搬出来的两个函数，行为一字不改，只是让它们能被单独测。
// 这两条规则的安全含义比代码量重得多，写错了群里任何人都能驱动本机上的 agent，
// 所以宁可单独一个文件 + 一组测试，也不继续埋在 main() 里。

/**
 * 白名单判定（群 / 私聊共用）。
 *
 * - deny 优先于 allow
 * - allow 列表为空时由 allowAllWhenEmpty 决定（历史行为：默认放行）
 * - kind 用单数 group/private；配置里也接受复数 groups/privates（两种写法都兼容过）
 */
export function allowed(kind, id, cfg) {
  // OneBot 事件里的 id 可能是数字也可能是字符串（int64 序列化差异），统一转字符串比较。
  const s = String(id);
  const denyList = cfg.deny[kind] ?? cfg.deny[kind + 's'] ?? [];
  if (denyList.map(String).includes(s)) return false;
  const allowList = cfg.allow[kind] ?? cfg.allow[kind + 's'] ?? [];
  if (allowList.length > 0) return allowList.map(String).includes(s);
  return cfg.allowAllWhenEmpty;
}

/**
 * 当前模式下这个会话 key 是否可用。
 *
 * closed-agent 只认 owner 私聊 —— 这条比白名单更窄，写死在这里是有意的：
 * 封闭模式给的就是完整工具面，不能让白名单里的第二个人也拿到。
 */
export function modeAllowed(key, kind, id, cfg, mode) {
  if (mode === 'closed-agent') {
    // 封闭 agent 模式：仅 owner 私聊
    return key === `private:${String(cfg.ownerQQ ?? '')}`;
  }
  // chat / reserved / reserved2（仿真模式，暂同 chat 白名单）
  return allowed(kind, id, cfg);
}
