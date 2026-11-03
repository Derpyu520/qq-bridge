/**
 * 每个会话独立的运行模式（会话级模式覆盖）。
 *
 * 桥接原本只有一个**全局** `currentMode`：所有 QQ 会话共用一套运行模式。要让
 * 「这个群跑一代仿真、那个群跑二代仿真、我自己的私聊跑封闭 agent」成为可能，
 * 就需要一个会话级的覆盖层：没有覆盖的会话继续用全局模式，行为不变。
 *
 * ## 为什么不用 `src/core/session-router.mjs`
 *
 * 那个模块的模式模型是「simulation / closed-agent」两分法：`reserved`（一代仿真）
 * 与 `reserved2`（二代仿真）都被归一成 canonical 的 `simulation`。但在桥接里这
 * 两个是**两套不同的子系统**（不同的唤醒调度、不同的工具协议、不同的回复转发
 * 方式），归一会直接丢掉这个区分。所以这里另起一个贴合桥接四模式模型的模块，
 * 只复用 session-router 的 key 规范化助手。
 *
 * ## 设计约束（与 session-router 一致）
 *
 * 1. **纯函数、同步**：不碰 fs / 定时器 / DSH。持久化由调用方负责。
 * 2. **失败关闭**：非法 key、未知模式、缺失 preset 一律抛错。
 * 3. **默认永不特权**：没有覆盖的会话拿不到 `closed-agent`。
 * 4. **closed-agent 只属于 owner 私聊**：其它任何 key 一律拒绝。
 * 5. **actor 必须声明**：本模块不验证调用者身份，只记录 `updatedBy`；
 *    调用方必须自己鉴权，并把返回的审计事件落盘（铁律 L5）。
 */

import { canonicalConversationKey } from './session-router.mjs';

/** 桥接认识的四种会话模式（沿用历史拼写，不做归一）。 */
export const CONVERSATION_MODES = Object.freeze(['chat', 'reserved', 'reserved2', 'closed-agent']);

/** 有本地工具面的特权模式：只允许 owner 私聊。 */
const PRIVILEGED_MODE = 'closed-agent';

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * preset 名必须是安全标识符：字母、数字、点、下划线、连字符。
 *
 * 不只是「非空」：preset 名最终会被拼进 DSH 的会话创建参数与 preset patch 的
 * 查找键，带空格/引号/换行的名字会让「这个 preset 到底是哪个」变得含糊，
 * 也给「构造一个骗过白名单的名字」留了缝。
 */
const PRESET_NAME_RE = /^[A-Za-z0-9._-]+$/;

function isValidPresetName(preset) {
  return typeof preset === 'string' && preset.length > 0 && preset.trim() === preset && PRESET_NAME_RE.test(preset);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
}

/** ownerQQ 允许写成数字或数字串（config.json 里两种都有人写）。 */
function normalizeOwnerQQ(ownerQQ) {
  if (ownerQQ === null || ownerQQ === undefined || ownerQQ === '') return null;
  const t = typeof ownerQQ;
  if (t !== 'string' && t !== 'number') {
    throw new TypeError('ownerQQ must be a positive safe integer or omitted');
  }
  const canonical = canonicalConversationKey(`private:${String(ownerQQ).trim()}`);
  if (canonical === null) throw new TypeError('ownerQQ must be a positive safe integer or omitted');
  return Number(canonical.slice('private:'.length));
}

/** 模式名必须是这四个之一，且拼写精确（不 trim 后再比 —— 那是另一个字符串）。 */
export function isConversationMode(mode) {
  return typeof mode === 'string' && CONVERSATION_MODES.includes(mode);
}

export class ConversationModes {
  #ownerQQ;
  #now;
  #conversations;
  // 全局兜底：没有覆盖的会话用它。桥接的全局模式会随 DSH 设置变化，
  // 所以它不是构造常量，而是由调用方用 setFallback() 跟着更新。
  #fallback = { mode: 'reserved2', preset: 'qq-chat-v2' };

