// 只读 HTTP(S) 安全抓取工具：供 qq-bridge / MCP 共用。
// 设计目标与 mcp-web-search-safe 一致：
// - 仅 http/https
// - 禁止 localhost / .local / 私有 IP / 环回 / 链路本地 / CGNAT 等内网地址
// - 域名先 DNS 解析并检查全部解析结果，避免 DNS rebinding
// - 手动跟随重定向，每一跳重新校验
// - 响应体按字符数限量读取，避免超大响应拖垮进程
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { StringDecoder } from 'node:string_decoder';

const dnsLookup = dns.promises.lookup;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`操作超时(${ms}ms)：${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function ipv4FromLast32(lower) {
  const parts = String(lower || '').split(':');
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  const secondLast = parts[parts.length - 2];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(last)) return last;
  if (/^[0-9a-f]{1,4}$/.test(secondLast) && /^[0-9a-f]{1,4}$/.test(last)) {
    const num = (parseInt(secondLast, 16) << 16) + parseInt(last, 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

function parseEmbeddedIpv4(h) {
  const lower = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!lower.includes(':')) return null;
  const dotted = lower.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const m = lower.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (m) {
    const num = (parseInt(m[1], 16) << 16) + parseInt(m[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  // 兼容 ::ffff:0:7f00:1、::ffff:0:c0a8:101、::c0a8:101 等非规范 IPv4-mapped/compatible 写法。
  if (lower.startsWith('::ffff:') || lower.startsWith('::')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  // NAT64 前缀（64:ff9b::/96 与 64:ff9b:1::/48）内嵌 IPv4，例如 64:ff9b::c0a8:101 -> 192.168.1.1
  if (lower.startsWith('64:ff9b')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  const nat64 = lower.match(/^64:ff9b:(?:::)?(?:([0-9a-f]{1,4}):([0-9a-f]{1,4})|(\d+\.\d+\.\d+\.\d+))$/i);
  if (nat64) {
    if (nat64[3]) return nat64[3];
    const num = (parseInt(nat64[1], 16) << 16) + parseInt(nat64[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

export function isPrivateIp(ip) {
  const h = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  const embedded = h.includes(':') ? parseEmbeddedIpv4(h) : null;
  if (embedded) return isPrivateIp(embedded);

  if (net.isIP(h) === 4) {
    const parts = h.split('.').map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    if (parts[0] === 198 && parts[1] >= 18 && parts[1] <= 19) return true;
    if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true;
    if (parts[0] >= 224) return true;
    return false;
  }

  if (net.isIP(h) === 6) {
    if (h === '::' || h === '::1') return true;
    if (h.startsWith('fc') || h.startsWith('fd')) return true;
    if (/^fe[89ab]/.test(h)) return true;
    if (h.startsWith('fec') || h.startsWith('fed') || h.startsWith('fee') || h.startsWith('fef')) return true;
    if (h.startsWith('2001:db8')) return true;
    if (h.startsWith('2001:2:') || h.startsWith('2001:10:') || h.startsWith('2001:20:')) return true;
    const sixth4 = h.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/i);
    if (sixth4) {
      const num = (parseInt(sixth4[1], 16) << 16) + parseInt(sixth4[2], 16);
      const ipv4 = `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
      if (isPrivateIp(ipv4)) return true;
    }
    if (h.startsWith('ff')) return true;
    return false;
  }

  return false;
}

export async function resolveSafeHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) throw new Error('主机名为空');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) {
    throw new Error('禁止访问内网/本机地址');
  }
  if (net.isIP(h)) {
    if (isPrivateIp(h)) throw new Error('禁止访问内网/本机地址');
    return h;
  }
  let addresses;
  try {
    addresses = await withTimeout(dnsLookup(h, { all: true, verbatim: true }), 5000, `DNS 解析 ${h}`);
  } catch (error) {
    throw new Error(`域名解析失败：${error?.message ?? error}`);
  }
  if (!addresses.length) throw new Error('域名没有解析结果');
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new Error('域名解析到内网/本机地址，已阻止');
    }
  }
  return addresses[0].address;
}

export async function validateFetchUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error('URL 无效');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅允许 http/https');
  if (url.username || url.password) throw new Error('URL 不能包含凭据');
  const ip = await resolveSafeHost(url.hostname);
  return { url, ip };
}

