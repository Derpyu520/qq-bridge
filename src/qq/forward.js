// 合并转发消息（合并聊天记录）相关纯函数：
// - 从 OneBot 消息段中提取并清洗 forward id
// - 把 SnowLuma `get_forward_msg` 返回结果格式化为适合 AI 阅读的紧凑结构
// - 暴露每条消息里的图片/表情元数据与嵌套 forward id，供桥接/MCP 进一步读取
//
// 安全原则：
// - forward id 只允许安全字符，长度受限，避免把任意内容当参数传给 OneBot/日志
// - 只格式化，不访问网络；调用方负责“id 必须来自当前会话已见消息”的校验

import { truncateText } from '../text/md-to-plain.js';

export function sanitizeForwardId(value) {
  const s = String(value ?? '').trim();
  if (!s || s.length > 256) return '';
  // 仅用于 OneBot JSON 参数：允许常见 QQ 资源 id 字符，拒绝空白/控制字符。
  if (!/^[\w:.\-/=+@]+$/.test(s)) return '';
  return s;
}

// 从单个 forward 消息段 data 中取 id，供 segmentsToText 与 extractForwardIds 共用。
export function forwardIdFromData(data) {
  const d = data && typeof data === 'object' ? data : {};
  return sanitizeForwardId(d?.id ?? d?.res_id ?? d?.file_id ?? d?.forward_id ?? '');
}

