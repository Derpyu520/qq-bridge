// QQ 指令表与解析器。
//
// 设计目标：让群友/管理员在 QQ 里像用其他 QQ 机器人一样用「指令」直接驱动桥接，
// 这些指令由桥接**本地执行**，不进入 DSH、不消耗模型 token。
//
// 本文件保持纯函数（无副作用、无 IO），便于 scripts/test-qq-commands.mjs 单测。

/** 默认指令前缀。全角斜杠一并支持，手机上更常见。 */
export const DEFAULT_PREFIXES = ['/', '／'];

/**
 * 指令表。
 * - name/aliases：指令名（不含前缀），全部小写比较
 * - ownerOnly：是否仅管理员（config.ownerQQ）可用
 * - privateOnly / groupOnly：限定会话类型
 * - usage/desc/category：用于 /help 渲染
 */
export const COMMANDS = [
  { name: 'help', aliases: ['帮助', '指令', '菜单', '?', '？', 'h'], usage: '指令', desc: '显示本帮助', ownerOnly: false, category: '基础' },
  { name: 'status', aliases: ['状态'], usage: '状态', desc: '查看机器人当前状态（模式/会话/模型/唤醒）', ownerOnly: false, category: '基础' },
  { name: 'ping', aliases: ['在吗', '存活'], usage: 'ping', desc: '探活，测一下桥接是否在线', ownerOnly: false, category: '基础' },
  { name: 'bots', aliases: ['机器人', 'bot列表', '机器人列表'], usage: '机器人', desc: '列出本群识别到的其他 QQ 机器人', ownerOnly: false, category: '机器人' },
  { name: 'whoami', aliases: ['我是谁', '身份'], usage: '我是谁', desc: '查看自己的 QQ 号与权限', ownerOnly: false, category: '基础' },

  { name: 'reset', aliases: ['重置', 'new', '重开'], usage: '重置', desc: '重置本会话上下文，下条消息开新上下文', ownerOnly: true, category: '会话' },
  { name: 'model', aliases: ['模型'], usage: '模型 [名称]', desc: '查看或切换本会话使用的模型', ownerOnly: true, category: '会话' },
  { name: 'role', aliases: ['角色'], usage: '角色 [名称|off]', desc: '查看、切换或清除角色扮演', ownerOnly: true, category: '会话' },
  { name: 'silent', aliases: ['静默', 'quiet'], usage: '静默', desc: '进入静默模式：群友消息不再回复', ownerOnly: true, category: '会话' },
  { name: 'active', aliases: ['活跃', '恢复', 'speak'], usage: '活跃', desc: '退出静默模式，恢复正常回复', ownerOnly: true, category: '会话' },
  { name: 'sleep', aliases: ['潜水', '睡'], usage: '潜水 [分钟]', desc: '让机器人潜水（默认 60 分钟），期间只被触发条件唤醒', ownerOnly: true, category: '唤醒' },
  { name: 'wake', aliases: ['唤醒', '起来'], usage: '唤醒', desc: '让机器人回到活跃模式，任何消息都唤醒', ownerOnly: true, category: '唤醒' },
  { name: 'pause', aliases: ['暂停'], usage: '暂停', desc: '暂停 AI 回复（消息只入库不唤醒）', ownerOnly: true, category: '会话' },
  { name: 'resume', aliases: ['继续', '恢复运行'], usage: '继续', desc: '恢复 AI 回复', ownerOnly: true, category: '会话' },
  { name: 'call', aliases: ['调机器人', '呼叫机器人', '喊机器人'], usage: '调机器人 <机器人> <指令内容>', desc: '让机器人去调用群里其他机器人的指令（如 调机器人 签到 签到）', ownerOnly: true, category: '机器人' }
];

/** 指令名 → 指令定义 的索引（含别名）。 */
const INDEX = (() => {
  const map = new Map();
  for (const cmd of COMMANDS) {
    map.set(cmd.name.toLowerCase(), cmd);
    for (const alias of cmd.aliases ?? []) map.set(String(alias).toLowerCase(), cmd);
  }
  return map;
})();

