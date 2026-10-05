// 模式归一 + 从 DSH settings 的 qq-mode 读模式。放单独文件的原因：
// bridge.js 是 import 即启动的主程序，测试引不进来，纯函数放这才能单独测
//（scripts/test-mode-input.mjs）。

// 读 qq-mode 要 user 层优先，别只读 value 层：DSH 0.2.0-rc.2 上 settings/update
// 写完后，当前进程里 describe 的 value 还是旧值（重启 DSH 才更新），新值只出现在
// user 层。只读 value 的话，控制台切的模式会在下一次 5 秒轮询被改回去。

/**
 * 模式拼写的**唯一**归一入口（输入边界）。
 *
 * `simulation` 是规范名（QSH_PLAN.md §2.1：对用户只暴露 `closed-agent` / `simulation`），
 * `chat` / `reserved` / `reserved2` 是历史拼写 —— 必须继续被**接受**（线上桥接持久化的全局值
 * 就是 `reserved2`），但进程内部一律用历史拼写存储与比较：`currentMode === 'reserved2'` 这类
 * 判断遍布发送闸门、定时器与 preset 解析，把规范名直接塞进 `currentMode` 会让它们全部变成假。
 *
 * 旧写法是 `VALID_MODES = ['chat','closed-agent','reserved','reserved2']`，控制台那处还抄了
 * 一份同样的字面量数组。后果是：在 DSH 设置或 `state/mode.json` 里写 `simulation` 会被**静默
 * 忽略**，`currentMode` 保持上一次的值（进程刚起来时是 `chat`，即一代仿真 —— preset 与工具面
 * 都和二代不同，`v2ToolEnabled` 之类的闸门也不生效）。用户以为切到了仿真，实际跑的是另一套，
 * 而且没有任何日志。规范名与历史名必须在这里收敛成同一个内部值。
 */
export const MODE_INPUT_ALIASES = Object.freeze({
  chat: 'chat',
  reserved: 'reserved',
  reserved2: 'reserved2',
  simulation: 'reserved2',
  'closed-agent': 'closed-agent'
});

/** 内部合法模式集合（由别名表派生，避免"两份名单各自漂移"）。 */
export const VALID_MODES = Object.freeze([...new Set(Object.values(MODE_INPUT_ALIASES))]);

/** 输入侧归一：返回内部拼写；无法识别返回 null，由调用方 fail-closed。 */
export function normalizeModeInput(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  return Object.prototype.hasOwnProperty.call(MODE_INPUT_ALIASES, key) ? MODE_INPUT_ALIASES[key] : null;
}

/** 取一个原始设置值：user 层有就取 user，否则取 value。undefined 表示两层都没有。 */
export function settingFromDshNamespace(ns, key) {
  if (!ns) return undefined;
  const fromUser = ns.user?.[key];
  if (fromUser !== undefined) return fromUser;
  return ns.value?.[key];
}

/** 从 qq-mode 命名空间解析模式：user → value 取第一个能识别的；都不行返回 null（调用方回退本地 mode.json）。 */
export function modeFromDshNamespace(ns) {
  for (const source of [ns?.user, ns?.value]) {
    const normalized = typeof source?.mode === 'string' ? normalizeModeInput(source.mode) : null;
    if (normalized) return normalized;
  }
  return null;
}
