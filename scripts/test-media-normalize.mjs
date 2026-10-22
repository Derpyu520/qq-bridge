// 媒体归一化（体积 + 动图抽帧）的离线回归。
//
// 背景（2026-10-18 审计，见 docs/audits/AUDIT_2026-10-18_MEDIA_AND_WATERMARK.md）：
//   1. DSH 的 MCP 图片入口用正则校验 base64，实测 base64 ≥ 4,474,880 字符（原始字节 ≈3.20 MiB）
//      必抛 RangeError: Maximum call stack size exceeded → 工具结果降级成
//      `[image unavailable: image/gif; Maximum call stack size exceeded; …]`。
//      而桥接的抓取上限默认 8 MiB ⇒ 3.2–8 MiB 的图「桥接认为合法、DSH 必然拒绝」。
//   2. DSH 对 image/gif 一律归一化成单帧（sharp 只解 page 0），模型永远只看第一帧且不知道是动图。
//
// 本文件验证：格式/帧数探测、决策纯函数、以及（有 ffmpeg 时）真实的抽帧拼图与降采样。
// 不访问网络；ffmpeg 缺失时只跑纯函数部分并明确打印 SKIP。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  MEDIA_DEFAULTS,
  describeImage,
  normalizeImageForModel,
  planAnimation,
  planNormalization,
  sniffImage
} from '../src/media-normalize.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
let skipped = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) {
    if (error?.skip) { skipped++; console.log('SKIP', name, '—', error.skip); return; }
    failures++; console.error('FAIL', name, '—', error?.stack ?? error);
  }
}
const skip = (why) => Object.assign(new Error(why), { skip: why });

// ── 固定夹具：手写的最小 GIF（1 帧 / 2 帧），不依赖 ffmpeg ──────────────────
// 注意 GCE 是 8 字节：21 F9 04 [packed] [delay 2] [tindex] [00 终结符]。
// 少写这个终结符会让子块链一路吞到下一个块，解析结果变成「0 帧」—— 手工夹具最容易踩的坑。
const GIF_HEAD = '47494638396101000100800000ffffff000000'; // GIF89a + 1×1 + 2 色 GCT
const GIF_FRAME = '21f9040100000000' + '2c0000000001000100000202440100'; // GCE + 图像描述符
const GIF_1 = Buffer.from(GIF_HEAD + GIF_FRAME + '3b', 'hex');
const GIF_2 = Buffer.from(GIF_HEAD + GIF_FRAME + GIF_FRAME + '3b', 'hex');
const PNG_1x1 = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001', 'hex');
// 审计 harness 的 FakeBot.getImage 固定回这一张 1×1 PNG（用于断言「原始字节没被重编码」）。
const FAKE_GATEWAY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=',
  'base64'
);

const hasFfmpeg = (() => {
  try { return spawnSync('ffmpeg', ['-v', 'error', '-version'], { stdio: 'ignore' }).status === 0; }
  catch { return false; }
})();

// ── 1. 格式/帧数探测（纯函数） ─────────────────────────────────────────────
await test('sniffImage 认出 PNG 并读取尺寸/透明通道', async () => {
  const info = sniffImage(PNG_1x1);
  assert.equal(info?.format, 'png');
  assert.equal(info.width, 1);
  assert.equal(info.height, 1);
  assert.equal(info.alpha, true);
  assert.equal(info.animated, false);
});

await test('sniffImage 数出 GIF 帧数（1 帧 / 2 帧）', async () => {
  assert.equal(sniffImage(GIF_1)?.frames, 1);
  assert.equal(sniffImage(GIF_1)?.animated, false);
  const two = sniffImage(GIF_2);
  assert.equal(two?.frames, 2, '两帧 GIF 必须数成 2 帧');
  assert.equal(two?.animated, true, '两帧 GIF 必须标记为动图');
  assert.equal(two?.format, 'gif');
});

await test('sniffImage 对未知/垃圾字节返回 null（不瞎猜）', async () => {
  assert.equal(sniffImage(Buffer.from('this is not an image at all')), null);
  assert.equal(sniffImage(Buffer.alloc(0)), null);
  // 只有 SOI 没有 SOF 的伪 JPEG：认不出尺寸 ⇒ null（调用方据此走「保守拒绝」分支）
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0, 0, 0, 0, 0, 0, 0, 0])), null);
});

await test('describeImage 摘要含帧数（日志与提示共用）', async () => {
  assert.match(describeImage(GIF_2), /动图 2 帧/);
  assert.match(describeImage(PNG_1x1), /png 1×1/);
});

// ── 2. 决策纯函数 ─────────────────────────────────────────────────────────
await test('planNormalization：小图原样放行（零额外延迟）', async () => {
  const info = { format: 'jpeg', width: 800, height: 600, frames: 1, durationMs: 0, animated: false, alpha: false };
  assert.equal(planNormalization(info, 120 * 1024, MEDIA_DEFAULTS), null);
});

