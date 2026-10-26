// src/media-dims.js 的单测：只读文件头，不解码像素。
//
// 为什么要测：图片炸弹（声明成几万×几万像素的 40 字节 PNG）能绕过「文件大小上限」，
// 唯一能拦的地方是先拿到 width/height。这段解析每种格式都有坑：
// PNG 是 BE、GIF 是 LE、JPEG 要走 SOF 段、WebP 有三种容器。
import assert from 'node:assert/strict';
import { getImageDimensions } from '../src/media-dims.js';

let failures = 0;
function test(name, run) {
  try { run(); console.log('PASS', name); }
  catch (error) { failures += 1; console.error('FAIL', name, '—', error?.stack ?? error); }
}

function png(width, height) {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function gif(width, height) {
  // 注意：解析入口要求 buf.length >= 24，GIF 头只有 13 字节，所以这里按真实文件长度给足。
  const buf = Buffer.alloc(30);
  buf.write('GIF89a', 0, 'ascii');
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

function jpeg(width, height) {
  // SOI + APP0（跳过用）+ SOF0
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.alloc(14)]);
  const sof0 = Buffer.alloc(19);
  sof0[0] = 0xff; sof0[1] = 0xc0;
  sof0.writeUInt16BE(17, 2);   // 段长
  sof0[4] = 8;                 // 精度
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0, Buffer.from([0xff, 0xd9])]);
}

function webpVP8X(width, height) {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'ascii');
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8X', 12, 'ascii');
  const w = width - 1; const h = height - 1;
  buf[24] = w & 0xff; buf[25] = (w >> 8) & 0xff; buf[26] = (w >> 16) & 0xff;
  buf[27] = h & 0xff; buf[28] = (h >> 8) & 0xff; buf[29] = (h >> 16) & 0xff;
  return buf;
}

test('PNG 读出宽高（大端）', () => {
  assert.deepEqual(getImageDimensions(png(1920, 1080)), { width: 1920, height: 1080 });
});

test('PNG 图片炸弹的尺寸照样能读到，不会返回 null', () => {
  const huge = getImageDimensions(png(60000, 60000));
  assert.deepEqual(huge, { width: 60000, height: 60000 }, '先读到尺寸，才谈得上拦');
});

test('GIF87a / GIF89a 读出宽高（小端）', () => {
  assert.deepEqual(getImageDimensions(gif(320, 240)), { width: 320, height: 240 });
  const gif87 = gif(16, 16);
  gif87.write('GIF87a', 0, 'ascii');
  assert.deepEqual(getImageDimensions(gif87), { width: 16, height: 16 });
});

test('JPEG 走 SOF 段拿到宽高', () => {
  assert.deepEqual(getImageDimensions(jpeg(800, 600)), { width: 800, height: 600 });
});

test('WebP VP8X 容器', () => {
  assert.deepEqual(getImageDimensions(webpVP8X(1024, 768)), { width: 1024, height: 768 });
});

test('认不出来的一律返回 null，绝不抛', () => {
  assert.equal(getImageDimensions(null), null);
  assert.equal(getImageDimensions(Buffer.alloc(0)), null);
  assert.equal(getImageDimensions(Buffer.alloc(10)), null, '太短直接 null');
  assert.equal(getImageDimensions(Buffer.from('这不是图片，只是普通文本内容占位'.repeat(4))), null);
});

test('截断的 PNG 不抛异常', () => {
  const half = png(100, 100).subarray(0, 12);
  assert.equal(getImageDimensions(half), null);
});

if (failures > 0) {
  console.log(`\n${failures} 项失败`);
  process.exit(1);
}
console.log('\n全部通过');