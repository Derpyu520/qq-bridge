// 人格卡（roles/<名称>.md）的解析与「按仿真模式取用」。
//
// 为什么要分模式：
//   一代仿真（reserved）用空格分条、用 [SILENT] 表示沉默；
//   二代仿真（reserved2）必须用工具发言（qq_send_message 的数组分条），没有 [SILENT]。
//   同一张人格卡被两种模式共用时，一代专属指令会与二代工具协议冲突。
// 以前靠 currentRoleHintV2() 对正文做「逐行猜测 + 正则过滤」，既容易误伤又说不清边界。
//
// 现在改为显式标记：在标题里写模式，桥接只取当前模式适用的小节。
//   ## 表情包体系 〔二代〕      → 只在 reserved2 注入
//   ## 分条方式 〔一代〕        → 只在 reserved/chat 注入
//   ## 你是谁                   → 两种模式都注入
// 标记会在注入前从标题里去掉，模型看到的始终是干净的小节标题。
export const ROLE_INJECT_MODES = ['v1', 'v2'];

// 模式标记：`〔二代〕` / `[v2]` / `（reserved2）` 等写法都认。
const MODE_TAGS = [
  { mode: 'v2', re: /[\[〔（(]\s*(?:二代|2\s*代|v2|reserved2)\s*[\]〕）)]/gi },
  { mode: 'v1', re: /[\[〔（(]\s*(?:一代|1\s*代|v1|reserved)\s*[\]〕）)]/gi },
];

function detectMode(heading) {
  for (const tag of MODE_TAGS) {
    tag.re.lastIndex = 0;
    if (tag.re.test(heading)) return tag.mode;
  }
  return 'all';
}

function stripModeTags(heading) {
  let out = String(heading);
  for (const tag of MODE_TAGS) {
    tag.re.lastIndex = 0;
    out = out.replace(tag.re, '');
  }
  return out.replace(/[ \t]+$/, '').replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * 按标题把人格卡拆成小节。
 * @returns {{mode: 'all'|'v1'|'v2', heading: string|null, lines: string[]}[]}
 */
export function parseRoleSections(text) {
  const sections = [];
  let current = null;
  for (const line of String(text ?? '').split('\n')) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!heading) {
      if (!current) {
        current = { mode: 'all', heading: null, lines: [] };
        sections.push(current);
      }
      current.lines.push(line);
      continue;
    }
    const title = stripModeTags(heading[2]);
    current = { mode: detectMode(heading[2]), heading: title, lines: [`${heading[1]} ${title}`] };
    sections.push(current);
  }
  return sections;
}

/**
 * 取出某次仿真真正要注入的人格文本（已去掉模式标记）。
 * @param {'v1'|'v2'} mode
 */