export function findCommand(name) {
  const key = String(name ?? '').trim().toLowerCase();
  if (!key) return null;
  return INDEX.get(key) ?? null;
}

/**
 * 归属某个指令可用性的判断。
 * @param {object} cmd 指令定义
 * @param {{ isOwner?: boolean, isGroup?: boolean, isPrivate?: boolean }} ctx
 */
export function commandAllowed(cmd, ctx = {}) {
  if (!cmd) return false;
  if (cmd.ownerOnly && !ctx.isOwner) return false;
  if (cmd.groupOnly && !ctx.isGroup) return false;
  if (cmd.privateOnly && !ctx.isPrivate) return false;
  return true;
}

/**
 * 解析一条消息是否为指令。
 *
 * 支持的写法：
 *   /状态            → { name:'status', args:'', cmd }
 *   ／潜水 30        → { name:'sleep', args:'30', cmd }
 *   /模型 deepseek-v4-flash
 *
 * 不认识的指令返回 `{ name, args, cmd: null }`（name 为原始词），
 * 便于调用方区分「不是指令」（返回 null）与「是指令但没定义」。
 *
 * @param {string} text 只应传「当前消息自己的文字」，不要带引用原文
 * @param {{ prefixes?: string[], botName?: string }} options
 */
export function parseCommand(text, options = {}) {
  const prefixes = Array.isArray(options.prefixes) && options.prefixes.length ? options.prefixes : DEFAULT_PREFIXES;
  let s = String(text ?? '').trim();
  if (!s) return null;

  // 容忍 "@小鲸鱼 /状态" 这种先 @ 再跟指令的写法：去掉开头的 @名字。
  const botName = String(options.botName ?? '').trim();
  if (botName && s.startsWith('@')) {
    const rest = s.slice(1);
    if (rest.toLowerCase().startsWith(botName.toLowerCase())) {
      s = rest.slice(botName.length).trim();
    }
  }
  if (!s) return null;

  const prefix = prefixes.find((p) => p && s.startsWith(p));
  if (!prefix) return null;

  const body = s.slice(prefix.length).trim();
  if (!body) return null;

  const spaceAt = body.search(/\s/);
  const rawName = spaceAt === -1 ? body : body.slice(0, spaceAt);
  const args = spaceAt === -1 ? '' : body.slice(spaceAt).trim();
  const cmd = findCommand(rawName);
  return { name: cmd ? cmd.name : rawName, rawName, args, prefix, cmd };
}

/**
 * 渲染帮助文本。
 * @param {{ isOwner?: boolean, isGroup?: boolean, prefix?: string, title?: string }} options
 */
export function renderHelp(options = {}) {
  const { isOwner = false, isGroup = false, prefix = '/', title = '指令列表' } = options;
  const usable = COMMANDS.filter((c) => commandAllowed(c, { isOwner, isGroup }));
  if (usable.length === 0) return `${title}\n（当前没有你可用的指令）`;

  const byCategory = new Map();
  for (const cmd of usable) {
    const cat = cmd.category ?? '其他';
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(cmd);
  }

  const lines = [`【${title}】发「${prefix}指令名」即可，例如 ${prefix}状态`];
  for (const [cat, list] of byCategory) {
    lines.push('');
    lines.push(`— ${cat} —`);
    for (const cmd of list) {
      const names = [cmd.usage ?? cmd.name, ...(cmd.aliases ?? [])].join(' / ');
      lines.push(`${names}：${cmd.desc}`);
    }
  }
  if (!isOwner) lines.push('', '（部分管理指令仅管理员可用）');
  return lines.join('\n');
}

/** 给"未知指令"用的提示语；返回 null 表示不要回复（交给下游处理）。 */
export function unknownCommandHint(rawName, { isOwner = false, prefix = '/' } = {}) {
  const name = String(rawName ?? '').trim();
  const base = `不认识的指令「${prefix}${name}」。`;
  if (!isOwner) return `${base}发 ${prefix}帮助 看可用指令。`;
  // 管理员未知指令会原样转给 DSH（DSH 自有斜杠命令，如 /model），这里不抢占。
  return null;
}
