// tts.js — 调用 Breeze TTS 2（OpenAI 风格 /v1/audio/speech）把文本合成为语音文件。
//
// 设计要点：
//   1. **单并发**：远端一张卡一次只跑一条，桥接这边并发打过去只会排队甚至 409，
//      所以这里用一条 promise 链串行化，超时的请求直接放弃而不是堆积。
//   2. **落盘缓存**：按 sha1(text|instruction|cfg|seed|ref) 命名，命中直接返回。
//      常用句子（晚安、在吗）第二次就是 0 延迟，也不用反复烧 GPU。
//   3. **PCM 归一**：接口返回的是裸 s16le PCM 流（不是 wav），这里用 ffmpeg 转成
//      24kHz 单声道 wav 再交给现有语音发送链路（它只认语音库里的音频文件）。
//   4. **失败即抛**：调用方负责降级（发文字 / 回复“语音生成失败”），不在这里静默吞掉。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const DEFAULT_SAMPLE_RATE = 24000;
// 音频整形滤镜：手机端播放 QQ 语音时开头 20~50ms 常被吃掉，听感是第一个字被截断。
// 1) 前导静音裁到只剩 50ms；2) 补 150ms 干净引子；3) 首尾各 15ms 淡入淡出消爆音。
const AUDIO_FILTER = [
  'silenceremove=start_periods=1:start_duration=0:start_threshold=-45dB:start_silence=0.05',
  'adelay=150:all=1',
  'areverse',
  'afade=t=in:st=0:d=0.015',
  'areverse'
].join(',');

// edge-tts 产出的是 mp3（压缩输入）。实测 「silenceremove → areverse」 在压缩流上会把
// 整段音频削成静音（-91dB），因此这条链路不用反向：裁前导静音 + 补引子 + 响度归一到 -16 LUFS，
// 代价是少了尾部 15ms 淡出（可接受）。
const EDGE_AUDIO_FILTER = [
  'silenceremove=start_periods=1:start_duration=0:start_threshold=-45dB:start_silence=0.05',
  'adelay=150:all=1',
  'loudnorm=I=-16:TP=-1.5:LRA=11'
].join(',');

/** 跑一个外部命令，收集 stderr 便于报错（edge-tts / ffmpeg 共用）。 */
function runCommand(cmd, args, { timeoutMs = 120000, maxStderr = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      reject(error);
      return;
    }
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`${cmd} 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    child.stderr?.on('data', (d) => { stderr += d.toString(); if (stderr.length > maxStderr) stderr = stderr.slice(-maxStderr); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error?.code === 'ENOENT' ? new Error(`找不到可执行文件：${cmd}`) : error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${cmd} 退出码 ${code}${stderr ? `：${stderr.trim().split('\n').slice(-2).join(' | ')}` : ''}`));
    });
  });
}
// 音频整形版本：改了 ffmpeg 滤镜链就 +1，强制旧缓存失效（否则会一直放旧文件）
const FORMAT_VERSION = 2;

function runFfmpeg(ffmpeg, args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      reject(error);
      return;
    }
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`ffmpeg 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    child.stderr?.on('data', (d) => { stderr += d.toString(); if (stderr.length > 4000) stderr = stderr.slice(-4000); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 退出码 ${code}${stderr ? `：${stderr.trim().split('\n').slice(-2).join(' | ')}` : ''}`));
    });
  });
}

function sha1(s) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
}

/**
 * @param {object} opts
 * @param {() => object} opts.readCfg 每次调用现读配置（config.json 改了不用重启）
 * @param {string} opts.cacheDir      wav 缓存目录
 * @param {(m: string) => void} [opts.log]
 */
