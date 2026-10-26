// QQ 文件消息：从 OneBot 消息段取文件、下载、判断能否按文本读出来。
//
// OneBot v11 的 file 段一般是：
//   { type: 'file', data: { file: 'a.txt', file_id: '...', busid: '102', file_size: '123' } }
// 有些实现还会带 url。下载要走 get_group_file_url / get_private_file_url 换临时链接。
const TEXT_EXTS = ['txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'yml', 'yaml', 'ini', 'conf', 'cfg', 'env', 'js', 'mjs', 'cjs', 'ts', 'py', 'html', 'htm', 'xml', 'sql', 'bat', 'cmd', 'ps1', 'sh', 'java', 'c', 'cpp', 'h', 'go', 'rs', 'toml', 'properties', 'srt', 'ass'];

export const FILE_MAX_BYTES = 2 * 1024 * 1024;
export const FILE_TEXT_MAX_CHARS = 8000;

export function isTextFile(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return Boolean(m && TEXT_EXTS.includes(m[1].toLowerCase()));
}

export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(0)} KB`;
  return `${v} B`;
}

export function extractFilesFromSegments(segments) {
  const out = [];
  for (const seg of Array.isArray(segments) ? segments : []) {
    if (!seg || seg.type !== 'file') continue;
    const d = seg.data || {};
    const name = String(d.file || d.name || d.file_name || '').trim();
    if (!name) continue;
    out.push({
      name,
      fileId: String(d.file_id || d.fileId || d.id || '').trim(),
      busid: String(d.busid ?? d.bus_id ?? '').trim(),
      size: Number(d.file_size ?? d.size ?? 0) || 0,
      url: String(d.url || '').trim()
    });
  }
  return out;
}

function decodeBuffer(buf) {
  // 先按严格 UTF-8；失败再试 GBK（QQ 群里 txt 经常是 GBK）；最后 latin1 兜底。
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {}
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch {}
  return new TextDecoder('latin1').decode(buf);
}

async function callOneBot(action, params, { httpUrl, accessToken, timeoutMs = 20000 }) {
  const res = await fetch(`${httpUrl}/${action}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {})
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
    throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}`);
  }
  return body.data || {};
}

/**
 * 取文件内容：先换链接再下载。
 * 返回 { name, size, text?, binary?, error? }，永远不抛（失败记在 error 里）。
 */
export async function readFileFromMessage({ kind, convId, file, httpUrl, accessToken, log = () => {} }) {
  const name = file?.name || '文件';
  try {
    let url = file?.url || '';
    if (!url) {
      const action = kind === 'group' ? 'get_group_file_url' : 'get_private_file_url';
      const params = kind === 'group'
        ? { group_id: Number(convId), file_id: file.fileId, busid: Number(file.busid) || 0 }
        : { user_id: Number(convId), file_id: file.fileId };
      const data = await callOneBot(action, params, { httpUrl, accessToken });
      url = String(data.url || data.file || '').trim();
    }
    if (!url) throw new Error('拿不到下载链接（file_id 可能已过期）');

    const res = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 qq-bridge' },
      redirect: 'follow',
      signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) throw new Error(`下载 HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > FILE_MAX_BYTES) {
      return { name, size: buf.length, error: `文件太大（${formatBytes(buf.length)}），超过 ${formatBytes(FILE_MAX_BYTES)} 不读` };
    }
    if (!isTextFile(name)) {
      return { name, size: buf.length, binary: true };
    }
    const raw = decodeBuffer(buf);
    const text = raw.length > FILE_TEXT_MAX_CHARS ? `${raw.slice(0, FILE_TEXT_MAX_CHARS)}\n…（只读了前 ${FILE_TEXT_MAX_CHARS} 字）` : raw;
    return { name, size: buf.length, text };
  } catch (error) {
    log(`[file] 读取 ${name} 失败：${String(error?.message ?? error).slice(0, 160)}`);
    return { name, size: Number(file?.size) || 0, error: String(error?.message ?? error).slice(0, 160) };
  }
}

/** 一次消息里可能带多个文件；最多读 2 个 */
export async function readFilesFromMessage({ kind, convId, files, httpUrl, accessToken, log, maxFiles = 2 }) {
  const list = Array.isArray(files) ? files.slice(0, maxFiles) : [];
  const out = [];
  for (const f of list) {
    out.push(await readFileFromMessage({ kind, convId, file: f, httpUrl, accessToken, log }));
  }
  return out;
}
