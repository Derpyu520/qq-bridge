// 人物熟悉度与关系档位（纯逻辑，可离线回归）。
//
// 为什么单独一层：旧实现把计分（每条 +0.1）和档位判定（type 在第 3 条消息就锁成
// regular）写死在 bridge.js 里，结果 56 个人里熟度中位数 0.5、最高 18.85，
// 而语气早就不看这个数字了 —— 数字纯装饰，档位只看消息条数。
//
// 现在：计分给出有意义的斜率，档位只由「熟悉度 + 消息数」派生，type 不再短路。
export const REGULAR_THRESHOLD = 5;         // 常客：熟悉度 ≥5
export const FAMILIAR_THRESHOLD = 25;       // 熟人：熟悉度 ≥25
export const REGULAR_MIN_MESSAGES = 3;      // 但至少说过 3 句，避免一次搭话就升档
export const FAMILIAR_MIN_MESSAGES = 10;

/** 一次性迁移的版本号：写进 state/social-v2.json 的 peopleScale。 */
export const PEOPLE_SCALE_VERSION = 2;

/**
 * 一条消息涨多少熟悉度。
 * - 接着机器人的话往下说：+2（真互动）
 * - 被 @：+1（明确冲着它来的）
 * - 同一人连发：+0.2（刷屏不该刷出熟悉度）
 * - 普通发言：+0.5
 */
export function familiarityDelta({ respondingToBot = false, atSelf = false, consecutive = false } = {}) {
  if (respondingToBot) return 2;
  if (atSelf) return 1;
  if (consecutive) return 0.2;
  return 0.5;
}

/**
 * 关系档位：只认熟悉度与消息数；只有 owner / stranger 这两个人工标记会被保留。
 * @returns {'owner'|'familiar'|'regular'|'new'|'stranger'}
 */
export function relationTier({ type = 'new', familiarity = 0, messages = 0 } = {}) {
  if (type === 'owner') return 'owner';
  const fam = Math.max(0, Number(familiarity) || 0);
  const msgs = Math.max(0, Number(messages) || 0);
  if (fam >= FAMILIAR_THRESHOLD && msgs >= FAMILIAR_MIN_MESSAGES) return 'familiar';
  if (fam >= REGULAR_THRESHOLD && msgs >= REGULAR_MIN_MESSAGES) return 'regular';
  // 老状态里可能有人工标成 stranger 的（代码不会自动写），别把他升级成"新人"。
  if (type === 'stranger') return 'stranger';
  return 'new';
}

/** 累加并夹在 0~100。 */
export function nextFamiliarity(current, delta) {
  const base = Number(current) || 0;
  const d = Number(delta) || 0;
  return Math.min(100, Math.max(0, base + d));
}

/** 展示用：保留一位小数（旧的 Math.round 把 0.1~0.4 全显示成 0，看起来永远不涨）。 */
export function displayFamiliarity(value) {
  const n = Math.max(0, Number(value) || 0);
  const rounded = Math.round(n * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * 旧状态一次性回填：至少按「每条消息 0.5」补齐，并把 type 重算成与分数一致。
 * 这样升级后不会所有人还停在 0.x，也不会出现「3 条消息的老常客」。
 * @returns {number} 被改动的字段数（0 表示无需迁移）
 */
export function backfillFamiliarity(people) {
  let changed = 0;
  for (const person of Object.values(people ?? {})) {
    const relation = person?.relation;
    if (!relation) continue;
    if (relation.type === 'owner') continue;
    const messages = Math.max(0, Number(person?.stats?.messages) || 0);
    const legacy = Math.max(0, Number(relation.familiarity) || 0);
    const floor = messages * 0.5;
    if (floor > legacy) {
      relation.familiarity = Math.min(100, floor);
      changed += 1;
    }
    const tier = relationTier({ type: relation.type, familiarity: relation.familiarity, messages });
    if (relation.type !== tier) {
      relation.type = tier;
      changed += 1;
    }
  }
  return changed;
}