function sliceByCodePoints(s, max) {
  if (s.length <= max) return s;
  return Array.from(s).slice(0, max).join('');
}

function readBoundedText(res, maxChars) {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8');
    let text = '';
    let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      fn(val);
    };
    res.on('data', (chunk) => {
      if (settled) return;
      text += decoder.write(chunk);
      if (text.length >= maxChars) {
        text = sliceByCodePoints(text, maxChars);
        try { res.destroy(); } catch {}
        finish(resolve, text);
      }
    });
    res.on('end', () => {
      if (!settled) {
        text += decoder.end();
        finish(resolve, sliceByCodePoints(text, maxChars));
      }
    });
    res.on('error', (err) => finish(reject, err));
  });
}

function requestOnce(url, ip, maxChars = 50000) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const port = url.port || (url.protocol === 'https:' ? 443 : 80);
    const req = mod.request({
      hostname: ip,
      port,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        host: url.host,
        'user-agent': 'Mozilla/5.0',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9',
      },
      servername: url.protocol === 'https:' ? url.hostname : undefined,
      rejectUnauthorized: url.protocol === 'https:',
      timeout: 20000,
    }, (res) => {
      const statusCode = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        res.resume();
        resolve({ statusCode, redirect: String(res.headers.location || '') });
        return;
      }
      readBoundedText(res, maxChars)
        .then((body) => resolve({ statusCode, body }))
        .catch(reject);
    });
    req.on('timeout', () => req.destroy(new Error(`请求超时：${url.hostname}`)));
    req.on('error', reject);
    req.end();
  });
}

export async function safeFetch(urlString, maxChars = 50000) {
  const MAX_REDIRECTS = 5;
  let { url, ip } = await validateFetchUrl(urlString);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const result = await requestOnce(url, ip, maxChars);
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      ({ url, ip } = await validateFetchUrl(next));
      continue;
    }
    const body = result.body || '';
    return {
      url: url.toString(),
      statusCode: result.statusCode,
      truncated: body.length >= maxChars,
      body,
    };
  }
  throw new Error('重定向次数过多，已停止');
}

/** 仅接受 DSH 支持的四种图片格式：PNG/JPEG/GIF/WebP。 */
export function looksLikeImageBuffer(buf) {
  if (!buf || buf.length < 12) return false;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return true;
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return true;
  return false;
}

/** 抓取图片字节并返回 Buffer（带 SSRF 防护，且校验确实为图片）。 */
export async function safeFetchBuffer(urlString, maxBytes = 4 * 1024 * 1024) {
  const MAX_REDIRECTS = 5;
  let { url, ip } = await validateFetchUrl(urlString);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const result = await requestOnceBuffer(url, ip, maxBytes);
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      ({ url, ip } = await validateFetchUrl(next));
      continue;
    }
    if (result.statusCode < 200 || result.statusCode >= 300) {
      throw new Error(`图片抓取失败：HTTP ${result.statusCode}`);
    }
    if (!looksLikeImageBuffer(result.buffer)) {
      throw new Error(`抓取内容不是有效图片（PNG/JPEG/GIF/WebP）`);
    }
    return { url: url.toString(), statusCode: result.statusCode, buffer: result.buffer };
  }
  throw new Error('重定向次数过多，已停止');
}

function requestOnceBuffer(url, ip, maxBytes) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const port = url.port || (url.protocol === 'https:' ? 443 : 80);
    const req = mod.request({
      hostname: ip,
      port,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        host: url.host,
        'user-agent': 'Mozilla/5.0',
        accept: 'image/*,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9',
      },
      servername: url.protocol === 'https:' ? url.hostname : undefined,
      rejectUnauthorized: url.protocol === 'https:',
      timeout: 20000,
    }, (res) => {
      const statusCode = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        res.resume();
        resolve({ statusCode, redirect: String(res.headers.location || '') });
        return;
      }
      const chunks = [];
      let size = 0;
      let settled = false;
      res.on('data', (chunk) => {
        if (settled) return;
        size += chunk.length;
        if (size > maxBytes) {
          settled = true;
          try { res.destroy(); } catch {}
          reject(new Error(`图片超过大小限制（${maxBytes} 字节）`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({ statusCode, buffer: Buffer.concat(chunks) });
      });
      res.on('error', (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      });
    });
    req.on('timeout', () => req.destroy(new Error(`请求超时：${url.hostname}`)));
    req.on('error', reject);
    req.end();
  });
}