export function createTts({ readCfg, cacheDir, log = () => {} }) {
  let chain = Promise.resolve();
  let probePromise = null;

  function cfgNow() {
    const t = readCfg() ?? {};
    return {
      enabled: t.enabled !== false,
      baseUrl: String(t.baseUrl || 'http://127.0.0.1:7860').replace(/\/+$/, ''),
      timeoutMs: Number(t.timeoutMs) > 0 ? Number(t.timeoutMs) : 90000,
      sampleRate: Number(t.sampleRate) > 0 ? Number(t.sampleRate) : DEFAULT_SAMPLE_RATE,
      cfgScale: Number(t.defaultCfgScale) > 0 ? Number(t.defaultCfgScale) : 4,
      seed: Number.isFinite(Number(t.defaultSeed)) ? Number(t.defaultSeed) : 42,
      instruction: String(t.defaultInstruction ?? ''),
      maxChars: Number(t.maxChars) > 0 ? Number(t.maxChars) : 200,
      maxCacheFiles: Number(t.maxCacheFiles) > 0 ? Number(t.maxCacheFiles) : 300,
      // 后端选择：'breeze'（OpenAI 风格 HTTP）/ 'edge'（微软 Edge 朗读，免费）/ 'qwen'（阿里云百炼 Qwen3-TTS）
      provider: String(t.provider || 'breeze').toLowerCase(),
      // qwen（DashScope 百炼）
      qwenBaseUrl: String(t.qwenBaseUrl || 'https://dashscope.aliyuncs.com').replace(/\/+$/, ''),
      qwenApiKey: String(t.qwenApiKey || process.env.DASHSCOPE_API_KEY || ''),
      qwenModel: String(t.qwenModel || 'qwen3-tts-flash'),
      qwenVoice: String(t.qwenVoice || 'Cherry'),
      qwenInstructions: String(t.qwenInstructions || ''),
      // 语速倍率（1.0 = 原速，0.88 = 慢 12%）。用 ffmpeg atempo 实现：只改节奏，不改音高。
      // 接口本身没有 speed 参数，靠 instructions 写「语速放慢」实测不稳定，所以放在本地做确定性变速。
      qwenSpeed: Number.isFinite(Number(t.qwenSpeed)) && Number(t.qwenSpeed) > 0 ? Number(t.qwenSpeed) : 1,
      // qwen 失败时是否自动回退到 edge（有配 edgeCli 才生效）
      edgeFallback: t.edgeFallback !== false,
      edgeCli: String(t.edgeCli || process.env.EDGE_TTS_PATH || 'edge-tts'),
      edgeVoice: String(t.edgeVoice || 'zh-CN-XiaoyiNeural'),
      edgeRate: String(t.edgeRate || ''),      // 形如 '+10%' / '-5%'，空 = 默认
      edgePitch: String(t.edgePitch || ''),    // 形如 '+20Hz'
      edgeVolume: String(t.edgeVolume || ''),
      ffmpegPath: t.ffmpegPath || process.env.FFMPEG_PATH || null,
      refAudio: t.refAudio ? path.resolve(String(t.refAudio)) : null,
      refText: String(t.refText ?? '')
    };
  }

  /** 探一次 /health 拿采样率（服务端会明确返回 sample_rate），失败就退回配置值。 */
  async function sampleRateOf(c) {
    if (!probePromise) {
      probePromise = (async () => {
        try {
          const res = await fetch(`${c.baseUrl}/health`, { signal: AbortSignal.timeout(8000) });
          if (!res.ok) return c.sampleRate;
          const j = await res.json();
          return Number(j?.sample_rate) > 0 ? Number(j.sample_rate) : c.sampleRate;
        } catch {
          return c.sampleRate;
        }
      })();
      // 失败结果不要永久缓存：下一次调用重试
      probePromise.catch(() => { probePromise = null; });
    }
    return probePromise;
  }

  function pruneCache(c) {
    try {
      const dir = cacheDir;
      if (!fs.existsSync(dir)) return;
      const files = fs.readdirSync(dir)
        .filter((f) => f.endsWith('.wav'))
        .map((f) => {
          const full = path.join(dir, f);
          try { const st = fs.statSync(full); return { full, mtimeMs: st.mtimeMs }; } catch { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const f of files.slice(c.maxCacheFiles)) {
        try { fs.unlinkSync(f.full); } catch {}
      }
    } catch (error) {
      log(`[tts] 清理缓存失败：${error?.message ?? error}`);
    }
  }

  async function synthesizeOnce({ text, instruction, cfgScale, seed, refAudio, refText }) {
    const c = cfgNow();
    if (!c.enabled) throw new Error('TTS 未启用（config.tts.enabled=false）');
    const clean = String(text ?? '').replace(/[\r\n\t]+/g, ' ').trim();
    if (!clean) throw new Error('text 不能为空');
    if ([...clean].length > c.maxChars) {
      throw new Error(`文本过长（${[...clean].length} 字），上限 ${c.maxChars} 字`);
    }

    // refAudio 显式传 none/off/- 时表示“这次不要参考音”，用于纯 instruction 设计新音色；
    // 不传（undefined）才回退到配置里的默认参考音。
    const NO_REF = new Set(['none', 'off', '-']);
    const picked = refAudio === undefined
      ? c.refAudio
      : (NO_REF.has(String(refAudio).trim().toLowerCase()) ? null : refAudio);
    const useRef = picked ? path.resolve(picked) : null;
    const useRefText = String(refText ?? c.refText ?? '');
    if (useRef && !fs.existsSync(useRef)) throw new Error(`参考音频不存在：${useRef}`);

    const backendTag = c.provider === 'edge'
      ? ['edge', c.edgeVoice, c.edgeRate, c.edgePitch, c.edgeVolume]
      : (c.provider === 'qwen'
        ? ['qwen', c.qwenModel, c.qwenVoice, c.qwenInstructions, c.qwenSpeed]
        : ['breeze', c.baseUrl]);
    const digest = sha1(JSON.stringify([FORMAT_VERSION, ...backendTag, clean, instruction ?? c.instruction, cfgScale ?? c.cfgScale, seed ?? c.seed, useRef ?? '', useRefText]));
    fs.mkdirSync(cacheDir, { recursive: true });
    const wavPath = path.join(cacheDir, `tts_${digest}.wav`);
    if (fs.existsSync(wavPath) && fs.statSync(wavPath).size > 1024) {
      return { path: wavPath, cached: true, text: clean };
    }

    // ── 免费后端：edge-tts（微软 Edge 朗读，无 key、无额度） ────────────────────
    // 产出 mp3 后走与 Breeze 相同的 ffmpeg 整形链，保证各后端的听感一致
    // （同样的前导静音处理，手机端不会削掉第一个字）。
    const synthesizeWithEdge = async () => {
      const started = Date.now();
      const tmpMp3 = path.join(cacheDir, `tts_${digest}.mp3`);
      const args = ['--voice', c.edgeVoice, '--text', clean, '--write-media', tmpMp3];
      if (c.edgeRate) args.push('--rate', c.edgeRate);
      if (c.edgePitch) args.push('--pitch', c.edgePitch);
      if (c.edgeVolume) args.push('--volume', c.edgeVolume);
      // edge-tts 走的是微软的朗读接口，偶发 403/连接重置/返回空文件。这类是瞬时故障，
      // 直接重试一次基本都能过；两次都失败才向上抛，让调用方降级成纯文字。
      let lastErr = null;
      let ok = false;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          await runCommand(c.edgeCli, args, { timeoutMs: c.timeoutMs });
          if (fs.existsSync(tmpMp3) && fs.statSync(tmpMp3).size > 512) { ok = true; break; }
          lastErr = new Error('返回的音频为空');
        } catch (error) {
          lastErr = error;
        }
        try { fs.unlinkSync(tmpMp3); } catch {}
        if (attempt === 1) await new Promise((r) => setTimeout(r, 800));
      }
      if (!ok) {
        throw new Error(`edge-tts 合成失败（已重试）：${lastErr?.message ?? lastErr}`);
      }
      if (!fs.existsSync(tmpMp3) || fs.statSync(tmpMp3).size < 512) {
        throw new Error('edge-tts 没有产出音频（检查 edgeCli 路径）');
      }
      const ffmpegEdge = c.ffmpegPath || 'ffmpeg';
      try {
        await runFfmpeg(ffmpegEdge, [
          '-y', '-loglevel', 'error',
          '-i', tmpMp3,
          '-af', EDGE_AUDIO_FILTER,
          '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le',
          wavPath
        ], { timeoutMs: c.timeoutMs });
      } catch (error) {
        throw new Error(`音频整形失败：${error?.message ?? error}`);
      } finally {
        try { fs.unlinkSync(tmpMp3); } catch {}
      }
      if (!fs.existsSync(wavPath) || fs.statSync(wavPath).size < 1024) {
        throw new Error('edge-tts 合成结果为空');
      }
      log(`[tts] edge 合成完成 ${clean.slice(0, 24)}${clean.length > 24 ? '…' : ''}（${Date.now() - started}ms）`);
      pruneCache(c);
      return { path: wavPath, cached: false, text: clean, elapsedMs: Date.now() - started, provider: 'edge' };
    };

    if (c.provider === 'edge') return synthesizeWithEdge();

    // ── 阿里云百炼 Qwen3-TTS ────────────────────────────────────────────────────
    // 注意：不是 OpenAI 兼容的 /audio/speech（那个 404），而是原生 multimodal-generation，
    // 返回体里给的是**带签名的 wav 链接**，要自己下载回来。
    if (c.provider === 'qwen') {
      if (!c.qwenApiKey) throw new Error('未配置 tts.qwenApiKey（或环境变量 DASHSCOPE_API_KEY）');
      const started = Date.now();
      const tmpWav = path.join(cacheDir, `tts_${digest}_qwen.wav`);
      // 单次调用的 instruction 优先（AI 可以按场景传“用兴奋的语气说”），否则用配置里的默认指令
      const styleInstr = String(instruction ?? '').trim() || c.qwenInstructions;
      const payload = {
        model: c.qwenModel,
        input: { text: clean, voice: c.qwenVoice }
      };
      if (styleInstr) payload.input.instructions = styleInstr;

      let lastErr = null;
      let ok = false;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const res = await fetch(`${c.qwenBaseUrl}/api/v1/services/aigc/multimodal-generation/generation`, {
            method: 'POST',
            headers: { authorization: `Bearer ${c.qwenApiKey}`, 'content-type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(c.timeoutMs)
          });
          if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`DashScope ${res.status}${body ? `：${body.slice(0, 200)}` : ''}`);
          }
          const json = await res.json();
          const url = json?.output?.audio?.url;
          if (!url) throw new Error(`返回里没有音频地址：${JSON.stringify(json).slice(0, 200)}`);
          const audioRes = await fetch(url, { signal: AbortSignal.timeout(c.timeoutMs) });
          if (!audioRes.ok) throw new Error(`下载音频失败 ${audioRes.status}`);
          const buf = Buffer.from(await audioRes.arrayBuffer());
          if (buf.length < 2048) throw new Error(`音频数据过短（${buf.length} 字节）`);
          fs.writeFileSync(tmpWav, buf);
          ok = true;
          break;
        } catch (error) {
          lastErr = error;
          if (attempt === 1) await new Promise((r) => setTimeout(r, 800));
        }
      }

      if (!ok) {
        // 兜底：qwen 失败时退回免费 edge，保证「不会哑火」
        if (c.edgeFallback && c.edgeCli) {
          log(`[tts] qwen 失败，回退 edge：${lastErr?.message ?? lastErr}`);
          return synthesizeWithEdge();
        }
        throw new Error(`qwen-tts 合成失败（已重试）：${lastErr?.message ?? lastErr}`);
      }

      const ffmpegQwen = c.ffmpegPath || 'ffmpeg';
      // 变速必须在整形链之前：先拉长时长，再裁静音/补引子/归一响度，
      // 否则引子会被一起拉长、响度包络也会不均匀。
      const qwenFilter = c.qwenSpeed !== 1
        ? `atempo=${c.qwenSpeed.toFixed(4)},${EDGE_AUDIO_FILTER}`
        : EDGE_AUDIO_FILTER;
      try {
        await runFfmpeg(ffmpegQwen, [
          '-y', '-loglevel', 'error',
          '-i', tmpWav,
          '-af', qwenFilter,
          '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le',
          wavPath
        ], { timeoutMs: c.timeoutMs });
      } catch (error) {
        throw new Error(`音频整形失败：${error?.message ?? error}`);
      } finally {
        try { fs.unlinkSync(tmpWav); } catch {}
      }
      if (!fs.existsSync(wavPath) || fs.statSync(wavPath).size < 1024) {
        throw new Error('qwen-tts 合成结果为空');
      }
      log(`[tts] qwen 合成完成 ${clean.slice(0, 24)}${clean.length > 24 ? '…' : ''}（${Date.now() - started}ms）`);
      pruneCache(c);
      return { path: wavPath, cached: false, text: clean, elapsedMs: Date.now() - started, provider: 'qwen' };
    }

    const sr = await sampleRateOf(c);
    const form = new FormData();
    form.set('text', clean);
    const instr = String(instruction ?? c.instruction ?? '').trim();
    if (instr) form.set('instruction', instr);
    form.set('cfg_scale', String(cfgScale ?? c.cfgScale));
    form.set('seed', String(seed ?? c.seed));
    if (useRef) {
      const buf = fs.readFileSync(useRef);
      form.set('ref_audio', new Blob([buf], { type: 'audio/wav' }), path.basename(useRef));
      if (useRefText) form.set('ref_text', useRefText);
    }

    const started = Date.now();
    let res;
    try {
      res = await fetch(`${c.baseUrl}/v1/audio/speech`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(c.timeoutMs)
      });
    } catch (error) {
      throw new Error(`连不上 TTS 服务（${c.baseUrl}）：${error?.message ?? error}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`TTS 返回 ${res.status}${body ? `：${body.slice(0, 200)}` : ''}`);
    }
    const pcm = Buffer.from(await res.arrayBuffer());
    if (pcm.length < 2048) throw new Error(`TTS 返回数据过短（${pcm.length} 字节）`);

    const tmpPcm = path.join(cacheDir, `tts_${digest}.pcm`);
    fs.writeFileSync(tmpPcm, pcm);
    const ffmpeg = c.ffmpegPath || 'ffmpeg';
    try {
      // 手机端 QQ 播语音时，开头 20~50ms 常被播放器/编码器“吃掉”，听感就是第一个字被截断。
      // 处理策略：
      //   1. silenceremove 只保留 50ms 前导静音（TTS 有时会在前面留 400ms 空白，显得呆）；
      //   2. adelay 补 150ms 干净引子，给解码器留出起播时间，第一个字不会被削；
      //   3. 首尾各加 15ms 淡入/淡出，去掉爆音（原文件首样本峰值能到 0.33）。
      const audioFilter = AUDIO_FILTER;
      await runFfmpeg(ffmpeg, [
        '-y', '-loglevel', 'error',
        '-f', 's16le', '-ar', String(sr), '-ac', '1',
        '-i', tmpPcm,
        '-af', audioFilter,
        '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le',
        wavPath
      ], { timeoutMs: c.timeoutMs });
    } catch (error) {
      throw new Error(`PCM 转 wav 失败：${error?.message ?? error}`);
    } finally {
      try { fs.unlinkSync(tmpPcm); } catch {}
    }
    if (!fs.existsSync(wavPath) || fs.statSync(wavPath).size < 1024) {
      throw new Error('TTS 合成结果为空');
    }
    log(`[tts] 合成完成 ${clean.slice(0, 24)}${clean.length > 24 ? '…' : ''}（${Date.now() - started}ms）`);
    pruneCache(c);
    return { path: wavPath, cached: false, text: clean, elapsedMs: Date.now() - started };
  }

  /** 串行化：远端单并发，这里排队，避免互相打断或撞 409。 */
  function synthesize(args) {
    const task = chain.then(() => synthesizeOnce(args));
    // 失败不能卡住队列
    chain = task.then(() => undefined, () => undefined);
    return task;
  }

  return { synthesize, cfgNow };
}