export function selectRoleText(text, mode) {
  const want = mode === 'v1' ? 'v1' : 'v2';
  return parseRoleSections(text)
    .filter((section) => section.mode === 'all' || section.mode === want)
    .map((section) => section.lines.join('\n'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 从角色卡里读取标准「行为合同」小节；没有就返回空对象。 */
export function parseBehaviorContract(text) {
  const lines = String(text ?? '').split('\n');
  const out = { toneByRelation: {}, raw: {} };
  let inSection = false;
  for (const line of lines) {
    if (/^##\s+行为合同\s*$/.test(line.trim())) { inSection = true; continue; }
    if (inSection && /^##\s+/.test(line)) break;
    if (!inSection) continue;
    const m = /^\s*[-*]\s*([^：:]+)[：:]\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1].trim();
    const value = m[2].trim();
    if (!value) continue;
    out.raw[key] = value;
    if (key === '优先级') out.precedence = value;
    else if (key === '被@' || key === '被@回复') out.atMention = value;
    else if (key === '事实') out.facts = value;
    else if (key === '认真') out.serious = value;
    else if (key === '默认长度') out.defaultLength = value;
    else if (key === '主动') out.proactive = value;
    // 「人设自主」档下反驳管理员要求的概率（15% / 0.15 都认）；桥接读它掷骰。
    else if (key === '反驳主人' || key === '反驳') out.vetoOwner = value;
    else if (['owner', '熟人', '常客', '新人', '陌生人'].includes(key)) out.toneByRelation[key] = value;
  }
  return out;
}

/**
 * 报告每个小节在当前模式下是否会被注入，供控制台预览。
 * @param {'v1'|'v2'} mode
 */
export function roleSectionReport(text, mode) {
  const want = mode === 'v1' ? 'v1' : 'v2';
  return parseRoleSections(text).map((section) => ({
    heading: section.heading ?? '(开头部分)',
    mode: section.mode,
    injected: section.mode === 'all' || section.mode === want,
    chars: section.lines.join('\n').trim().length,
  }));
}

/** 统计各模式的字符数，用于控制台提示「去掉另一模式的专属小节后还剩多少」。 */
export function roleCharStats(text) {
  const source = String(text ?? '');
  const sections = parseRoleSections(source);
  const sum = (list) => list.reduce((total, section) => total + section.lines.join('\n').trim().length, 0);
  return {
    total: source.length,
    common: sum(sections.filter((section) => section.mode === 'all')),
    v1Only: sum(sections.filter((section) => section.mode === 'v1')),
    v2Only: sum(sections.filter((section) => section.mode === 'v2')),
    v1: selectRoleText(source, 'v1').length,
    v2: selectRoleText(source, 'v2').length,
  };
}

// 一代仿真遗留指令：未加模式标记时，这些行在二代下会被兜底过滤。
// 正确做法是给所在小节加上 〔一代〕 标记。
export const GEN1_ROLE_LINE_RE = /\[SILENT\]|空格分隔|按空格|用空格|空格分句|空格代表|自动转发|回复会自动|输出\s*\[SILENT\]/i;

// ── 会话级人格解析 ──────────────────────────────────────────────────────────
// 人格状态（state/current-role.json）由 bridge 读写，但「哪个会话用哪张卡」是纯数据判断。
// 放在这个已有的纯模块里：可以直接单测，也避免 bridge 再抄一份 key 正则。

/** 规范会话 key：`group:123` / `private:456`；非法返回 null。 */
export function canonicalRoleKey(key) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return `${m[1]}:${id}`;
}

// 与 bridge 的 sanitizeRoleName 同口径：人格名就是文件名，只允许中文/字母/数字/横线。
function cleanRoleName(name) {
  return String(name ?? '').replace(/[^\w\u4e00-\u9fff-]/g, '').trim();
}

/**
 * 归一化 `state/current-role.json` 的读入结果。
 * 这个文件用户可以直接编辑，所以 key / 人格名 / 条数都必须在这里设界：
 * 非法项直接丢弃，绝不让脏数据进入每条消息的注入路径。
 */
export function normalizeRoleState(raw, maxAssignments = 200) {
  const state = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const mode = state.mode === 'silent' ? 'silent' : 'active';
  const role = typeof state.role === 'string' ? (cleanRoleName(state.role) || null) : null;
  const byKey = {};
  const source = state.byKey && typeof state.byKey === 'object' && !Array.isArray(state.byKey) ? state.byKey : {};
  let count = 0;
  for (const [key, value] of Object.entries(source)) {
    if (count >= maxAssignments) break;
    const canonical = canonicalRoleKey(key);
    if (!canonical || typeof value !== 'string') continue;
    const name = cleanRoleName(value);
    if (!name) continue;
    byKey[canonical] = name;
    count += 1;
  }
  return { role, mode, byKey };
}

/**
 * 解析某个 QQ 会话当前应使用的人格名。
 * 优先级：byKey 例外 > 默认 role > null（不扮演）。
 */
export function resolveRoleName(state, key) {
  const byKey = state && typeof state.byKey === 'object' && !Array.isArray(state.byKey) ? state.byKey : null;
  const canonical = canonicalRoleKey(key);
  if (byKey && canonical && Object.hasOwn(byKey, canonical)) {
    const chosen = byKey[canonical];
    if (typeof chosen === 'string') {
      const name = cleanRoleName(chosen);
      if (name) return name;
    }
  }
  const role = typeof state?.role === 'string' ? cleanRoleName(state.role) : '';
  return role || null;
}

/**
 * 合并角色状态补丁：只改传入字段，未传字段保留原值。
 * bridge 的所有写入都必须走这里 —— 否则 /silent、改名、删除这些只关心 role/mode 的路径
 * 会把 byKey 一起覆盖掉（现有调用点有 9 处）。
 */
export function mergeRoleState(prev, patch = {}) {
  const base = prev && typeof prev === 'object' ? prev : {};
  const prevByKey = base.byKey && typeof base.byKey === 'object' && !Array.isArray(base.byKey) ? base.byKey : {};
  const byKey = patch.byKey === undefined ? { ...prevByKey } : { ...patch.byKey };
  return {
    role: patch.role === undefined ? (base.role ?? null) : patch.role,
    mode: patch.mode === undefined ? (base.mode ?? 'active') : patch.mode,
    byKey
  };
}

/**
 * 给某个会话设置/清除例外人格，返回新的完整状态；key 非法返回 null。
 * role 为空 = 删除该条例外（继承默认），与 /api/role 的语义一致。
 */
export function applyRoleAssignment(state, key, role) {
  const canonical = canonicalRoleKey(key);
  if (!canonical) return null;
  const base = state && typeof state === 'object' ? state : {};
  const byKey = { ...(base.byKey && typeof base.byKey === 'object' && !Array.isArray(base.byKey) ? base.byKey : {}) };
  const name = typeof role === 'string' ? cleanRoleName(role) : '';
  if (name) byKey[canonical] = name;
  else delete byKey[canonical];
  return {
    role: typeof base.role === 'string' ? base.role : null,
    mode: base.mode === 'silent' ? 'silent' : 'active',
    byKey
  };
}