  /**
   * @param ownerQQ  管理员 QQ；未配置时传 null（此时 closed-agent 一律不可用）
   * @param state    持久化状态 `{ version: 1, conversations: {...} }`；省略则从空开始
   * @param now      审计时钟（可注入，便于测试）
   */
  constructor({ ownerQQ = null, state, now = Date.now } = {}) {
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    this.#now = now;
    this.#ownerQQ = normalizeOwnerQQ(ownerQQ);
    this.#conversations = {};

    if (state === undefined || state === null) return;
    if (!isPlainObject(state) || state.version !== 1) {
      throw new TypeError('conversation mode state must have version 1');
    }
    if (!isPlainObject(state.conversations)) {
      throw new TypeError('conversation mode state must have a conversations object');
    }
    const ownerKey = this.#ownerQQ === null ? null : `private:${this.#ownerQQ}`;
    // 先把 key 规范化并查重：`private:42` 与 `private:042` 是同一个会话，
    // 两者同时出现时无论谁赢都是坏状态 —— 单独一遍查重，报错才是「重复」而不是
    // 「某一条载荷碰巧不合法」，结果也不依赖 JSON 的键顺序。
    const seen = new Map();
    for (const rawKey of Object.keys(state.conversations)) {
      const key = canonicalConversationKey(rawKey);
      if (key === null) throw new TypeError(`Invalid conversation key in state: ${rawKey}`);
      if (seen.has(key)) throw new TypeError(`Duplicate conversation key: ${key}`);
      seen.set(key, rawKey);
    }
    for (const [key, rawKey] of seen) {
      this.#conversations[key] = this.#normalizeRecord(state.conversations[rawKey], key, ownerKey);
    }
  }

  get ownerQQ() { return this.#ownerQQ; }

  get ownerKey() { return this.#ownerQQ === null ? null : `private:${this.#ownerQQ}`; }

  #normalizeRecord(record, key, ownerKey) {
    if (!isPlainObject(record)) throw new TypeError(`${key} must be an object`);
    if (!isConversationMode(record.mode)) throw new TypeError(`${key} has an unknown mode`);
    if (!isValidPresetName(record.preset)) {
      throw new TypeError(`${key} requires a valid preset name`);
    }
    if (record.mode === PRIVILEGED_MODE && key !== ownerKey) {
      throw new TypeError('closed-agent is restricted to the owner private conversation');
    }
    const updatedBy = String(record.updatedBy ?? '');
    if (!updatedBy) throw new TypeError(`${key} requires updatedBy`);
    const at = Number(record.at);
    if (!Number.isSafeInteger(at) || at < 0) {
      throw new TypeError(`${key} requires a non-negative safe integer audit timestamp`);
    }
    return Object.freeze({ mode: record.mode, preset: record.preset, updatedBy, at });
  }

  #auditAt() {
    const at = this.#now();
    if (!Number.isSafeInteger(at) || at < 0) {
      throw new TypeError('audit time must be a non-negative safe integer in milliseconds');
    }
    return at;
  }

  /**
   * 设置全局兜底（桥接的全局模式 + 它对应的 preset）。
   *
   * 必须在全局模式变化时同步调用，否则「没有覆盖的会话」会解析出旧模式。
   */
  setFallback(mode, preset) {
    if (!isConversationMode(mode)) throw new TypeError(`Unknown fallback mode: ${String(mode)}`);
    if (!isValidPresetName(preset)) {
      throw new TypeError('fallback preset must be a valid preset name');
    }
    this.#fallback = { mode, preset };
  }

