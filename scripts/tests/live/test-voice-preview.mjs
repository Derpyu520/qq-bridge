// 图形界面音量端点验证（live）：/api/preview 必须真的按音量产出不同音频。
// 需要 GUI 已在运行：node voice-gui.mjs --no-open --port 3215
//   $env:QQ_BRIDGE_TEST_LIVE="1"; node scripts/tests/live/test-voice-preview.mjs --port=3215
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
let pass = 0;
let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail += 1; console.error(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};

/** 解析 WAV 的 PCM，算 RMS（dBFS）——与 test-voice-volume 同法，不依赖 ffmpeg 统计 */
function wavRms(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') fmt = { bits: buf.readUInt16LE(body + 14) };
    else if (id === 'data') { data = buf.subarray(body, Math.min(body + size, buf.length)); break; }
    offset = body + size + (size % 2);
  }
  if (!fmt || !data || fmt.bits !== 16) return null;
  const n = Math.floor(data.length / 2);
  if (!n) return null;
  let sum = 0;
  for (let i = 0; i < n; i++) { const v = data.readInt16LE(i * 2) / 32768; sum += v * v; }
  const rms = Math.sqrt(sum / n);
  return rms === 0 ? -Infinity : 20 * Math.log10(rms);
}

if (process.env.QQ_BRIDGE_TEST_LIVE !== '1') {
  console.log('## 跳过：设 QQ_BRIDGE_TEST_LIVE=1 且 GUI 已启动');
  console.log(`\n结果：0 通过，0 失败`);
  process.exit(0);
}

const portArg = process.argv.find((a) => a.startsWith('--port='));
const port = Number(portArg ? portArg.split('=')[1] : 3215);
const base = `http://127.0.0.1:${port}`;
const token = (() => {
  // GUI 现在住在 voice-tool/，令牌地址文件写在那边；旧位置也兼容找一下。
  for (const f of [
    path.resolve(ROOT, '..', 'voice-tool', 'state', 'voice-gui-url.txt'),
    path.join(ROOT, 'state', 'voice-gui-url.txt')
  ]) {
    try {
      const m = (fs.readFileSync(f, 'utf8').match(/[?&]t=([\w-]+)/) || [])[1];
      if (m) return m;
    } catch {}
  }
  return '';
})();

console.log('## /api/preview 音量端点');
if (!token) {
  ok(false, `取不到令牌（GUI 是否在 ${port} 运行？）`);
} else {
  const headers = { 'x-voice-token': token };
  const boot = await fetch(`${base}/api/bootstrap`, { headers }).then((r) => r.json());
  const voice = boot.library?.items?.find((v) => v.ok !== false && /\.wav$/i.test(v.name))
    ?? boot.library?.items?.find((v) => v.ok !== false);
  ok(Boolean(voice), '语音库里有可用音频', voice?.name ?? '');

  if (voice) {
    const get = async (qs) => {
      const res = await fetch(`${base}/api/preview?t=${encodeURIComponent(token)}&name=${encodeURIComponent(voice.name)}${qs}`);
      if (!res.ok) return { status: res.status, json: await res.json().catch(() => ({})) };
      return { status: res.status, buf: Buffer.from(await res.arrayBuffer()), processing: decodeURIComponent(res.headers.get('x-audio-processing') || '') };
    };

    const plain = await get('');
    const loud = await get('&volume=3');
    const quiet = await get('&volume=0.5');
    ok(plain.status === 200 && plain.buf?.length > 0, '原样预览可下载', `${plain.buf?.length ?? 0} B · ${plain.processing || '(无处理头)'}`);
    ok(loud.status === 200, '音量 3 倍预览可下载', loud.processing);
    ok(/300%/.test(loud.processing || ''), '响应头标明 300%', loud.processing);

    const rPlain = plain.buf ? wavRms(plain.buf) : null;
    const rLoud = wavRms(loud.buf ?? Buffer.alloc(0));
    const rQuiet = wavRms(quiet.buf ?? Buffer.alloc(0));
    if (rPlain === null || rLoud === null || rQuiet === null) {
      console.log('  ⏭  跳过 RMS 比对：预览输出不是 16-bit WAV PCM');
    } else {
      ok(Math.abs((rLoud - rPlain) - 9.54) < 2.5, `3 倍预览实测 +${(rLoud - rPlain).toFixed(2)} dB`, `${rPlain.toFixed(2)} → ${rLoud.toFixed(2)} dBFS`);
      ok(Math.abs((rQuiet - rPlain) + 6.02) < 2.5, `0.5 倍预览实测 ${(rQuiet - rPlain).toFixed(2)} dB`, `${rPlain.toFixed(2)} → ${rQuiet.toFixed(2)} dBFS`);
    }

    const smart = await get('&normalize=1');
    ok(smart.status === 200 && /响度归一/.test(smart.processing || ''), '智能音量预览可用', smart.processing);

    const bad = await get('&volume=99');
    ok(bad.status === 400, '越界音量返回 400', `HTTP ${bad.status}`);

    // 预览产物是一次性的：不该在临时目录里堆着
    const tmpDir = path.join(process.env.TEMP || '/tmp', 'voice-processed');
    const left = fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir).filter((f) => f.startsWith('vol-')).length : 0;
    ok(left === 0, '预览产生的临时文件已清理', `残留 ${left} 个`);
  }
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