export function extractForwardIds(segments) {
  if (!Array.isArray(segments)) return [];
  const out = [];
  for (const seg of segments) {
    if (!seg || typeof seg !== 'object' || seg.type !== 'forward') continue;
    const id = forwardIdFromData(seg.data);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

function segmentText(seg) {
  if (typeof seg === 'string') return seg;
  if (!seg || typeof seg !== 'object') return '';
  const d = seg.data ?? {};
  switch (seg.type) {
    case 'text': return String(d.text ?? '');
    case 'at': return d.qq === 'all' ? '@全体成员' : `@${d.qq ?? ''}`;
    case 'face': return `[表情${d.id ?? ''}]`;
    case 'image': return '[图片]';
    case 'record': return '[语音]';
    case 'video': return '[视频]';
    case 'file': return `[文件${d.name ?? ''}]`;
    case 'reply': return '[引用]';
    case 'forward': return '[转发]';
    case 'json': return '[卡片消息]';
    default: return `[${seg.type ?? '未知'}]`;
  }
}

function sanitizeCqString(s) {
  // 如果 get_forward_msg 返回的是 CQ 字符串，转为占位符，避免把 CQ 码原样塞给 AI。
  return String(s ?? '').replace(/\[CQ:[^\]]*\]/gi, '[媒体]');
}

function contentToText(content) {
  if (typeof content === 'string') return sanitizeCqString(content);
  if (Array.isArray(content)) return sanitizeCqString(content.map(segmentText).join('').trim());
  if (content && typeof content === 'object') {
    // 兼容单条 segment 对象（例如 { type:'text', data:{...} }）
    if (content.type) return sanitizeCqString(segmentText(content).trim());
    if (typeof content.text === 'string') return sanitizeCqString(content.text);
    if (Array.isArray(content.content)) return sanitizeCqString(content.content.map(segmentText).join('').trim());
  }
  return '';
}

export function nodeText(node) {
  if (!node || typeof node !== 'object') return '';
  // 标准 OneBot 转发节点：{ type:'node', data:{ name, uin, time, content } }
  const data = node.data && typeof node.data === 'object' ? node.data : {};
  const topContent = node.message ?? node.content ?? node.text;
  const dataContent = data.message ?? data.content ?? data.text;
  const text = contentToText(topContent) || contentToText(dataContent);
  return text;
}

function senderName(node) {
  if (!node || typeof node !== 'object') return '';
  const data = node.data && typeof node.data === 'object' ? node.data : {};
  const sender = node.sender;
  // 用 truncateText：群名片里带 emoji 时按码元 slice 会留下孤立高代理。
  if (sender && typeof sender === 'object') {
    const name = sender.nickname || sender.card || sender.user_id || '';
    if (name) return truncateText(String(name), 100);
  }
  if (typeof sender === 'string' && sender) return truncateText(String(sender), 100);
  const name = data.name || data.nickname || data.card || data.uin || data.user_id || node.name || node.nickname || '';
  return truncateText(String(name ?? ''), 100);
}

function senderUserId(node) {
  if (!node || typeof node !== 'object') return null;
  const data = node.data && typeof node.data === 'object' ? node.data : {};
  const sender = node.sender;
  const uid = sender && typeof sender === 'object' ? sender.user_id : data.uin ?? data.user_id ?? node.uin ?? node.user_id;
  return uid != null ? String(uid) : null;
}

function nodeTime(node) {
  if (!node || typeof node !== 'object') return null;
  const data = node.data && typeof node.data === 'object' ? node.data : {};
  const t = node.time ?? data.time;
  return t != null ? Number(t) : null;
}

function nodeMessageId(node) {
  if (!node || typeof node !== 'object') return null;
  const data = node.data && typeof node.data === 'object' ? node.data : {};
  const id = node.message_id ?? node.messageId ?? data.message_id ?? data.id ?? null;
  return id != null ? String(id) : null;
}

function nodeMessageSeq(node) {
  if (!node || typeof node !== 'object') return null;
  const data = node.data && typeof node.data === 'object' ? node.data : {};
  const seq = node.message_seq ?? node.messageSeq ?? data.message_seq ?? data.seq ?? null;
  return seq != null ? String(seq) : null;
}

function nodeContent(node) {
  if (!node || typeof node !== 'object') return [];
  const data = node.data && typeof node.data === 'object' ? node.data : {};
  const topContent = node.message ?? node.content ?? node.text;
  const dataContent = data.message ?? data.content ?? data.text;
  const content = Array.isArray(topContent) ? topContent : Array.isArray(dataContent) ? dataContent : null;
  if (content) return content;
  // 与 contentToText 保持一致：单个消息段也可能承载图片或嵌套转发。
  for (const candidate of [topContent, dataContent]) {
    if (candidate && typeof candidate === 'object') {
      if (candidate.type) return [candidate];
      if (Array.isArray(candidate.content)) return candidate.content;
    }
  }
  // 字符串内容没有可提取的媒体/嵌套转发
  return [];
}

function segmentMedia(seg) {
  if (!seg || typeof seg !== 'object') return null;
  const d = seg.data ?? {};
  if (seg.type === 'image') {
    const file = String(d.file ?? d.file_id ?? d.filename ?? '');
    const url = String(d.url ?? d.src ?? '');
    if (file || url) return { kind: 'image', file: file || undefined, url: url || undefined };
  }
  if (seg.type === 'face') {
    const faceId = String(d.id ?? d.face_id ?? '');
    if (faceId) return { kind: 'face', faceId };
  }
  return null;
}

function segmentNestedForwardId(seg) {
  if (!seg || typeof seg !== 'object' || seg.type !== 'forward') return null;
  return forwardIdFromData(seg.data);
}

// 从一段消息内容（数组）中提取图片/表情与嵌套转发 id。
function collectSegmentMeta(content) {
  const media = [];
  const nestedForwardIds = [];
  if (!Array.isArray(content)) return { media, nestedForwardIds };
  for (const seg of content) {
    const m = segmentMedia(seg);
    if (m) media.push(m);
    const nested = segmentNestedForwardId(seg);
    if (nested && !nestedForwardIds.includes(nested)) nestedForwardIds.push(nested);
  }
  return { media, nestedForwardIds };
}

export function formatForwardResponse(data, options = {}) {
  const maxMessages = Math.max(1, Math.min(100, Number(options.maxMessages) || 50));
  const maxCharsPerMessage = Math.max(1, Math.min(2000, Number(options.maxCharsPerMessage) || 500));
  const raw = Array.isArray(data) ? data : (Array.isArray(data?.messages) ? data.messages : []);
  const total = raw.length;
  const truncatedByCount = total > maxMessages;
  let textTruncated = false;
  const messages = raw.slice(0, maxMessages).map((node, index) => {
    const fullText = nodeText(node);
    // 切点落在代理对中间时必须前移一个码元（判据与 md-to-plain.js 的 splitForQQ 一致）：
    // `slice(0, max)` 是按 UTF-16 码元切的，emoji/生僻字会被切成孤立高代理，
    // 那半个字符既不是合法文本，写进提示词或日志后还会渲染成乱码或替换符。
    let cut = maxCharsPerMessage;
    const cutCode = fullText.charCodeAt(cut - 1);
    if (cutCode >= 0xd800 && cutCode <= 0xdbff) cut -= 1;
    // 与 splitForQQ 相同：切点被逼到 0 时至少保留一个完整码点，
    // 否则 maxCharsPerMessage=1 且开头是 emoji 会让整条预览变成空串。
    if (cut === 0) {
      const first = fullText.charCodeAt(0);
      const second = fullText.charCodeAt(1);
      cut = (first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff) ? 2 : 1;
    }
    const text = fullText.slice(0, cut);
    if (fullText.length > maxCharsPerMessage) textTruncated = true;
    const content = nodeContent(node);
    const meta = collectSegmentMeta(content);
    return {
      index: index + 1,
      sender: senderName(node),
      userId: senderUserId(node),
      time: nodeTime(node),
      messageId: nodeMessageId(node),
      messageSeq: nodeMessageSeq(node),
      text,
      media: meta.media,
      nestedForwardIds: meta.nestedForwardIds
    };
  });
  return {
    total,
    truncated: truncatedByCount || textTruncated,
    textTruncated,
    messages
  };
}
