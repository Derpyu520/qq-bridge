// 合并转发消息（合并聊天记录）相关纯函数：
// - 从 OneBot 消息段中提取并清洗 forward id
// - 把 SnowLuma `get_forward_msg` 返回结果格式化为适合 AI 阅读的紧凑结构
// - 暴露每条消息里的图片/表情元数据与嵌套 forward id，供桥接/MCP 进一步读取
//
// 安全原则：
// - forward id 只允许安全字符，长度受限，避免把任意内容当参数传给 OneBot/日志
// - 只格式化，不访问网络；调用方负责“id 必须来自当前会话已见消息”的校验

export type MediaMeta =
  | { kind: 'image'; file?: string; url?: string }
  | { kind: 'face'; faceId: string };

export interface ForwardMessageView {
  index: number;
  sender: string;
  userId: string | null;
  time: number | null;
  messageId: string | null;
  messageSeq: string | null;
  text: string;
  media: MediaMeta[];
  nestedForwardIds: string[];
}

export interface FormatForwardOptions {
  maxMessages?: number;
  maxCharsPerMessage?: number;
}

type AnyRecord = Record<string, any>;

export function sanitizeForwardId(value: unknown): string {
  const s = String(value ?? '').trim();
  if (!s || s.length > 256) return '';
  // 仅用于 OneBot JSON 参数：允许常见 QQ 资源 id 字符，拒绝空白/控制字符。
  if (!/^[\w:.\-/=+@]+$/.test(s)) return '';
  return s;
}

// 从单个 forward 消息段 data 中取 id，供 segmentsToText 与 extractForwardIds 共用。
export function forwardIdFromData(data: unknown): string {
  const d: AnyRecord = data && typeof data === 'object' ? (data as AnyRecord) : {};
  return sanitizeForwardId(d?.id ?? d?.res_id ?? d?.file_id ?? d?.forward_id ?? '');
}

export function extractForwardIds(segments: unknown): string[] {
  if (!Array.isArray(segments)) return [];
  const out: string[] = [];
  for (const seg of segments) {
    if (!seg || typeof seg !== 'object' || (seg as AnyRecord).type !== 'forward') continue;
    const id = forwardIdFromData((seg as AnyRecord).data);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

function segmentText(seg: unknown): string {
  if (typeof seg === 'string') return seg;
  if (!seg || typeof seg !== 'object') return '';
  const d: AnyRecord = (seg as AnyRecord).data ?? {};
  const type = (seg as AnyRecord).type;
  switch (type) {
    case 'text':
      return String(d.text ?? '');
    case 'at':
      return d.qq === 'all' ? '@全体成员' : `@${d.qq ?? ''}`;
    case 'face':
      return `[表情${d.id ?? ''}]`;
    case 'image':
      return '[图片]';
    case 'record':
      return '[语音]';
    case 'video':
      return '[视频]';
    case 'file':
      return `[文件${d.name ?? ''}]`;
    case 'reply':
      return '[引用]';
    case 'forward':
      return '[转发]';
    case 'json':
      return '[卡片消息]';
    default:
      return `[${type ?? '未知'}]`;
  }
}

function sanitizeCqString(s: unknown): string {
  // 如果 get_forward_msg 返回的是 CQ 字符串，转为占位符，避免把 CQ 码原样塞给 AI。
  return String(s ?? '').replace(/\[CQ:[^\]]*\]/gi, '[媒体]');
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return sanitizeCqString(content);
  if (Array.isArray(content)) return sanitizeCqString(content.map(segmentText).join('').trim());
  if (content && typeof content === 'object') {
    const obj = content as AnyRecord;
    // 兼容单条 segment 对象（例如 { type:'text', data:{...} }）
    if (obj.type) return sanitizeCqString(segmentText(obj).trim());
    if (typeof obj.text === 'string') return sanitizeCqString(obj.text);
    if (Array.isArray(obj.content)) return sanitizeCqString(obj.content.map(segmentText).join('').trim());
  }
  return '';
}

export function nodeText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  // 标准 OneBot 转发节点：{ type:'node', data:{ name, uin, time, content } }
  const obj = node as AnyRecord;
  const data: AnyRecord = obj.data && typeof obj.data === 'object' ? obj.data : {};
  const topContent = obj.message ?? obj.content ?? obj.text;
  const dataContent = data.message ?? data.content ?? data.text;
  const text = contentToText(topContent) || contentToText(dataContent);
  return text;
}

function senderName(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const obj = node as AnyRecord;
  const data: AnyRecord = obj.data && typeof obj.data === 'object' ? obj.data : {};
  const sender = obj.sender;
  if (sender && typeof sender === 'object') {
    const name = (sender as AnyRecord).nickname || (sender as AnyRecord).card || (sender as AnyRecord).user_id || '';
    if (name) return String(name).slice(0, 100);
  }
  if (typeof sender === 'string' && sender) return String(sender).slice(0, 100);
  const name = data.name || data.nickname || data.card || data.uin || data.user_id || obj.name || obj.nickname || '';
  return String(name ?? '').slice(0, 100);
}

