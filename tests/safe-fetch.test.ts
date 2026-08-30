import { describe, it, expect } from 'vitest';
import { isPrivateIp, looksLikeImageBuffer, validateFetchUrl } from '../src/safe-fetch.js';

describe('isPrivateIp', () => {
  it.each([
    '10.0.0.1',
    '127.0.0.1',
    '192.168.1.1',
    '172.16.0.1',
    '169.254.0.1',
    '100.64.0.1',
    '0.0.0.0',
    '198.18.0.1',
    '224.0.0.1',
    '::1',
    'fc00::1',
    'fd00::1',
    'fe80::1',
  ])('私有/保留地址判定为内网: %s', (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '114.114.114.114',
    '1.1.1.1',
    '2001:4860:4860::8888',
  ])('公网地址判定为非内网: %s', (ip) => {
    expect(isPrivateIp(ip)).toBe(false);
  });

  it('IPv4-mapped IPv6 内嵌私有 IPv4 判定为内网', () => {
    expect(isPrivateIp('::ffff:192.168.1.1')).toBe(true);
    expect(isPrivateIp('::ffff:7f00:1')).toBe(true);
  });
});

describe('looksLikeImageBuffer', () => {
  it('识别 PNG/JPEG/GIF/WebP 魔数', () => {
    expect(looksLikeImageBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(true);
    expect(looksLikeImageBuffer(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(true);
    expect(looksLikeImageBuffer(Buffer.from('GIF89a\x00\x00\x00\x00\x00\x00'))).toBe(true);
    expect(looksLikeImageBuffer(Buffer.from('RIFF\x00\x00\x00\x00WEBP'))).toBe(true);
  });
  it('非图片返回 false', () => {
    expect(looksLikeImageBuffer(Buffer.from('hello world'))).toBe(false);
    expect(looksLikeImageBuffer(null)).toBe(false);
  });
});

describe('validateFetchUrl', () => {
  it('拒绝本机地址', async () => {
    await expect(validateFetchUrl('http://127.0.0.1/')).rejects.toThrow(/内网|本机/);
  });
  it('拒绝内网地址', async () => {
    await expect(validateFetchUrl('http://192.168.1.1/')).rejects.toThrow(/内网|本机/);
  });
  it('拒绝非 http(s) 协议', async () => {
    await expect(validateFetchUrl('ftp://example.com/')).rejects.toThrow(/http\/https/);
  });
  it('拒绝带凭据的 URL', async () => {
    await expect(validateFetchUrl('http://user:pass@example.com/')).rejects.toThrow(/凭据/);
  });
});
