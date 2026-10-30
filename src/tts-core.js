// TTS 合成（二代仿真模式）——外部 TTS 服务的调用、缓存与队列。
//
// 职责：
// - 按 socialV2.tts 配置调用外部 HTTP TTS（如 GPT-SoVITS api_v2、XiaoYu-TTS、
//   阿里云透传等任意「POST JSON → WAV/音频字节」服务）
// - 合成结果落盘到 state/tts-cache/，相同 (text, voice) 哈希直接复用
// - 串行队列：本地 CPU TTS 一次只能合成一条，后来的排队，不做并发
// - 只负责「文本 → 本地 wav 文件」；发送、白名单、限流、审计全部复用
//   voice-core / sendVoiceForV2 的既有链路，这里一行都不碰
//
// 设计原则（与 sticker-lib.js 同口径）：
// - 本模块不做任何本地命令执行、不接受本地路径输入，只发 HTTP 到配置的 baseUrl
// - baseUrl 只允许 http(s)，由 normalizeTtsCfg 校验；失败时抛错让上层降级为文字，
//   本模块自己不吞错

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 默认配置（config.json socialV2.tts 缺省时用这个） */
export function defaultTtsCfg() {
  return {
    enabled: false,            // 默认关闭：没配服务就别让 AI 调
    baseUrl: 'http://127.0.0.1:9880',
    endpoint: '/tts',          // POST {text, ref} → audio/wav
    voice: '',                 // TTS 服务里的参考音色名；空 = 服务端默认
    lang: 'zh',
    timeoutMs: 120000,         // CPU 合成慢，给足预算
    maxChars: 200,             // 超过直接拒绝（长文该走文字，不该硬读）
    cacheDir: 'state/tts-cache',
    cacheTtlMs: 24 * 60 * 60 * 1000,
    cacheMaxEntries: 200,
    maxPending: 4,              // 包含正在合成的请求；缓存命中不占队列
    maxPerMinute: 2,            // 所有入口共享的外部请求额度，失败也计费
    maxPerHour: 10,
    apiKeyEnv: ''               // 只存环境变量名，不在配置中保存服务密钥
  };
}