function senderUserId(node: unknown): string | null {
  if (!node || typeof node !== 'object') return null;
  const obj = node as AnyRecord;
  const data: AnyRecord = obj.data && typeof obj.data === 'object' ? obj.data : {};
  const sender = obj.sender;
  const uid =
    sender && typeof sender === 'object' ? (sender as AnyRecord).user_id : data.uin ?? data.user_id ?? obj.uin ?? obj.user_id;
  return uid != null ? String(uid) : null;
}

function nodeTime(node: unknown): number | null {
  if (!node || typeof node !== 'object') return null;
  const obj = node as AnyRecord;
  const data: AnyRecord = obj.data && typeof obj.data === 'object' ? obj.data : {};
  const t = obj.time ?? data.time;
  return t != null ? Number(t) : null;
}

function nodeMessageId(node: unknown): string | null {
  if (!node || typeof node !== 'object') return null;
  const obj = node as AnyRecord;
  const data: AnyRecord = obj.data && typeof obj.data === 'object' ? obj.data : {};
  const id = obj.message_id ?? obj.messageId ?? data.message_id ?? data.id ?? null;
  return id != null ? String(id) : null;
}

function nodeMessageSeq(node: unknown): string | null {
  if (!node || typeof node !== 'object') return null;
  const obj = node as AnyRecord;
  const data: AnyRecord = obj.data && typeof obj.data === 'object' ? obj.data : {};
  const seq = obj.message_seq ?? obj.messageSeq ?? data.message_seq ?? data.seq ?? null;
  return seq != null ? String(seq) : null;
}

function nodeContent(node: unknown): unknown[] {
  if (!node || typeof node !== 'object') return [];
  const obj = node as AnyRecord;
  const data: AnyRecord = obj.data && typeof obj.data === 'object' ? obj.data : {};
  const topContent = obj.message ?? obj.content ?? obj.text;
  const dataContent = data.message ?? data.content ?? data.text;
  const content = Array.isArray(topContent) ? topContent : Array.isArray(dataContent) ? dataContent : null;
  if (content) return content;
  // 字符串内容没有可提取的媒体/嵌套转发
  return [];
}

function segmentMedia(seg: unknown): MediaMeta | null {
  if (!seg || typeof seg !== 'object') return null;
  const d: AnyRecord = (seg as AnyRecord).data ?? {};
  const type = (seg as AnyRecord).type;
  if (type === 'image') {
    const file = String(d.file ?? d.file_id ?? d.filename ?? '');
    const url = String(d.url ?? d.src ?? '');
    if (file || url) return { kind: 'image', file: file || undefined, url: url || undefined };
  }
  if (type === 'face') {
    const faceId = String(d.id ?? d.face_id ?? '');
    if (faceId) return { kind: 'face', faceId };
  }
  return null;
}

function segmentNestedForwardId(seg: unknown): string | null {
  if (!seg || typeof seg !== 'object' || (seg as AnyRecord).type !== 'forward') return null;
  return forwardIdFromData((seg as AnyRecord).data);
}

// 从一段消息内容（数组）中提取图片/表情与嵌套转发 id。
function collectSegmentMeta(content: unknown): { media: MediaMeta[]; nestedForwardIds: string[] } {
  const media: MediaMeta[] = [];
  const nestedForwardIds: string[] = [];
  if (!Array.isArray(content)) return { media, nestedForwardIds };
  for (const seg of content) {
    const m = segmentMedia(seg);
    if (m) media.push(m);
    const nested = segmentNestedForwardId(seg);
    if (nested && !nestedForwardIds.includes(nested)) nestedForwardIds.push(nested);
  }
  return { media, nestedForwardIds };
}

export function formatForwardResponse(
  data: unknown,
  options: FormatForwardOptions = {},
): {
  total: number;
  truncated: boolean;
  textTruncated: boolean;
  messages: ForwardMessageView[];
} {
  const maxMessages = Math.max(1, Math.min(100, Number(options.maxMessages) || 50));
  const maxCharsPerMessage = Math.max(1, Math.min(2000, Number(options.maxCharsPerMessage) || 500));
  const obj = data && typeof data === 'object' ? (data as AnyRecord) : {};
  const raw = Array.isArray(data) ? data : Array.isArray(obj?.messages) ? obj.messages : [];
  const total = raw.length;
  const truncatedByCount = total > maxMessages;
  let textTruncated = false;
  const messages = raw.slice(0, maxMessages).map((node: unknown, index: number) => {
    const fullText = nodeText(node);
    const text = fullText.slice(0, maxCharsPerMessage);
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
      nestedForwardIds: meta.nestedForwardIds,
    };
  });
  return {
    total,
    truncated: truncatedByCount || textTruncated,
    textTruncated,
    messages,
  };
}