  /** 可持久化的状态快照。 */
  snapshot() {
    const conversations = {};
    for (const [key, record] of Object.entries(this.#conversations)) conversations[key] = { ...record };
    return { version: 1, conversations };
  }

  /** 该会话的覆盖记录；null 表示「没有覆盖，走全局模式」。 */
  overrideFor(key) {
    const canonical = canonicalConversationKey(key);
    if (canonical === null) return null;
    return own(this.#conversations, canonical) ? this.#conversations[canonical] : null;
  }

  /** 该会话的**生效模式**：有覆盖用覆盖，否则用全局模式。 */
  modeFor(key) {
    const record = this.overrideFor(key);
    return record ? record.mode : this.#fallback.mode;
  }

  /** 该会话生效的 preset：有覆盖用覆盖里的，否则用全局的。 */
  presetFor(key) {
    const record = this.overrideFor(key);
    return record ? record.preset : this.#fallback.preset;
  }

  /**
   * 策略指纹：模式或 preset 变了就意味着 DSH 会话必须重建。
   *
   * 指纹里刻意**不含**时间戳与 updatedBy —— 那两个是审计信息，不是策略；
   * 把它们算进去会让「同一个模式被重新设置一次」变成一次假的策略变更，
   * 白白重建会话（上下文全丢）。
   */
  fingerprintFor(key) {
    return JSON.stringify([this.modeFor(key), this.presetFor(key)]);
  }

  /**
   * 设置覆盖。
   *
   * `updatedBy` 必须是已鉴权过的 actor：'console' 或 `command:<ownerKey>`。
   * 返回的审计事件必须由调用方落盘（铁律 L5）。
   */
  setConversation(key, { mode, preset, updatedBy } = {}) {
    const canonical = canonicalConversationKey(key);
    if (canonical === null) throw new TypeError(`Invalid conversation key: ${String(key)}`);
    this.#requireActor(updatedBy);
    if (!isConversationMode(mode)) throw new TypeError(`Unknown conversation mode: ${String(mode)}`);
    if (!isValidPresetName(preset)) {
      throw new TypeError('preset must be a valid preset name');
    }
    if (mode === PRIVILEGED_MODE && canonical !== this.ownerKey) {
      throw new TypeError('closed-agent is restricted to the owner private conversation');
    }

    const before = this.overrideFor(canonical);
    const beforeFp = this.fingerprintFor(canonical);
    const at = this.#auditAt();
    this.#conversations[canonical] = Object.freeze({ mode, preset, updatedBy, at });
    const afterFp = this.fingerprintFor(canonical);

    return Object.freeze({
      key: canonical,
      changedKeys: beforeFp === afterFp ? [] : [canonical],
      auditEvent: Object.freeze({
        type: 'conversation-mode-set',
        key: canonical,
        mode,
        preset,
        updatedBy,
        at,
        before: before ? { ...before } : null,
        after: { mode, preset, updatedBy, at },
        hadOverride: before !== null,
        policyChanged: beforeFp !== afterFp,
      }),
    });
  }

  /** 删掉覆盖，让该会话回到全局模式。 */
  deleteConversation(key, { updatedBy } = {}) {
    const canonical = canonicalConversationKey(key);
    if (canonical === null) throw new TypeError(`Invalid conversation key: ${String(key)}`);
    this.#requireActor(updatedBy);

    const before = this.overrideFor(canonical);
    const beforeFp = this.fingerprintFor(canonical);
    const at = this.#auditAt();
    delete this.#conversations[canonical];
    const afterFp = this.fingerprintFor(canonical);

    return Object.freeze({
      key: canonical,
      changedKeys: beforeFp === afterFp ? [] : [canonical],
      auditEvent: Object.freeze({
        type: 'conversation-mode-deleted',
        key: canonical,
        updatedBy,
        at,
        before: before ? { ...before } : null,
        after: null,
        hadOverride: before !== null,
        noOp: before === null,
        policyChanged: beforeFp !== afterFp,
      }),
    });
  }

  #requireActor(updatedBy) {
    const actor = String(updatedBy ?? '');
    if (actor === 'console') return actor;
    if (this.ownerKey !== null && actor === `command:${this.ownerKey}`) return actor;
    throw new TypeError('updatedBy must identify console or the owner private command');
  }
}
