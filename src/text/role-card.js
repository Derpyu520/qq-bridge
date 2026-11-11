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

// ── JSON 人格卡（roles/<名称>.json）─────────────────────────────────────────
//
// 2026-11 起人格卡支持 JSON：结构化的小节列表，每节自己声明模式。
// Markdown 仍是内部渲染格式（注入/统计/预览都复用 parseRoleSections），
// 所以旧 .md 卡可以无损导入、JSON 卡也能随时导出成文本。
export const ROLE_CARD_SCHEMA = 'qq-bridge.role/v1';
const ROLE_MODES = new Set(['all', 'v1', 'v2']);

/** 把 Markdown 人格卡转成结构化 JSON 卡（旧卡迁移/控制台导入用）。 */
export function roleCardFromText(text) {
  const sections = parseRoleSections(text)
    .map((section) => {
      let level = 0;
      let heading = section.heading;
      let body = section.lines;
      if (heading) {
        const m = /^(#{1,6})\s+/.exec(section.lines[0] ?? '');
        level = m ? m[1].length : 2;
        body = section.lines.slice(1);
      }
      return {
        mode: section.mode,
        ...(heading ? { heading, level } : {}),
        text: body.join('\n').replace(/\s+$/, '')
      };
    })
    .filter((section) => section.heading || section.text.trim());
  return { schema: ROLE_CARD_SCHEMA, sections };
}

/** 结构化 JSON 卡 → Markdown 文本（用于注入、统计与预览）。 */
export function roleCardToText(card) {
  const parts = [];
  for (const section of card.sections) {
    const body = section.text.replace(/\s+$/, '');
    if (section.heading) {
      const tag = section.mode === 'v1' ? ' 〔一代〕' : section.mode === 'v2' ? ' 〔二代〕' : '';
      // 标题行与正文之间用单个换行：正文若以空行开头（旧 .md 的常见写法），
      // 这里会自然还原成「标题 + 空行 + 正文」；手工 JSON 没有空行也不会丢内容。
      parts.push(`${'#'.repeat(section.level || 2)} ${section.heading}${tag}\n${body}`.replace(/\s+$/, ''));
    } else if (body.trim()) {
      parts.push(body);
    }
  }
  return parts.join('\n\n').trim();
}

/** 校验并规范化一份 JSON 卡；抛出的错误带具体字段，方便控制台显示。 */
export function normalizeRoleCard(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('人格卡 JSON 顶层必须是对象');
  }
  if (value.schema != null && value.schema !== ROLE_CARD_SCHEMA) {
    throw new Error(`schema 必须是 "${ROLE_CARD_SCHEMA}"（当前：${String(value.schema)}）`);
  }
  for (const key of Object.keys(value)) {
    if (!['schema', 'name', 'description', 'sections'].includes(key)) {
      throw new Error(`未知字段 "${key}"（允许：schema / name / description / sections）`);
    }
  }
  if (value.name != null && typeof value.name !== 'string') throw new Error('name 必须是字符串');
  if (!Array.isArray(value.sections) || value.sections.length === 0) {
    throw new Error('sections 必须是非空数组');
  }
  const seen = new Set();
  const sections = value.sections.map((section, index) => {
    const at = `sections[${index}]`;
    if (!section || typeof section !== 'object' || Array.isArray(section)) throw new Error(`${at} 必须是对象`);
    for (const key of Object.keys(section)) {
      if (!['mode', 'heading', 'level', 'text'].includes(key)) {
        throw new Error(`${at} 未知字段 "${key}"（允许：mode / heading / level / text）`);
      }
    }
    if (typeof section.text !== 'string') throw new Error(`${at}.text 必须是字符串`);
    const text = section.text.replace(/\r\n/g, '\n').replace(/\s+$/, '');
    // 只有标题、没有正文的小节是合法的（常见于卡的顶层标题）；没有标题又没有正文才是空节。
    if (!text.trim() && section.heading == null) throw new Error(`${at}.text 不能为空`);
    const mode = section.mode ?? 'all';
    if (!ROLE_MODES.has(mode)) throw new Error(`${at}.mode 只能是 all / v1 / v2`);
    let heading = section.heading;
    if (heading != null) {
      if (typeof heading !== 'string') throw new Error(`${at}.heading 必须是字符串`);
      heading = heading.trim();
      if (!heading) throw new Error(`${at}.heading 不能为空字符串（不需要标题就省略该字段）`);
      if (heading.length > 120) throw new Error(`${at}.heading 过长（最多 120 字）`);
      // 同一标题允许按模式各写一份（v1/v2 分开注入）；标题 + 模式完全相同才算重复。
      const key = `${heading}\u0000${mode}`;
      if (seen.has(key)) throw new Error(`小节重复：标题 "${heading}" 在 mode=${mode} 下出现了两次`);
      seen.add(key);
    }
    let level = section.level;
    if (heading != null) {
      const n = Number(level ?? 2);
      if (!Number.isInteger(n) || n < 1 || n > 6) throw new Error(`${at}.level 必须是 1~6 的整数`);
      level = n;
    } else if (level != null) {
      throw new Error(`${at}.level 只能和 heading 一起出现`);
    }
    return { mode, ...(heading != null ? { heading, level } : {}), text };
  });
  return { schema: ROLE_CARD_SCHEMA, ...(value.name ? { name: value.name.trim() } : {}), sections };
}

/** 解析 JSON 卡文本；错误信息对作者可读。 */
export function parseRoleCardJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text ?? ''));
  } catch (error) {
    throw new Error(`JSON 解析失败：${error?.message ?? error}`);
  }
  return normalizeRoleCard(parsed);
}

/** 结构化卡 → 格式化 JSON 文本（控制台编辑/迁移写盘用）。 */
export function roleCardToJson(card) {
  return `${JSON.stringify(card, null, 2)}\n`;
}
