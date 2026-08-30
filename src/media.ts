// 图片/表情相关的纯函数：魔数识别、尺寸解析、安全路径/文件名校验、媒体限量常量。
import fs from 'node:fs';
import path from 'node:path';

export const MAX_MEDIA_COUNT = 5;
export const MAX_MEDIA_BYTES = 4 * 1024 * 1024;
export const MAX_MEDIA_PIXELS = 64_000_000;
export const MAX_MEDIA_STORE_PER_KEY = 500;

export function mimeFromBuffer(buf: Buffer | null | undefined): string {
  if (!buf || buf.length < 12) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
  return 'image/jpeg';
}

export function mimeFromUrl(url: unknown, fallback = 'image/jpeg'): string {
  try {
    const pathname = new URL(String(url)).pathname.toLowerCase();
    if (pathname.endsWith('.png')) return 'image/png';
    if (pathname.endsWith('.webp')) return 'image/webp';
    if (pathname.endsWith('.gif')) return 'image/gif';
    if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
  } catch {}
  return fallback;
}

export function getImageDimensions(buf: Buffer | null | undefined): { width: number; height: number } | null {
  if (!buf || buf.length < 24) return null;
  try {
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
      let offset = 2;
      while (offset + 9 < buf.length) {
        if (buf[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = buf[offset + 1];
        if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
          offset += 2;
          continue;
        }
        const len = buf.readUInt16BE(offset + 2);
        if (len < 2) return null;
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
        }
        offset += 2 + len;
      }
    }
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const fourcc = buf.toString('ascii', 12, 16);
      if (fourcc === 'VP8X' && buf.length >= 30) {
        const width = 1 + buf[24] + (buf[25] << 8) + (buf[26] << 16);
        const height = 1 + buf[27] + (buf[28] << 8) + (buf[29] << 16);
        return { width, height };
      }
      if (fourcc === 'VP8L' && buf.length >= 25) {
        const bits = [buf[21], buf[22], buf[23], buf[24]];
        const width = 1 + (((bits[1] & 0x3f) << 8) | bits[0]);
        const height = 1 + (((bits[3] & 0x0f) << 10) | (bits[2] << 2) | ((bits[1] & 0xc0) >> 6));
        return { width, height };
      }
      if (fourcc === 'VP8 ' && buf.length >= 30) {
        const width = buf.readUInt16LE(26) & 0x3fff;
        const height = buf.readUInt16LE(28) & 0x3fff;
        return { width, height };
      }
    }
  } catch {}
  return null;
}

export function base64FromMaybe(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  if (s.startsWith('base64://')) return s.slice('base64://'.length).replace(/\s/g, '');
  if (s.startsWith('data:image/')) {
    const idx = s.indexOf(',');
    if (idx >= 0) return s.slice(idx + 1).replace(/\s/g, '');
  }
  if (/^[A-Za-z0-9+/=\s]+$/.test(s)) return s.replace(/\s/g, '');
  return null;
}

// OneBot 图片 file 字段只应接受简单缓存文件名；拒绝路径、URL、盘符、协议前缀等。
export function isProbablySafeImageFileRef(file: unknown): boolean {
  const s = String(file ?? '').trim();
  if (!s || s.length > 512) return false;
  if (/[\u0000-\u001f\u007f]/.test(s)) return false;
  if (/[\\/]/.test(s)) return false;
  if (/^[a-zA-Z]:/.test(s)) return false;
  if (/^(file|https?|base64|data):/i.test(s)) return false;
  if (s.includes('..')) return false;
  return /^[\w.+=@-]+$/.test(s);
}

// 校验本地图片路径必须位于 SnowLuma 安装目录内，防止任意文件读取。
export function isSafeLocalMediaPath(homeDir: unknown, filePath: unknown): boolean {
  try {
    const real = fs.realpathSync(String(filePath));
    const home = homeDir ? String(homeDir) : null;
    if (!home) return false;
    const realHome = fs.realpathSync(home);
    return real === realHome || real.startsWith(realHome + path.sep);
  } catch {
    return false;
  }
}