await test('planNormalization：超字节或超长边 ⇒ shrink', async () => {
  const small = { format: 'jpeg', width: 800, height: 600, frames: 1, durationMs: 0, animated: false, alpha: false };
  assert.equal(planNormalization(small, 2 * 1024 * 1024, MEDIA_DEFAULTS)?.action, 'shrink');
  const big = { format: 'jpeg', width: 4000, height: 3000, frames: 1, durationMs: 0, animated: false, alpha: false };
  assert.equal(planNormalization(big, 300 * 1024, MEDIA_DEFAULTS)?.action, 'shrink', '长边超限也要压');
});

await test('planNormalization：动图 ⇒ animate（不论体积）', async () => {
  const info = { format: 'gif', width: 320, height: 300, frames: 48, durationMs: 4000, animated: true, alpha: true };
  assert.equal(planNormalization(info, 50 * 1024, MEDIA_DEFAULTS)?.action, 'animate');
});

await test('planNormalization：认不出格式且超大 ⇒ reject（不发注定被 DSH 丢掉的字节）', async () => {
  const plan = planNormalization(null, 4 * 1024 * 1024, MEDIA_DEFAULTS);
  assert.equal(plan?.action, 'reject');
});

await test('planNormalization：上限有硬顶（config 写再大也压到 DSH 炸栈线下沿）', async () => {
  const plan = planNormalization(null, 5 * 1024 * 1024, { maxModelBytes: 100 * 1024 * 1024 });
  assert.equal(plan?.action, 'reject');
  const huge = { format: 'jpeg', width: 9000, height: 9000, frames: 1, durationMs: 0, animated: false, alpha: false };
  assert.ok(planNormalization(huge, 9 * 1024 * 1024, { maxModelBytes: 100 * 1024 * 1024 }).maxBytes <= 3 * 1024 * 1024);
});

await test('planAnimation：48 帧/4s ⇒ 3×2、fps≈1.5', async () => {
  const layout = planAnimation({ frames: 48, durationMs: 4000 }, MEDIA_DEFAULTS);
  assert.equal(layout.cols, 3);
  assert.equal(layout.rows, 2);
  assert.equal(layout.sampleFrames, 6);
  assert.ok(Math.abs(layout.fps - 1.5) < 1e-6);
});

await test('planAnimation：帧数少于目标时全用（不填充垃圾格）', async () => {
  const layout = planAnimation({ frames: 3, durationMs: 300 }, MEDIA_DEFAULTS);
  assert.equal(layout.sampleFrames, 3);
  assert.equal(layout.cols * layout.rows, 3);
});

await test('planAnimation：时长未知时按每帧 100ms 估算（不会 fps=NaN）', async () => {
  const layout = planAnimation({ frames: 10, durationMs: 0 }, MEDIA_DEFAULTS);
  assert.ok(Number.isFinite(layout.fps) && layout.fps > 0, `fps=${layout.fps}`);
});

// ── 3. 主入口：不做多余的活 ────────────────────────────────────────────────
await test('normalizeImageForModel：小 PNG 原样返回（不 spawn ffmpeg、不改字节）', async () => {
  const out = await normalizeImageForModel(PNG_1x1, 'image/png', MEDIA_DEFAULTS);
  assert.equal(out.ok, true);
  assert.equal(out.buffer, PNG_1x1, '应当返回同一个 buffer 引用（零拷贝放行）');
  assert.equal(out.note, '');
});

await test('normalizeImageForModel：enabled=false 直接放行（应急开关）', async () => {
  const big = Buffer.concat([PNG_1x1, Buffer.alloc(2 * 1024 * 1024)]);
  const out = await normalizeImageForModel(big, 'image/png', { ...MEDIA_DEFAULTS, enabled: false });
  assert.equal(out.ok, true);
  assert.equal(out.buffer, big);
});

await test('normalizeImageForModel：压不动的垃圾字节 ⇒ ok:false 且给出原因', async () => {
  const junk = Buffer.alloc(4 * 1024 * 1024, 0x41); // 认不出格式 + 超过上限
  const out = await normalizeImageForModel(junk, 'image/jpeg', MEDIA_DEFAULTS);
  assert.equal(out.ok, false);
  assert.match(out.error, /上限|压不到/);
});

// ── 4. 真实 ffmpeg：抽帧拼图 / 降采样（没装 ffmpeg 就跳过） ─────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-media-test-'));
const ff = (args) => spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'ignore' });