/** 校验并归一化 tts 配置。返回归一化后的对象；非法直接抛错（启动期暴露）。 */
export function normalizeTtsCfg(raw) {
  const cfg = { ...defaultTtsCfg(), ...(raw ?? {}) };
  let url;
  try { url = new URL(cfg.baseUrl); } catch { throw new Error('socialV2.tts.baseUrl 必须是 http(s) 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('socialV2.tts.baseUrl 必须是无凭据、查询参数和片段的 http(s) 地址');
  }
  if (typeof cfg.endpoint !== 'string' || !cfg.endpoint.startsWith('/') || cfg.endpoint.startsWith('//') || /[?#]/.test(cfg.endpoint)) {
    throw new Error('socialV2.tts.endpoint 必须以 / 开头');
  }
  if (!Number.isFinite(cfg.timeoutMs) || cfg.timeoutMs < 1000 || cfg.timeoutMs > 600000) {
    throw new Error('socialV2.tts.timeoutMs 必须在 1000-600000 之间');
  }
  if (!Number.isInteger(cfg.maxChars) || cfg.maxChars < 10 || cfg.maxChars > 1000) {
    throw new Error('socialV2.tts.maxChars 必须在 10-1000 之间');
  }
  for (const [key, min, max] of [
    ['maxPending', 1, 100], ['maxPerMinute', 0, 10000], ['maxPerHour', 0, 100000],
    ['cacheMaxEntries', 1, 10000], ['cacheTtlMs', 1, 30 * 86400000]
  ]) {
    if (!Number.isInteger(cfg[key]) || cfg[key] < min || cfg[key] > max) {
      throw new Error(`socialV2.tts.${key} 必须在 ${min}-${max} 之间`);
    }
  }
  if (typeof cfg.apiKeyEnv !== 'string' || (cfg.apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(cfg.apiKeyEnv))) {
    throw new Error('socialV2.tts.apiKeyEnv 必须是环境变量名');
  }
  cfg.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
  return cfg;
}

/** 缓存键：文本 + 音色 + 服务地址的哈希（配置变了缓存自动失效） */
function cacheKey(text, voice, baseUrl, endpoint) {
  return crypto.createHash('sha256')
    .update(`${baseUrl}\u0000${endpoint}\u0000${voice}\u0000${text}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * 单例合成器：队列 + 缓存 + TTL 清理。
 * 为什么单例：CPU TTS 并发只会互相拖慢并撑爆内存；串行是最稳的形态。
 */
export function createTtsSynthesizer(raw, { stateDir, fetchImpl = fetch, now = Date.now, env = process.env }) {
  const cfg = normalizeTtsCfg(raw);
  // cacheDir 配置是相对仓库根（state/tts-cache）；stateDir 是 .../state，
  // 所以从 stateDir 上一级（仓库根）resolve，保证落在仓库内而不是运行目录里。
  const cacheDir = path.resolve(stateDir, '..', cfg.cacheDir);
  fs.mkdirSync(cacheDir, { recursive: true });

  let queue = Promise.resolve();
  let inflight = 0;
  let peakQueue = 0;
  const pending = new Map();
  const requestTimes = [];
  const stats = { total: 0, cacheHits: 0, cacheMisses: 0, failures: 0 };

  /** 串行执行：同一时刻最多一个合成在跑 */
  function serialize(taskFn) {
    const run = queue.then(taskFn, taskFn);
    queue = run.catch(() => {});
    return run;
  }

  /** 清理过期缓存 + 控制条目数（惰性：每次 cacheMiss 时跑） */
  function pruneCache() {
    try {
      const entries = fs.readdirSync(cacheDir)
        .map((name) => {
          const p = path.join(cacheDir, name);
          const st = fs.statSync(p);
          return { p, mtime: st.mtimeMs, size: st.size };
        })
        .sort((a, b) => b.mtime - a.mtime);
      const stamp = now();
      for (const e of entries) {
        if (stamp - e.mtime >= cfg.cacheTtlMs || entries.indexOf(e) >= cfg.cacheMaxEntries) {
          fs.rmSync(e.p, { force: true });
        }
      }
    } catch {
      // 清理失败不影响主流程
    }
  }

  /**
   * 合成一段文本，返回 { wavPath, bytes, durationSec, cached, elapsedMs }。
   * 抛错时上层（bridge 路由）应降级为纯文字回复。
   */
  async function synthesize(text, { voice = cfg.voice } = {}) {
    if (cfg.enabled !== true) throw new Error('TTS 合成未启用');
    const clean = String(text ?? '').trim();
    if (!clean) throw new Error('TTS 文本为空');
    if (clean.length > cfg.maxChars) {
      throw new Error(`文本过长（${clean.length} 字 > maxChars=${cfg.maxChars}），请改用文字回复`);
    }
    const key = cacheKey(clean, voice, cfg.baseUrl, cfg.endpoint);
    const wavPath = path.join(cacheDir, `${key}.wav`);
    const cached = fs.existsSync(wavPath) ? fs.statSync(wavPath) : null;
    if (cached?.isFile() && cached.size >= 1000 && now() - cached.mtimeMs < cfg.cacheTtlMs) {
      stats.cacheHits++;
      const st = fs.statSync(wavPath);
      return Promise.resolve({ wavPath, bytes: st.size, cached: true, elapsedMs: 0 });
    }
    if (pending.has(key)) return pending.get(key);
    if (inflight >= cfg.maxPending) throw new Error('TTS 合成队列已满，请稍后重试');
    const stamp = now();
    while (requestTimes.length && stamp - requestTimes[0] >= 3600000) requestTimes.shift();
    if (requestTimes.filter(t => stamp - t < 60000).length >= cfg.maxPerMinute
      || requestTimes.length >= cfg.maxPerHour) throw new Error('TTS 合成调用额度已用完，请稍后重试');
    // 在排队之前占额，失败不返还：远端可能已经完成合成并计费。
    requestTimes.push(stamp);
    stats.cacheMisses++;
    inflight++;
    peakQueue = Math.max(peakQueue, inflight);
    const t0 = now();
    const run = serialize(async () => {
      try {
        const headers = { 'content-type': 'application/json' };
        if (cfg.apiKeyEnv) {
          const secret = env[cfg.apiKeyEnv];
          if (typeof secret !== 'string' || !secret.trim()) throw new Error('TTS 服务凭据环境变量未设置');
          headers.authorization = `Bearer ${secret.trim()}`;
        }
        const res = await fetchImpl(`${cfg.baseUrl}${cfg.endpoint}`, {
          method: 'POST',
          headers,
          redirect: 'error',
          body: JSON.stringify({ text: clean, ref: voice || undefined }),
          signal: AbortSignal.timeout(cfg.timeoutMs)
        });
        if (!res.ok) {
          throw new Error(`TTS 服务返回 ${res.status}`);
        }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 1000) throw new Error('TTS 服务返回的音频异常（过小），可能未合成成功');
        const tmp = `${wavPath}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, buf);
        fs.renameSync(tmp, wavPath);
        stats.total++;
        pruneCache();
        // WAV 16bit 单声道：字节 ÷ (sr*2) 估算时长；够用于日志与限流判断
        const sr = buf.readUInt32LE(24) || 32000;
        const durationSec = Math.round((buf.length - 44) / (sr * 2) * 10) / 10;
        return { wavPath, bytes: buf.length, cached: false, elapsedMs: now() - t0, durationSec };
      } catch (error) {
        stats.failures++;
        // 第三方错误可能包含 URL、鉴权头或服务内部路径，模型只接收固定错误。
        throw new Error('TTS 合成失败，请检查服务连接、凭据与返回的音频');
      } finally {
        inflight--;
        pending.delete(key);
      }
    });
    pending.set(key, run);
    return run;
  }

  return { synthesize, stats: () => ({ ...stats, inflight, peakQueue }) };
}
