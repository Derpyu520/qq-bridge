// NovelAI 生图客户端。
//
// 设计要点：
// - API key 只从 config.json 读（gitignored），任何时候都不写日志、不回显。
// - NovelAI 在境外，请求走 config.imageGen.proxy（默认本机 10808），用 https-proxy-agent 建 CONNECT 隧道。
// - 全局限速：同一进程内串行排队，两次请求至少间隔 minIntervalMs（默认 5s）。
// - 固定 prompt：basePrompt / negativePrompt 可手工改；最终 prompt = basePrompt + 用户描述。
// - 返回 Buffer（PNG）；落盘由调用方决定（桥接存 state/images/）。
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import zlib from 'node:zlib';
import { HttpsProxyAgent } from 'https-proxy-agent';

const DEFAULTS = {
  enabled: true,
  apiKey: '',
  model: 'nai-diffusion-5-curated',
  width: 1024,
  height: 1024,
  steps: 25,
  sampler: 'k_euler_ancestral',
  guidance: 7,
  basePrompt: '',
  negativePrompt: 'lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry',
  proxy: 'http://127.0.0.1:10808',
  minIntervalMs: 5000,
  timeoutMs: 120000,
  maxPerDay: 60,
  endpoint: 'https://image.novelai.net/ai/generate-image'
};

