// TTS 适配层：把文字合成为语音库里的 mp3，交给现有的 sendVoiceForV2 发送。
//
// 供应商选择：Microsoft Edge Read Aloud（@andresaya/edge-tts）。
// 这是免费、无需 API key 的云端服务；Node 负责 HTTPS/WebSocket，绕过本机
// PowerShell/curl 在受限环境下的 schannel 问题。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EdgeTTS } from '@andresaya/edge-tts';

const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';
const DEFAULT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

/** 把 config.socialV2.voice.tts 归一化成可执行参数。 */
export function normalizeTtsConfig(raw = {}, root = process.cwd()) {
  const v = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: v.enabled === true,
    provider: String(v.provider ?? 'edge').toLowerCase(),
    voice: String(v.voice ?? DEFAULT_VOICE),
    rate: String(v.rate ?? '-5%'),
    pitch: String(v.pitch ?? '+0Hz'),
    maxChars: Number.isFinite(Number(v.maxChars)) && Number(v.maxChars) > 0
      ? Math.min(300, Math.floor(Number(v.maxChars)))
      : 80,
    timeoutMs: Number.isFinite(Number(v.timeoutMs)) && Number(v.timeoutMs) > 0
      ? Math.min(120000, Math.floor(Number(v.timeoutMs)))
      : 30000,
    cacheDir: path.resolve(root, String(v.cacheDir ?? 'audio/.tts-cache')),
    maxCacheFiles: Number.isFinite(Number(v.maxCacheFiles)) && Number(v.maxCacheFiles) >= 0
      ? Math.floor(Number(v.maxCacheFiles))
      : 120
  };
}

/** 去掉控制字符/多余空白，并做长度校验（不截断，避免语义被砍半）。 */
export function prepareTtsText(text, maxChars = 80) {
  const clean = String(text ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*([，。！？、；：])\s*/g, '$1')
    .replace(/(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, '')
    .trim();
  if (!clean) throw new Error('TTS 文本为空');
  const len = [...clean].length;
  if (len > maxChars) {
    throw new Error(`TTS 文本太长（${len} 字，上限 ${maxChars} 字）；请缩短或分条发送`);
  }
  return clean;
}

function pruneCache(dir, maxFiles) {
  if (!Number.isFinite(maxFiles) || maxFiles <= 0) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.mp3'))
      .map((e) => {
        const full = path.join(dir, e.name);
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(full).mtimeMs; } catch {}
        return { full, mtimeMs };
      });
  } catch {
    return;
  }
  if (entries.length <= maxFiles) return;
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const e of entries.slice(0, entries.length - maxFiles)) {
    try { fs.unlinkSync(e.full); } catch {}
  }
}

/**
 * 合成 TTS 到缓存文件。返回 { path, text, voice, cached, bytes }。
 * 同一段文字 + 音色 + 语速/音高会复用缓存，避免重复请求云端。
 */
export async function synthesizeTts(text, config, { root = process.cwd() } = {}) {
  const c = normalizeTtsConfig(config, root);
  if (!c.enabled) throw new Error('TTS 未开启（socialV2.voice.tts.enabled=false）');
  if (c.provider !== 'edge') throw new Error(`不支持的 TTS provider：${c.provider}（当前只支持 edge）`);

  const clean = prepareTtsText(text, c.maxChars);
  fs.mkdirSync(c.cacheDir, { recursive: true });
  const key = crypto.createHash('sha256')
    .update([clean, c.voice, c.rate, c.pitch].join('\u0000'))
    .digest('hex')
    .slice(0, 32);
  const base = path.join(c.cacheDir, key);
  const target = `${base}.mp3`;

  try {
    const st = fs.statSync(target);
    if (st.isFile() && st.size > 0) {
      return { path: target, text: clean, voice: c.voice, cached: true, bytes: st.size };
    }
  } catch {}

  const tts = new EdgeTTS({ timeout: c.timeoutMs });
  await tts.synthesize(clean, c.voice, {
    rate: c.rate,
    pitch: c.pitch,
    outputFormat: DEFAULT_FORMAT
  });
  const written = await tts.toFile(base);
  if (path.resolve(written) !== path.resolve(target)) {
    try { fs.renameSync(written, target); } catch {}
  }
  const st = fs.statSync(target);
  if (!st.size) throw new Error('TTS 返回了空音频');
  pruneCache(c.cacheDir, c.maxCacheFiles);
  return { path: target, text: clean, voice: c.voice, cached: false, bytes: st.size };
}
