// 人设锚：从人格卡里抽一段 ≤400 字的"我是谁"，每次唤醒都注入。
//
// 为什么需要它（设计文档 §5）：现在唤醒提示只给【当前角色】一个名字，完整人格卡要靠模型
// 主动调 qq_get_prompt 才有；长会话里模型不调，人设就会漂成"通用 AI 助手"。
// 锚不是人格卡摘要，而是"最低限度的人设连续性"：身份 + 说话方式 + 雷点。
//
// P1 用规则抽取（标题定位 + 段落裁剪），不调模型；后续可以让巩固 worker 生成更精炼的版本，
// 但必须落盘缓存、按角色卡 mtime/size 失效 —— 不能每次唤醒都重算。
//
// 低耦合：本文件不 import 桥接的 role-card.js。人格卡的模式选择（〔一代〕/〔二代〕）
// 由调用方负责（bridge 里是 selectRoleText(raw, 'v2')），这里只接收"已经选好的文本"，
// 这样记忆模块可以整体拷走、独立测试，删掉也不影响角色卡系统。
import { truncate } from './util.js';

export const ANCHOR_MAX_CHARS = 400;
// 抽锚算法版本：改动 buildAnchor 的取句/拼接逻辑时 +1，用于让磁盘上的 anchor.json 缓存失效
// （缓存 stamp = 角色卡 mtime/size + 本版本号；不加版本号时改了算法也看不到效果）。
export const ANCHOR_VERSION = 2;

function splitSections(text) {
  const sections = [];
  let current = { heading: '', lines: [] };
  for (const line of String(text ?? '').split('\n')) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      sections.push(current);
      current = { heading: heading[1].trim(), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);
  return sections.filter((s) => s.heading || s.lines.join('').trim());
}

function paragraphs(lines) {
  const out = [];
  let buf = [];
  for (const line of lines) {
    if (!line.trim()) {
      if (buf.length) out.push(buf.join('\n').trim());
      buf = [];
    } else {
      buf.push(line);
    }
  }
  if (buf.length) out.push(buf.join('\n').trim());
  return out.filter(Boolean);
}

/** 截到最近的句末标点，避免锚以半句话结尾。 */
function cutAtSentence(text, maxChars) {
  const s = String(text ?? '').trim();
  if (s.length <= maxChars) return s;
  const head = s.slice(0, maxChars);
  const idx = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'), head.lastIndexOf('；'), head.lastIndexOf('\n'));
  return idx >= maxChars * 0.4 ? head.slice(0, idx + 1).trim() : head.trim();
}

function bulletLines(lines) {
  return lines
    .map((l) => l.trim())
    .filter((l) => /^([-*]|\d+[.、])\s*/.test(l))
    .map((l) => l.replace(/^([-*]|\d+[.、])\s*/, '').trim())
    .filter(Boolean);
}

/**
 * 从人格卡原文抽人设锚。
 * @param {string} roleText roles/<name>.md 的原始内容（可含〔一代〕/〔二代〕标记）
 * @param {{maxChars?: number}} [options]
 * @returns {string} 空串表示抽不出来（调用方应回落到不注入）
 */
export function buildAnchor(selectedText, options = {}) {
  const maxChars = Math.max(80, Number(options.maxChars) || ANCHOR_MAX_CHARS);
  // 入参必须是调用方按模式选好的文本（bridge 用 selectRoleText(raw, 'v2')）。
  // 记忆模块不感知〔一代〕/〔二代〕标记，也就不依赖桥接的 role-card.js。
  const selected = String(selectedText ?? '');
  if (!selected.trim()) return '';  const sections = splitSections(selected);
  const identity = sections.find((s) => /你是谁|身份|我是谁/.test(s.heading)) || sections[0];
  // 优先「说话方式」，没有才退到「说话铁律」：铁律是禁令，风格才像人设。
  const style = sections.find((s) => /说话方式|说话风格|语气/.test(s.heading))
    || sections.find((s) => /说话/.test(s.heading));

  const parts = [];

  if (identity) {
    // 有些人格卡把标题和正文写在同一行（`## 一、你是谁 你是 DeepSeek，…`），
    // 正文会被当成 heading 抓走，这里把 heading 去掉编号/标题词后当第一段用。
    const headingMatchesIdentity = /你是谁|身份|我是谁/.test(identity.heading);
    const inline = headingMatchesIdentity
      ? identity.heading
        .replace(/^#*\s*/, '')
        .replace(/^[一二三四五六七八九十0-9]+[、.．)]\s*/, '')
        .replace(/^(你是谁|身份|我是谁)\s*[:：]?\s*/, '')
        .trim()
      : '';
    const paras = paragraphs(identity.lines)
      // 引用块是写给人看的注释（> 最高原则…本卡只写…），不是人设本体；
      // 老爹专属只在 owner 面前生效，放进常驻锚会把温顺语气带到群里。
      .filter((p) => !p.trim().startsWith('>') && !/本卡只写|仿真提示词|老爹专属|温顺小鲸鱼模式/.test(p));
    const first = inline.length > 10 ? inline : paras[0] || inline;
    if (first) parts.push(cutAtSentence(first, Math.min(240, Math.max(120, maxChars - 120))));
  }

  if (style) {
    // 行尾的「。」先去掉再拼：否则会出现「…想补一句就让它成为下一条。；默认 1~10 字」这种双标点。
    const bullets = bulletLines(style.lines)
      .slice(0, 2)
      .map((line) => line.replace(/[。；;！!]+$/, '').trim())
      .filter(Boolean);
    if (bullets.length) parts.push(cutAtSentence(bullets.join('；'), 110));
  }

  const risk = /[^。\n]{0,30}雷点[^。\n]{0,70}/.exec(selected);
  // 身份段里常自带「被叫大肥鱼是雷点」，别再重复一遍——锚只有 400 字，重复最浪费。
  const riskText = risk ? cutAtSentence(risk[0].trim(), 80) : '';
  if (riskText && !parts.some((p) => p.includes(riskText.slice(0, 20)))) {
    parts.push(`雷点：${riskText}`);
  }

  const joined = parts
    .filter(Boolean)
    .map((p) => String(p).replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/；{2,}/g, '；')
    .trim();
  return truncate(joined, maxChars);
}