/** 从 zip 里取出第一张图片（NovelAI 的 generate-image 返回 zip） */
export function extractImageFromZip(buf) {
  if (!buf || buf.length < 8) return null;
  // 有些部署直接返回 PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return buf;
  let p = 0;
  while ((p = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), p)) !== -1) {
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    if (/\.(png|webp|jpe?g)$/i.test(name)) {
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      const data = buf.slice(start, start + compSize);
      return method === 0 ? data : zlib.inflateRawSync(data);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

export function createNovelAIClient({ getConfig, stateDir, log = () => {} }) {
  let busy = false;
  let lastAt = 0;
  let day = '';
  let dayCount = 0;

  const cfg = () => ({ ...DEFAULTS, ...(getConfig()?.imageGen ?? {}) });

  function today() {
    return new Date().toDateString();
  }

  function ensureQuota(c) {
    const d = today();
    if (d !== day) { day = d; dayCount = 0; }
    const max = Math.max(1, Number(c.maxPerDay) || 60);
    if (dayCount >= max) throw new Error(`今日生图已达上限（${max} 张），明天再来或者改 config.imageGen.maxPerDay`);
  }

  function composePrompt(userPrompt, extraNegative, c) {
    // 分段截断：basePrompt 是手工维护的画质/画风词，不能被用户描述挤掉；
    // 反过来用户描述也不能因为 basePrompt 太长被整段切掉。
    const base = String(c.basePrompt || '').trim().slice(0, 2000);
    const user = String(userPrompt || '').trim().slice(0, Math.max(200, 3000 - base.length));
    const prompt = [base, user].filter(Boolean).join(', ').slice(0, 3000);
    if (!prompt) throw new Error('prompt 不能为空');
    const neg = [String(c.negativePrompt || '').trim().slice(0, 2000), String(extraNegative || '').trim().slice(0, 1200)]
      .filter(Boolean).join(', ').slice(0, 2400);
    return { prompt, negative: neg };
  }

  function postJson(url, body, c) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const proxy = String(c.proxy || '').trim();
      const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;
      const payload = Buffer.from(JSON.stringify(body), 'utf8');
      const req = https.request({
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method: 'POST',
        agent,
        timeout: Math.max(10_000, Number(c.timeoutMs) || 120_000),
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${c.apiKey}`,
          'content-length': payload.length,
          'user-agent': 'qq-bridge/novelai'
        }
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('NovelAI 请求超时')));
      req.write(payload);
      req.end();
    });
  }

  /**
   * 生成一张图。返回 { buffer, prompt, negative, model, characters }。
   * 支持 NovelAI 的结构化 prompt：整图 base_caption + 逐角色 char_captions（可带中心点）。
   * 同一时刻只允许一张：上一张没完成时直接拒绝（不排队），两次之间仍至少间隔 minIntervalMs。
   */
  function generate({ prompt, negative, width, height, steps, sampler, guidance, model, seed, characters, scale, cfgRescale, uncondScale, noiseSchedule } = {}) {
    if (busy) return Promise.reject(new Error('上一张图还在生成，等它出来再要（同一时间只允许一张）'));
    busy = true;
    return (async () => {
      try {
        const c = cfg();
        if (c.enabled === false) throw new Error('生图功能已关闭（config.imageGen.enabled=false）');
      if (!String(c.apiKey || '').trim()) throw new Error('没有配置 NovelAI API key（config.imageGen.apiKey）');
      ensureQuota(c);
      const composed = composePrompt(prompt, negative, c);
      const w = Math.max(64, Math.min(2048, Number(width) || Number(c.width) || 1024));
      const h = Math.max(64, Math.min(2048, Number(height) || Number(c.height) || 1024));

      // 逐角色 caption：NovelAI v4/v5 用 char_captions + centers 控制「每个角色负责画面哪一部分」。
      // 之前全塞进 base_caption，多人场景容易互相污染（换色、串衣服）。
      const chars = (Array.isArray(characters) ? characters : [])
        .map((x) => {
          if (!x) return null;
          const caption = String(typeof x === 'string' ? x : (x.caption ?? x.prompt ?? '')).trim();
          if (!caption) return null;
          const cx = Number(x.center?.x ?? x.x);
          const cy = Number(x.center?.y ?? x.y);
          const hasCenter = Number.isFinite(cx) && Number.isFinite(cy);
          return {
            caption: caption.slice(0, 1500),
            negative: String(x.negative ?? '').trim().slice(0, 1200),
            center: hasCenter ? { x: Math.min(1, Math.max(0, cx)), y: Math.min(1, Math.max(0, cy)) } : null
          };
        })
        .filter(Boolean)
        .slice(0, 6);
      const useCoords = chars.some((x) => x.center);

      const params = {
        width: w,
        height: h,
        scale: Number(scale ?? guidance) || Number(c.guidance) || 7,
        uncond_scale: Number(uncondScale ?? c.uncondScale ?? 0) || 0,
        cfg_rescale: Number(cfgRescale ?? c.cfgRescale ?? 0) || 0,
        sampler: String(sampler || c.sampler || 'k_euler_ancestral'),
        steps: Math.max(1, Math.min(50, Number(steps) || Number(c.steps) || 25)),
        n_samples: 1,
        ucPreset: 0,
        qualityToggle: true,
        sm: false,
        sm_dyn: false,
        dynamic_thresholding: false,
        negative_prompt: composed.negative,
        // v4.5 / v5 走结构化 caption；旧版会忽略这些字段
        v4_prompt: {
          caption: {
            base_caption: composed.prompt,
            char_captions: chars.map((x) => (x.center
              ? { char_caption: x.caption, centers: [{ x: x.center.x, y: x.center.y }] }
              : { char_caption: x.caption }))
          },
          use_coords: useCoords,
          use_order: true,
          legacy_uc: false
        },
        v4_negative_prompt: {
          caption: {
            base_caption: composed.negative,
            char_captions: chars.map((x) => (x.center
              ? { char_caption: x.negative || '', centers: [{ x: x.center.x, y: x.center.y }] }
              : { char_caption: x.negative || '' }))
          },
          use_coords: useCoords,
          use_order: false,
          legacy_uc: false
        }
      };
      if (noiseSchedule || c.noiseSchedule) params.noise_schedule = String(noiseSchedule || c.noiseSchedule);
      if (Number.isFinite(Number(seed)) && Number(seed) > 0) params.seed = Number(seed);
      // 兼容老客户端：input 里也带角色描述，避免某些后端只读 input
      const legacyInput = chars.length
        ? `${composed.prompt}, ${chars.map((x) => x.caption).join(', ')}`
        : composed.prompt;
      const body = {
        input: legacyInput,
        model: String(model || c.model || DEFAULTS.model),
        action: 'generate',
        parameters: params
      };
      // 请求形态摘要：事后能确认「这次到底有没有走结构化 prompt / 用了哪些高级参数」。
      log(`[novelai] request model=${body.model} ${w}x${h} steps=${params.steps} sampler=${params.sampler} scale=${params.scale} cfg_rescale=${params.cfg_rescale} uncond=${params.uncond_scale} ns=${params.noise_schedule ?? '-'} chars=${chars.length} coords=${useCoords}`);
      const gap = Math.max(0, Number(c.minIntervalMs) || 5000) - (Date.now() - lastAt);
      if (gap > 0) await new Promise((r) => setTimeout(r, gap));
      lastAt = Date.now();
      ensureQuota(c);
      // 代理链路偶发 TLS/连接重置（实测过一次 "packet length too long"），这类错误重试一次基本就好；
      // HTTP 4xx/5xx 不重试（那是请求本身的问题，重试只会白烧一次额度）。
      let res = null;
      let lastError = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          res = await postJson(c.endpoint, body, c);
          if (res.status >= 500 && attempt === 0) {
            lastError = new Error(`NovelAI HTTP ${res.status}`);
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }
          break;
        } catch (error) {
          lastError = error;
          if (attempt === 0) {
            log(`[novelai] 网络错误，2 秒后重试一次：${String(error?.message ?? error).slice(0, 120)}`);
            await new Promise((r) => setTimeout(r, 2000));
          }
        }
      }
      if (!res) throw new Error(`NovelAI 连接失败（已重试一次）：${String(lastError?.message ?? lastError).slice(0, 160)}`);
      const text = res.body.length < 1024 ? res.body.toString('utf8').slice(0, 500) : '';
      if (res.status !== 201 && res.status !== 200) {
        throw new Error(`NovelAI HTTP ${res.status}: ${text || '（无正文）'}`);
      }
      const png = extractImageFromZip(res.body);
      if (!png) throw new Error(`NovelAI 返回里没有图片（${res.body.length} 字节，content-type=${res.headers['content-type']}）`);
      dayCount += 1;
      const dir = path.join(stateDir, 'images');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `nai-${Date.now()}.png`);
      fs.writeFileSync(file, png);
      // 元数据旁挂一份，方便事后查「这张图用的什么 prompt」——出图后模型和用户都记不住细节。
      try {
        fs.writeFileSync(file.replace(/\.png$/i, '.json'), `${JSON.stringify({
          createdAt: new Date().toISOString(),
          file: path.basename(file),
          model: body.model,
          width: w,
          height: h,
          steps: params.steps,
          sampler: params.sampler,
          guidance: params.scale,
          cfgRescale: params.cfg_rescale,
          uncondScale: params.uncond_scale,
          noiseSchedule: params.noise_schedule ?? null,
          prompt: composed.prompt,
          negative: composed.negative,
          characters: chars.map((x) => ({ caption: x.caption, negative: x.negative, center: x.center })),
          request: {
            model: body.model,
            use_coords: useCoords,
            char_captions: chars.length,
            cfg_rescale: params.cfg_rescale,
            uncond_scale: params.uncond_scale,
            noise_schedule: params.noise_schedule ?? null
          }
        }, null, 2)}\n`, 'utf8');
      } catch (error) {
        log(`[novelai] 元数据写盘失败：${error?.message ?? error}`);
      }
      // 只保留最近 300 张，避免 state 无限膨胀
      try {
        const files = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
        for (const f of files.slice(0, Math.max(0, files.length - 300))) fs.rmSync(path.join(dir, f), { force: true });
      } catch {}
        log(`[novelai] 生成完成 ${path.basename(file)} ${(png.length / 1024).toFixed(0)}KB model=${body.model} ${w}x${h} steps=${params.steps} chars=${chars.length}`);
        return { buffer: png, file, prompt: composed.prompt, negative: composed.negative, model: body.model, width: w, height: h, characters: chars };
      } finally {
        busy = false;
      }
    })();
  }

  return { generate, config: cfg, extractImageFromZip };
}
