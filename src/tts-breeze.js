// Breeze TTS 2 客户端（https://github.com/breezeblue-ai/breeze-tts）
//
// 上游服务：`python -m breeze_infer.api <model> --host 127.0.0.1 --port 7860`
// 接口契约（见仓库 README「Streaming API」）：
//   POST /v1/audio/speech   multipart：text / instruction / cfg_scale / seed / ref_audio / ref_text
//   响应体 = 单声道 24kHz signed-16-bit little-endian PCM 流（不是 wav，不带头）
//   GET  /v1/model          {"frame_rate":12.5,"model_digest":"...","max_new_tokens":1500,...}
//
// 本模块只做两件事：把文本发过去、把 PCM 写成 QQ 能吃的 WAV。发不发由桥接决定。
import fs from 'node:fs';
import path from 'node:path';

export const BREEZE_SAMPLE_RATE = 24000;
export const BREEZE_CHANNELS = 1;
export const BREEZE_BITS = 16;

/** 把裸 PCM(s16le mono 24k) 包成 WAV 文件。 */
export function pcmToWav(pcm, filePath) {
  const bytes = pcm.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + bytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(BREEZE_CHANNELS, 22);
  header.writeUInt32LE(BREEZE_SAMPLE_RATE, 24);
  header.writeUInt32LE(BREEZE_SAMPLE_RATE * BREEZE_CHANNELS * (BREEZE_BITS / 8), 28); // byte rate
  header.writeUInt16LE(BREEZE_CHANNELS * (BREEZE_BITS / 8), 32); // block align
  header.writeUInt16LE(BREEZE_BITS, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(bytes, 40);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.concat([header, pcm]));
  return { bytes: bytes + 44, seconds: bytes / (BREEZE_SAMPLE_RATE * BREEZE_CHANNELS * (BREEZE_BITS / 8)) };
}

function trimBase(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '');
}

/** 探活：GET /v1/model。返回 { ok, info } 或 { ok:false, error }（不抛）。 */
export async function breezeHealth({ baseUrl, timeoutMs = 5000 } = {}) {
  const url = `${trimBase(baseUrl)}/v1/model`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 160)}` };
    let info = null;
    try { info = JSON.parse(text); } catch { /* 非 JSON 也算可达 */ }
    return { ok: true, info, raw: text.slice(0, 300) };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/**
 * 合成一段语音到 WAV。
 * 音频参数（refAudio + refText 同时给）→ 克隆音色；只给 instruction → 声音设计/指令引导。
 * 注意上游是单并发：并发请求会收到 409。
 */
export async function breezeTtsToWav({
  baseUrl,
  text,
  instruction = '',
  refAudio = '',
  refText = '',
  cfgScale = 1.0,
  seed = 42,
  timeoutMs = 180000,
  outPath,
} = {}) {
  const clean = String(text ?? '').trim();
  if (!clean) throw new Error('文本为空');
  if (!outPath) throw new Error('缺少输出路径');
  const form = new FormData();
  form.set('text', clean);
  if (instruction) form.set('instruction', String(instruction));
  if (Number.isFinite(Number(cfgScale)) && Number(cfgScale) > 0) form.set('cfg_scale', String(Number(cfgScale)));
  if (Number.isFinite(Number(seed))) form.set('seed', String(Math.trunc(Number(seed))));
  if (refAudio && refText) {
    const buf = fs.readFileSync(refAudio);
    form.set('ref_audio', new Blob([buf], { type: 'audio/wav' }), path.basename(refAudio));
    form.set('ref_text', String(refText));
  }

  const started = Date.now();
  const res = await fetch(`${trimBase(baseUrl)}/v1/audio/speech`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 180000)),
  });
  const ctype = String(res.headers.get('content-type') || '');
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const hint = res.status === 409 ? '（上游是单并发，正在合成别的请求）' : '';
    throw new Error(`Breeze TTS 返回 HTTP ${res.status}${hint}：${detail.slice(0, 200)}`);
  }
  if (ctype.includes('application/json')) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Breeze TTS 返回 JSON 而不是音频：${detail.slice(0, 200)}`);
  }
  const pcm = Buffer.from(await res.arrayBuffer());
  if (!pcm.length) throw new Error('Breeze TTS 返回空音频');
  if (pcm.length % 2 !== 0) throw new Error(`Breeze TTS 返回的 PCM 字节数不是 16bit 对齐（${pcm.length}）`);
  const wav = pcmToWav(pcm, outPath);
  return {
    ok: true,
    path: outPath,
    bytes: wav.bytes,
    seconds: wav.seconds,
    elapsedMs: Date.now() - started,
    rtf: wav.seconds > 0 ? (Date.now() - started) / 1000 / wav.seconds : null,
  };
}
