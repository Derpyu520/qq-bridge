/**
 * 「这句话要不要叫她」——唤醒判定的全部规则，从 bridge.js 里搬出来的纯函数。
 *
 * 为什么单独成文件：这堆判定原来长在 `main()` 的闭包里（`evaluateWakeTriggerV2`、
 * `isDirectAddress`、`isDirectedAtAi`、`isMustReplyText`、`wakePriorityV2`），
 * 而闭包意味着**测不了** —— bridge.js 一进 harness 就得起整条链路。
 * 这里是踩过的坑的集合（短英文关键词词边界、引用旧消息不算叫名字、概率触发用哪个随机源），
 * 每一条都值得有回归测试。
 *
 * 依赖用取值函数注入，因为它们在运行时才确定：昵称是连上协议端之后才拿到的，
 * 必回关键词能在控制台里改。
 */

/** 唤醒原因的优先级：合并窗口内只保留更「硬」的那个原因。 */
export const WAKE_PRIORITY = {
  private: 100,
  atMention: 90,
  question: 80,
  speaker: 75,
  nameMention: 70,
  keyword: 60,
  anyMessage: 50,
  replyCheck: 40,
  timeout: 30,
  proactiveCheck: 20,
};

/** 与「未读消息」无关的唤醒原因（定时器/引导）：会话繁忙时被暂存后，不能靠 unread 判断还要不要补发。 */
export const TIMER_WAKE_REASONS = new Set(['timeout', 'replyCheck', 'proactiveCheck', 'bootstrap', 'admin']);

/** 短英文/数字关键词用词边界匹配，避免 ADS/BDSM/DSL 误触发成 DS。 */
const WORD_BOUNDED = /^[a-z0-9]+$/;

/**
 * 是否「直接针对 AI」的提问/挑战：提到 AI 相关词且带疑问/比较，或对「你」开火，或追问催促。
 * 纯函数，不依赖昵称，因此单独导出。
 */
export function isDirectedAtAi(textContent) {
  const lower = String(textContent ?? '').toLowerCase();
  const aiMention = /deepseek|claude|chatgpt|gpt|大肥鱼|小鲸鱼|鲸鱼|d指导|d老师|d师傅|深度求索|\bds\b|ai|人工智障|机器人|模型/.test(lower);
  const challenge = /强|弱|行不行|能不能|会不会|是不是|一半|水平|垃圾|废物|白嫖|菜|不如|厉害|赢|输|比.*强|比.*弱/.test(lower);
  const question = /[?？吗呢吧]|怎么|为什么|哪|谁/.test(lower);
  if (aiMention && (question || challenge)) return true;
  // 「你/您」+ 疑问/比较/挑战（放宽，避免漏掉「你有claude一半强吗」这类直接问）
  if (/(你|您).{0,10}(吗|呢|？|\?|怎么|是不是|能不能|行不行|有没有|有|没有|比|不如|强|弱|一半|厉害|垃圾|菜|赢|输)/.test(lower)) return true;
  if (/^(你|您)(是不是|行不行|能不能|会不会|觉得|有|没有)/.test(lower)) return true;
  // 「你是...还是... / 你是...吗 / 你是...？」（如：你是人类还是ai、你是真人吗）
  if (/(你|您)是[^？?。！!]{0,14}(还是|或者|吗|么|？|\?)/.test(lower)) return true;
  // 追问/催促：AI 没回时的真人式催促
  if (/怎么不说话|人呢|回我|说话啊|理我|别装死|在不在|装死|说话/.test(lower)) return true;
  return false;
}

/**
 * 唤醒原因的基名。两种子类型写法都要认：
 *   keyword:小鲸鱼 / speaker:老王     —— 冒号带值
 *   atMention@seq194                  —— @ 带本地 seq（见 bridge.js 里 pendingWakeReasons 的写法）
 * 原来只按冒号切，`atMention@seq194` 会整串拿去查表、查不到就落成优先级 0，
 * 于是「升级唤醒原因」这一步对带 seq 的唤醒一直是失效的。
 */
function reasonBase(reason) {
  return String(reason ?? '').split(/[:@]/)[0];
}

/** 唤醒原因的优先级：数字越大越该优先处理。 */
export function wakePriority(reason) {
  return WAKE_PRIORITY[reasonBase(reason)] ?? 0;
}

export function isTimerWakeReason(reason) {
  return TIMER_WAKE_REASONS.has(reasonBase(reason));
}

