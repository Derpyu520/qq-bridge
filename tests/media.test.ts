import { describe, it, expect } from 'vitest';
import {
  mimeFromBuffer,
  mimeFromUrl,
  getImageDimensions,
  base64FromMaybe,
  isProbablySafeImageFileRef,
} from '../src/media.js';

describe('mimeFromBuffer', () => {
  it('识别 PNG/JPEG/GIF/WebP', () => {
    expect(mimeFromBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('image/png');
    expect(mimeFromBuffer(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('image/jpeg');
    expect(mimeFromBuffer(Buffer.from('GIF89a\x00\x00\x00\x00\x00\x00'))).toBe('image/gif');
    expect(mimeFromBuffer(Buffer.from('RIFF\x00\x00\x00\x00WEBP'))).toBe('image/webp');
  });
  it('未知/空输入回退 jpeg', () => {
    expect(mimeFromBuffer(null)).toBe('image/jpeg');
    expect(mimeFromBuffer(Buffer.from('hello world'))).toBe('image/jpeg');
  });
});

describe('mimeFromUrl', () => {
  it('按扩展名识别', () => {
    expect(mimeFromUrl('https://x.com/a.png')).toBe('image/png');
    expect(mimeFromUrl('https://x.com/a.webp')).toBe('image/webp');
    expect(mimeFromUrl('https://x.com/a.gif')).toBe('image/gif');
    expect(mimeFromUrl('https://x.com/a.jpg')).toBe('image/jpeg');
  });
  it('无扩展名回退默认值', () => {
    expect(mimeFromUrl('https://x.com/a')).toBe('image/jpeg');
    expect(mimeFromUrl('bad-url', 'image/webp')).toBe('image/webp');
  });
});

describe('getImageDimensions', () => {
  it('解析 PNG 尺寸', () => {
    const buf = Buffer.alloc(24);
    buf.write('PNG', 1);
    buf[0] = 0x89;
    buf[1] = 0x50;
    buf[2] = 0x4e;
    buf[3] = 0x47;
    buf.writeUInt32BE(100, 16);
    buf.writeUInt32BE(50, 20);
    expect(getImageDimensions(buf)).toEqual({ width: 100, height: 50 });
  });
  it('解析 GIF 尺寸', () => {
    const full = Buffer.alloc(24);
    full.write('GIF89a', 0, 'ascii');
    full.writeUInt16LE(40, 6);
    full.writeUInt16LE(30, 8);
    expect(getImageDimensions(full)).toEqual({ width: 40, height: 30 });
  });
  it('无效输入返回 null', () => {
    expect(getImageDimensions(null)).toBeNull();
    expect(getImageDimensions(Buffer.alloc(3))).toBeNull();
  });
});

describe('base64FromMaybe', () => {
  it('解析 base64:// 前缀', () => {
    expect(base64FromMaybe('base64://aGVsbG8=')).toBe('aGVsbG8=');
  });
  it('解析 data:image 前缀', () => {
    expect(base64FromMaybe('data:image/png;base64,aGVsbG8=')).toBe('aGVsbG8=');
  });
  it('纯 base64 字符串', () => {
    expect(base64FromMaybe('aGVsbG8=')).toBe('aGVsbG8=');
  });
  it('非字符串/空返回 null', () => {
    expect(base64FromMaybe(null)).toBeNull();
    expect(base64FromMaybe('')).toBeNull();
  });
});

describe('isProbablySafeImageFileRef', () => {
  it('接受简单缓存文件名', () => {
    expect(isProbablySafeImageFileRef('abc_123.png')).toBe(true);
    expect(isProbablySafeImageFileRef('a-b.c.d')).toBe(true);
  });
  it('拒绝路径/盘符/协议/..', () => {
    expect(isProbablySafeImageFileRef('C:/x.png')).toBe(false);
    expect(isProbablySafeImageFileRef('a/b.png')).toBe(false);
    expect(isProbablySafeImageFileRef('a\\b.png')).toBe(false);
    expect(isProbablySafeImageFileRef('https://x.png')).toBe(false);
    expect(isProbablySafeImageFileRef('../x.png')).toBe(false);
    expect(isProbablySafeImageFileRef('')).toBe(false);
  });
});