await test('真实动图 → 抽帧拼图（单张 JPEG + 帧数说明）', async () => {
  if (!hasFfmpeg) throw skip('本机没有 ffmpeg');
  const gif = path.join(tmp, 'anim.gif');
  const made = ff(['-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=10:duration=1', '-vf',
    'split[a][b];[a]palettegen[p];[b][p]paletteuse', gif]);
  if (made.status !== 0) throw skip('ffmpeg 生成夹具失败');
  const src = fs.readFileSync(gif);
  const info = sniffImage(src);
  assert.ok(info.frames >= 8, `应当识别出多帧，实际 ${info.frames}`);

  const out = await normalizeImageForModel(src, 'image/gif', { ...MEDIA_DEFAULTS, tmpDir: tmp });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.mimeType, 'image/jpeg', '拼图必须是模型能吃的单帧 JPEG');
  assert.equal(sniffImage(out.buffer)?.frames, 1, '拼图结果不能再是动图');
  assert.match(out.note, /动图 \d+ 帧/);
  assert.match(out.note, /网格/);
  const strip = sniffImage(out.buffer);
  assert.ok(strip.width > 160, `拼图应当比单帧宽（${strip.width}）`);
  assert.ok(out.buffer.length <= MEDIA_DEFAULTS.maxModelBytes);
});

await test('真实大图（3000×2000）→ 降采样到长边上限以内', async () => {
  if (!hasFfmpeg) throw skip('本机没有 ffmpeg');
  const jpg = path.join(tmp, 'big.jpg');
  const made = ff(['-f', 'lavfi', '-i', 'testsrc2=size=3000x2000:rate=1:duration=1', '-frames:v', '1', '-q:v', '2', jpg]);
  if (made.status !== 0) throw skip('ffmpeg 生成夹具失败');
  const src = fs.readFileSync(jpg);
  assert.ok(src.length > 200 * 1024, `夹具应当够大（${src.length}）`);

  const out = await normalizeImageForModel(src, 'image/jpeg', { ...MEDIA_DEFAULTS, tmpDir: tmp });
  assert.equal(out.ok, true, out.error);
  assert.equal(out.mimeType, 'image/jpeg');
  const info = sniffImage(out.buffer);
  assert.ok(Math.max(info.width, info.height) <= MEDIA_DEFAULTS.maxLongEdge,
    `长边应 ≤ ${MEDIA_DEFAULTS.maxLongEdge}，实际 ${info.width}×${info.height}`);
  assert.ok(out.buffer.length <= MEDIA_DEFAULTS.maxModelBytes);
  assert.match(out.note, /→/);
});

await test('抽帧失败（ffmpeg 超时/不可用）也不崩：退回首帧 + 说明', async () => {
  // 注意：不能靠「把 ffmpegPath 指到不存在的文件」来模拟不可用 —— resolveFfmpeg 在候选路径
  // 都不存在时会回退到 PATH 里的 ffmpeg（这是语音功能就有的既定行为）。这里用 1ms 硬超时
  // 让调用必然失败，验证的是**失败路径的契约**：不抛异常、小图按原样提供、note 说清原因。
  const out = await normalizeImageForModel(GIF_2, 'image/gif', {
    ...MEDIA_DEFAULTS, tmpDir: tmp, timeoutMs: 1
  });
  assert.equal(out.ok, true);
  assert.equal(out.buffer, GIF_2, '压不动时小图按原样提供（不阻断对话）');
  assert.match(out.note, /只提供首帧/);
});

// ── 5. 桥接集成：出图出口会归一化，收藏表情仍拿原始字节 ────────────────────
await test('桥接 fetchMediaData 走归一化，且拿得到 mimeType/data', async () => {
  const h = await bridgeHarness();
  try {
    const out = await h.fetchMediaData([{ kind: 'image', file: 'fixture.png' }]);
    assert.equal(out.length, 1);
    assert.equal(out[0].mimeType, 'image/png');
    assert.ok(out[0].data && out[0].data.length > 0);
  } finally { await h.close(); }
});

await test('桥接 resolveMediaList（一代内联）同样出图', async () => {
  const h = await bridgeHarness();
  try {
    const parts = await h.resolveMediaList([{ kind: 'image', file: 'fixture.png' }]);
    const image = parts.find((p) => p.type === 'image');
    assert.ok(image, '应当产出一个 image part');
    assert.equal(image.mediaType, 'image/png');
  } finally { await h.close(); }
});

await test('fetchOneBotImage 仍返回**原始字节**（收藏表情不能被降采样/拼图）', async () => {
  const h = await bridgeHarness();
  try {
    const raw = await h.fetchOneBotImage({ kind: 'image', file: 'fixture.png' });
    assert.ok(raw?.buffer);
    // FakeBot.getImage 回的 1×1 PNG 原样返回：字节完全一致即证明没经过归一化重编码
    assert.equal(raw.buffer.length, FAKE_GATEWAY_PNG.length);
    assert.deepEqual(raw.buffer, FAKE_GATEWAY_PNG);
  } finally { await h.close(); }
});

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${failures ? 'FAILED' : 'ALL PASS'}  failures=${failures} skipped=${skipped}`);
if (failures) process.exit(1);