/**
 * @param {object} [deps]
 * @param {() => string} [deps.nickname] 机器人昵称（小写）；协议端连上之后才有值。
 * @param {() => string[]} [deps.mustReplyKeywords] config 里的「必须回」关键词。
 * @param {() => number} [deps.random] 概率触发的随机源，测试可注入。
 */
export function createTriggerPolicy(deps = {}) {
  const nicknameOf = deps.nickname ?? (() => '');
  const keywordsOf = deps.mustReplyKeywords ?? (() => []);
  const random = deps.random ?? Math.random;

  const nickname = () => String(nicknameOf() ?? '').toLowerCase();

  /** 在群里是否「在跟她说」：私聊一律算。 */
  function isDirectAddress(textContent, event, kind) {
    if (kind !== 'group') return true;
    const lower = String(textContent ?? '').toLowerCase();
    const selfId = String(event?.self_id ?? '');
    if (selfId && lower.includes('@' + selfId)) return true;
    const nick = nickname();
    if (nick && (lower.includes('@' + nick) || lower.includes(nick))) return true;
    for (const kw of keywordsOf() ?? []) {
      if (lower.includes(String(kw).toLowerCase())) return true;
    }
    if (isDirectedAtAi(textContent)) return true;
    return false;
  }

  /** 活跃期批量检测用的「必须回」判断：不依赖 event，只认昵称/关键词/直接针对 AI 的提问。 */
  function isMustReplyText(textContent) {
    const lower = String(textContent ?? '').toLowerCase();
    const nick = nickname();
    if (nick && (lower.includes('@' + nick) || lower.includes(nick))) return true;
    for (const kw of keywordsOf() ?? []) {
      if (lower.includes(String(kw).toLowerCase())) return true;
    }
    if (isDirectedAtAi(textContent)) return true;
    return false;
  }

  /**
   * reserved2 的唤醒判定：返回原因字符串或 null。
   *
   * @param {object} wakeConfig 该会话的 `st.wakeConfig`（含 triggers）。
   * @param {object} event 原始 OneBot 事件。
   * @param {'group'|'private'} kind
   * @param {string} textContent 含 `[引用 某人：原文]` 的文本。
   * @param {string} plainContent 本条消息自己的文字，不含引用块。
   * @param {boolean} quoteTargetIsSelf 是否引用了自己。
   */
  function evaluateWake(wakeConfig, event, kind, textContent, plainContent, quoteTargetIsSelf) {
    if (kind === 'private') return 'private';
    const tr = wakeConfig?.triggers ?? {};
    if (tr.anyMessage) return 'anyMessage';
    if (tr.atMention) {
      const atSelf = Array.isArray(event?.message)
        && event.message.some(seg => seg?.type === 'at' && String(seg.data?.qq) === String(event?.self_id ?? ''));
      if (atSelf || quoteTargetIsSelf) return 'atMention';
    }
    if (tr.nameMention && nickname()) {
      // 用 plainContent（当前消息自己的文字）：textContent 含 `[引用 某人：原文]`，
      // 引用一条恰好提到机器人昵称的旧消息不该算「叫了名字」（那是被动触发的付费回合）。
      const lower = String(plainContent ?? '').toLowerCase();
      const nick = nickname();
      if (lower.includes('@' + nick) || lower.includes(nick)) return 'nameMention';
    }
    if (Array.isArray(tr.keywords) && tr.keywords.length) {
      const lower = String(plainContent ?? '').toLowerCase();
      for (const kw of tr.keywords) {
        const kwStr = String(kw ?? '').toLowerCase();
        if (!kwStr) continue;
        if (WORD_BOUNDED.test(kwStr) && kwStr.length <= 4) {
          if (new RegExp(`\\b${kwStr}\\b`, 'i').test(lower)) return `keyword:${kw}`;
        } else if (lower.includes(kwStr)) {
          return `keyword:${kw}`;
        }
      }
    }
    if (tr.question && isDirectedAtAi(plainContent)) return 'question';
    if (Array.isArray(tr.speakerIds) && tr.speakerIds.length) {
      const speakerId = String(event?.user_id ?? event?.sender?.user_id ?? '');
      if (speakerId && tr.speakerIds.some(id => String(id) === speakerId)) {
        const senderLabel = event?.sender?.card || event?.sender?.nickname || speakerId;
        return `speaker:${senderLabel}`;
      }
    }
    if (Number(tr.probability) > 0 && random() < Number(tr.probability)) return 'probability';
    return null;
  }

  return { isDirectAddress, isMustReplyText, isDirectedAtAi, evaluateWake, wakePriority, isTimerWakeReason };
}