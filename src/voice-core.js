// 语音发送的共享内核：独立工具（上级 voice-tool/ 的 voice-cli.mjs / voice-gui.mjs）与桥接都用同一套规则。
//
// 这里的函数是**纯工具**（无全局副作用、不读 config 单例），调用方把配置传进来：
//   - voice-cli.mjs / voice-gui.mjs（在 ../voice-tool/）：直连 SnowLuma，
//     经 `../qq-bridge/src/voice-core.js` 引本文件（唯一实现，不复制）；配置读 voice-tool/config.json
//   - src/bridge.js：自己管白名单/限流/审计，但音频解析与 ffprobe 探测复用这里
//
// 关键设计：ffprobe 结果**写临时文件**而不是走 stdout 管道。
// 在受限沙箱（DSH workspace-write / 只读模式）里 spawn 一个 stdio:pipe 的子进程会直接
// EPERM，而"继承 stdio + 写文件"是允许的。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** 网关能直接吃进去的音频扩展名（SnowLuma 会自动转 SILK）。 */
export const AUDIO_EXTS = [
  '.mp3', '.wav', '.ogg', '.oga', '.opus', '.m4a', '.aac', '.flac',
  '.amr', '.silk', '.slk', '.wma', '.spx'
];

/** 已经是 QQ 原生 SILK 的扩展名：跳过探测。 */
const SILK_EXTS = new Set(['.silk', '.slk']);

export const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
export const DEFAULT_MAX_SECONDS = 300;

export function isAudioFile(file) {
  return AUDIO_EXTS.includes(path.extname(String(file)).toLowerCase());
}

export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(2)} MB`;
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}分${String(r).padStart(2, '0')}秒` : `${r}秒`;
}

/** 递归列出语音库里的音频（按相对路径排序，结果稳定）。 */
export function listAudioFiles(dir, { maxDepth = 4 } = {}) {
  const out = [];
  const walk = (cur, depth) => {
    if (depth > maxDepth) return;
    let entries = [];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(cur, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile() && isAudioFile(e.name)) out.push(full);
    }
  };
  walk(path.resolve(dir), 0);
  return out.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

/**
 * 解析「音频来源」为用户实际想指的那个文件。
 *
 * 顺序：绝对路径/file:// → 相对 cwd → 语音库同名路径 → 补扩展名 → 语音库 basename 模糊匹配。
 * 返回 { path, via, candidates }（找不到时 path=null，candidates 是模糊候选）。
 */
export function resolveAudioSource(input, { voiceDir = null, cwd = process.cwd() } = {}) {
  const raw = String(input ?? '').trim();
  if (!raw) return { path: null, via: 'empty', candidates: [] };
  const stat = (p) => { try { return fs.statSync(p); } catch { return null; } };

  const cands = [];
  const add = (p, via) => {
    if (!p) return;
    const abs = path.resolve(p);
    if (!cands.some((c) => c.path === abs)) cands.push({ path: abs, via });
  };

  if (/^file:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      let p = decodeURIComponent(u.pathname);
      if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
      add(p, 'file-url');
    } catch {}
  } else if (path.isAbsolute(raw) || raw.startsWith('~')) {
    add(raw.startsWith('~') ? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', raw.slice(1)) : raw, 'absolute');
  } else {
    add(path.resolve(cwd, raw), 'cwd');
  }
  const dir = voiceDir ? path.resolve(voiceDir) : null;
  if (dir && !path.isAbsolute(raw) && !/^file:\/\//i.test(raw)) add(path.join(dir, raw), 'voice-dir');

  for (const c of cands) {
    const st = stat(c.path);
    if (st?.isFile()) return { path: c.path, via: c.via, candidates: [], size: st.size };
  }
  if (!path.extname(raw)) {
    for (const c of cands) {
      for (const ext of AUDIO_EXTS) {
        const st = stat(c.path + ext);
        if (st?.isFile()) return { path: c.path + ext, via: `${c.via}+ext`, candidates: [], size: st.size };
      }
    }
  }
  const fuzzy = [];
  if (dir) {
    const want = path.basename(raw).toLowerCase();
    const wantNoExt = want.replace(/\.[^.]+$/, '');
    for (const f of listAudioFiles(dir)) {
      const base = path.basename(f).toLowerCase();
      if (base === want || base.replace(/\.[^.]+$/, '') === wantNoExt) fuzzy.push({ path: f, via: 'voice-dir-fuzzy' });
    }
  }
  return { path: null, via: 'not-found', candidates: fuzzy };
}

/**
 * 安全解析「语音库内的相对路径」→ 绝对路径（拒绝路径穿越与符号链接逃逸）。
 * GUI 的上传/删除/播放接口都必须走这里。
 */
export function safeJoinLibrary(voiceDir, relPath) {
  const root = path.resolve(voiceDir);
  const rel = String(relPath ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel || rel.includes('\0')) return null;
  const abs = path.resolve(root, rel);
  const within = abs === root || abs.startsWith(root + path.sep);
  if (!within) return null;
  // 新文件也必须校验已有的父目录。realpath(abs) 的 ENOENT 不能作为放行依据：
  // 库内 junction 指向库外时，尚不存在的输出文件同样会 ENOENT。
  const resolveExistingParent = (file) => {
    const missing = [];
    let current = file;
    for (;;) {
      try { return path.join(fs.realpathSync(current), ...missing.reverse()); } catch (error) {
        if (error?.code !== 'ENOENT') return null;
        // dangling symlink 自身存在但目标不存在，不能当成普通的新文件路径。
        try { fs.lstatSync(current); return null; } catch (statError) {
          if (statError?.code !== 'ENOENT') return null;
        }
        const parent = path.dirname(current);
        if (parent === current) return null;
        missing.push(path.basename(current));
        current = parent;
      }
    }
  };
  const realRoot = resolveExistingParent(root);
  const real = resolveExistingParent(abs);
  if (realRoot === null || real === null) return null;
  const relative = path.relative(realRoot, real);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) return null;
  return real;
}

/**
 * ffprobe 探测（时长/编码/sampleRate/channels）。
 * 结果写临时文件回传，stdout/stderr 一律 ignore（受限沙箱下 pipe 会 EPERM）。
 */
export async function probeAudio(file, { ffprobePath = 'ffprobe', timeoutMs = 10000, tmpDir = null } = {}) {
  const dirs = [tmpDir, path.join(os.tmpdir(), 'voice-probe')].filter(Boolean);
  let dir = null;
  for (const d of dirs) {
    try { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); dir = d; break; } catch {}
  }
  if (!dir) return { ok: false, reason: '没有可写的临时目录用于 ffprobe 输出' };

  const outFile = path.join(dir, `p-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  const run = () => new Promise((resolve) => {
    let child;
    try {
      child = spawn(ffprobePath, [
        '-v', 'error',
        '-show_entries', 'format=duration,format_name',
        '-show_entries', 'stream=codec_name,codec_type,sample_rate,channels',
        '-of', 'json', '-o', outFile, file
      ], { windowsHide: true, stdio: 'ignore' });
    } catch (error) {
      resolve({ code: -1, error: `ffprobe 启动失败：${error?.message ?? error}` });
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve({ code: -2, error: 'ffprobe 超时' }); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, error: `ffprobe 不可用：${e.message}` }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code }); });
  });

  try {
    const res = await run();
    if (res.error) return { ok: false, reason: res.error };
    let raw = '';
    try { raw = fs.readFileSync(outFile, 'utf8'); }
    catch (error) { return { ok: false, reason: `ffprobe 未产出结果（退出码 ${res.code}，${error?.message ?? error}）` }; }
    if (!raw.trim()) return { ok: false, reason: `ffprobe 结果为空（退出码 ${res.code}）` };
    const j = JSON.parse(raw);
    const streams = Array.isArray(j.streams) ? j.streams : [];
    const audio = streams.find((s) => s.codec_type === 'audio');
    return {
      ok: true,
      duration: Number(j.format?.duration) || 0,
      formatName: j.format?.format_name ?? '',
      codec: audio?.codec_name ?? '',
      sampleRate: Number(audio?.sample_rate) || 0,
      channels: Number(audio?.channels) || 0
    };
  } catch (error) {
    return { ok: false, reason: `ffprobe 输出解析失败：${error?.message ?? error}` };
  } finally {
    try { fs.unlinkSync(outFile); } catch {}
  }
}

/** 校验音频是否适合当 QQ 语音发。返回 { ok, size, duration, codec, warnings[], error }。 */
export async function inspectAudio(file, {
  maxBytes = DEFAULT_MAX_BYTES,
  maxSeconds = DEFAULT_MAX_SECONDS,
  ffprobePath = process.env.FFPROBE_PATH || 'ffprobe'
} = {}) {
  const warnings = [];
  let st;
  try { st = fs.statSync(file); } catch (error) { return { ok: false, error: `文件不存在或不可读：${error?.message ?? error}` }; }
  if (!st.isFile()) return { ok: false, error: '不是文件（目录？）' };
  if (st.size === 0) return { ok: false, error: '文件为空' };
  if (st.size > maxBytes) return { ok: false, size: st.size, error: `文件过大（${formatBytes(st.size)} > 上限 ${formatBytes(maxBytes)}）` };
  if (!isAudioFile(file)) warnings.push(`扩展名 ${path.extname(file) || '(无)'} 不在常见音频列表内，将交给网关自行识别`);

  if (SILK_EXTS.has(path.extname(file).toLowerCase())) {
    return { ok: true, size: st.size, duration: null, codec: 'silk', formatName: 'silk', warnings };
  }
  const p = await probeAudio(file, { ffprobePath });
  if (!p.ok) {
    warnings.push(`无法探测时长（${p.reason}）：将不做时长校验，直接交给网关`);
    return { ok: true, size: st.size, duration: null, codec: '', formatName: '', warnings };
  }
  if (p.duration > maxSeconds) {
    return { ok: false, size: st.size, duration: p.duration, codec: p.codec, error: `时长 ${formatDuration(p.duration)} 超过上限 ${formatDuration(maxSeconds)}` };
  }
  if (p.duration > 60) warnings.push(`时长 ${formatDuration(p.duration)} 较长，QQ 会显示为长语音`);
  if (!p.codec) warnings.push('没找到音频流，网关转码可能失败');
  return {
    ok: true, size: st.size, duration: p.duration, codec: p.codec,
    formatName: p.formatName, sampleRate: p.sampleRate, channels: p.channels, warnings
  };
}

/** 人类可读音频摘要。 */
export function describeAudio(info) {
  const b = [];
  if (info?.duration) b.push(formatDuration(info.duration));
  if (info?.size) b.push(formatBytes(info.size));
  if (info?.codec) b.push(info.codec);
  if (info?.sampleRate) b.push(`${(info.sampleRate / 1000).toFixed(1)}kHz`);
  if (info?.channels) b.push(info.channels === 1 ? '单声道' : `${info.channels}声道`);
  return b.join(' · ') || '未知音频';
}

/**
 * 目标 key 解析：group:123 / private:123。
 *
 * 号码必须是**正整数**（不以 0 开头）：QQ 号与群号都不可能是 0，
 * 放 `group:0` 过去只会让一个必然失败的请求走到网关。
 * 非零开头同时也挡住了 `group:007` 这种写法。
 */
export function parseTargetKey(key) {
  const m = /^(group|private):([1-9]\d*)$/.exec(String(key ?? '').trim());
  if (!m) return null;
  return { kind: m[1], id: m[2], key: `${m[1]}:${m[2]}` };
}

/** 上传文件名净化：去掉路径、控制字符、Windows 保留字符，保留中文。 */
export function sanitizeUploadName(name) {
  let base = path.basename(String(name ?? '').replace(/\\/g, '/'));
  base = base.replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/^\.+/, '').trim();
  if (!base) base = 'audio';
  if (!isAudioFile(base)) base += '.mp3';
  if (base.length > 120) {
    const ext = path.extname(base);
    base = base.slice(0, 120 - ext.length) + ext;
  }
  return base;
}

/** 在语音库里为 filename 找一个不冲突的名字（foo.mp3 → foo-2.mp3）。 */
export function uniqueLibraryPath(voiceDir, filename) {
  const root = path.resolve(voiceDir);
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  let candidate = path.join(root, filename);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(root, `${stem}-${n}${ext}`);
    n += 1;
    if (n > 999) throw new Error('同名文件太多，换个名字再传');
  }
  return candidate;
}

// ── 音量调节 ────────────────────────────────────────────────────────────────
//
// 为什么在**本地**做：SnowLuma 只接受「音频文件」并自己转 SILK，没有音量参数
// （record 段只有 file/magic/url 之类，没有增益字段）。所以音量必须在交给网关之前
// 用 ffmpeg 调好，再把处理后的文件当普通音频发出去。
//
// 两种模式：
//   · volume 倍数/分贝 —— volume=2.0 或 volume=3dB。直观，可复现。
//   · loudnorm（智能音量）—— EBU R128 响度归一，把整体响度拉到目标 LUFS。
//     对"录音忽大忽小/整体太小"最有效；但它会**大幅改变动态**，不适合有音乐/音效的内容。
//     （曾经考虑 speechnorm，但它对非语音内容会过度抬升噪声，故不作为默认智能模式。）

/** 音量倍数范围（1.0 = 原样）。QQ 语音常见需求是"调大"，所以上限给到 4 倍。 */
export const VOLUME_MIN = 0.1;
export const VOLUME_MAX = 4;
/** 智能音量（loudnorm）的目标响度，单位 LUFS。 */
export const LOUDNESS_TARGETS = { quiet: -20, normal: -16, loud: -13 };

/** 解析语音处理选项；返回 { volume, loudness }（两者互斥，loudness 优先）。 */
export function resolveAudioProcessing({ volume = 1, normalize = false, loudness = 'normal' } = {}) {
  if (normalize === true) {
    // 允许两种写法：档位名（quiet/normal/loud）或直接的 LUFS 数字。
    // 注意顺序：**先判数字**再查档位表 —— 否则 -18 这种数字会被当成"未知档位"拒掉。
    if (typeof loudness === 'number') {
      if (!Number.isFinite(loudness) || loudness < -40 || loudness > -5) {
        throw new Error(`目标响度需在 -40 ~ -5 LUFS 之间，收到 ${loudness}`);
      }
      return { volume: 1, loudness, loudnessKey: String(loudness) };
    }
    const key = String(loudness ?? 'normal');
    if (!Object.hasOwn(LOUDNESS_TARGETS, key)) {
      throw new Error(`未知的响度档位「${key}」（可选：${Object.keys(LOUDNESS_TARGETS).join(' / ')}，或直接给 -40~-5 的 LUFS 数字）`);
    }
    return { volume: 1, loudness: LOUDNESS_TARGETS[key], loudnessKey: key };
  }
  const v = Number(volume);
  if (!Number.isFinite(v)) throw new Error(`音量必须是数字，收到「${volume}」`);
  if (v < VOLUME_MIN || v > VOLUME_MAX) {
    throw new Error(`音量倍数需在 ${VOLUME_MIN}~${VOLUME_MAX} 之间（1.0 = 原样），收到 ${v}`);
  }
  return { volume: v, loudness: null, loudnessKey: null };
}

/**
 * 定位 ffmpeg：显式参数 → 环境变量 → PATH。
 *
 * 优先级按**实现**写文档：config.json 的 socialV2.voice.ffmpegPath 是"这台机器上 ffmpeg 在哪"的
 * 显式配置，比环境变量更具体，所以参数优先（旧注释写成"环境变量 → 参数"，与代码相反，
 * 照着注释去改代码就会把用户的显式配置降级成环境变量兜底）。
 *
 * 只返回**确实存在**的文件路径。两个候选都没 stat 成功时返回裸命令名 'ffmpeg'，交给 spawn 按 PATH
 * 解析；旧实现在这种情况下返回 `candidates[0]`，哪怕那个路径根本不存在 —— 调用方于是拿到一句
 * 无信息量的"启动失败"，而不是 ENOENT 分支里那句"请设置 FFMPEG_PATH 或在 config.json 里指定"。
 */
export function resolveFfmpeg({ ffmpegPath = null, envVar = 'FFMPEG_PATH' } = {}) {
  const candidates = [ffmpegPath, process.env[envVar]].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {}
  }
  // PATH 里找（不真正执行，交给 spawn 时再报错）；绝不再回退到不存在的候选路径。
  return 'ffmpeg';
}

/**
 * 用 ffmpeg 调整音量/响度，产出**新文件**。
 * 返回 { path, converted, volume, loudness, mode, detail, applied }。
 * 调用方负责在用完后删除 converted=true 的临时文件。
 *
 * @param {string} file 输入音频
 * @param {object} opts
 *   volume    音量倍数（1 = 原样）
 *   normalize 是否启用 loudnorm 智能音量
 *   loudness  响度档位 quiet/normal/loud 或直接给 LUFS 数字
 *   tmpDir    输出目录（默认系统临时目录下的 voice-processed）
 *   ffmpegPath 指定 ffmpeg 可执行文件
 */
export async function processAudioVolume(file, {
  volume = 1,
  normalize = false,
  loudness = 'normal',
  tmpDir = null,
  ffmpegPath = null,
  timeoutMs = 120000
} = {}) {
  // 参数校验统一交给 resolveAudioProcessing（单一入口，避免两处规则漂移）
  const plan = resolveAudioProcessing({ volume, normalize, loudness });

  // 原样：不产生新文件，省一次转码
  if (!plan.loudness && Math.abs(plan.volume - 1) < 1e-9) {
    return { path: file, converted: false, applied: false, volume: 1, loudness: null, mode: 'original', detail: '原始音量' };
  }

  const ffmpeg = resolveFfmpeg({ ffmpegPath });
  const dir = tmpDir
    ? path.resolve(tmpDir)
    : path.join(os.tmpdir(), 'voice-processed');
  fs.mkdirSync(dir, { recursive: true });

  const ext = path.extname(file);
  // 输出统一用 m4a/mp3 这类"确定有损但体积小"的容器没必要：保留原扩展名，
  // 交给 ffmpeg 按扩展名挑编码器（mp3→libmp3lame、wav→pcm、ogg→libvorbis…）。
  // 风险是某些扩展名可能没有可用编码器，所以兜底用 wav（无损、编码器必然存在）。
  let outPath = path.join(dir, `vol-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext || '.wav'}`);

  const filters = plan.loudness !== null
    ? [`loudnorm=I=${plan.loudness}:TP=-1.5:LRA=11`]
    : [`volume=${plan.volume}`];
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-af', filters.join(','), '-ac', '1', outPath];

  const run = () => new Promise((resolve) => {
    let child;
    try {
      child = spawn(ffmpeg, args, { windowsHide: true, stdio: 'ignore' });
    } catch (error) {
      resolve({ code: -1, error: `ffmpeg 启动失败：${error?.message ?? error}` });
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve({ code: -2, error: 'ffmpeg 超时' }); }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, error: e.code === 'ENOENT' ? '找不到 ffmpeg（请设置 FFMPEG_PATH 或在 config.json 里指定 socialV2.voice.ffmpegPath）' : `ffmpeg 不可用：${e.message}` });
    });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code }); });
  });

  let res = await run();
  // 原扩展名可能没有可用编码器（如 .amr/.silk 只读）→ 退回 wav 再试一次
  if ((res.error || res.code !== 0 || !fs.existsSync(outPath)) && ext && ext.toLowerCase() !== '.wav') {
    const wavPath = outPath.replace(/\.[^.]+$/, '.wav');
    const wavArgs = ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-af', filters.join(','), '-ac', '1', wavPath];
    res = await new Promise((resolve) => {
      let child;
      try {
        child = spawn(ffmpeg, wavArgs, { windowsHide: true, stdio: 'ignore' });
      } catch (error) {
        resolve({ code: -1, error: `ffmpeg 启动失败：${error?.message ?? error}` });
        return;
      }
      const timer = setTimeout(() => { try { child.kill(); } catch {} resolve({ code: -2, error: 'ffmpeg 超时' }); }, timeoutMs);
      child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, error: `ffmpeg 不可用：${e.message}` }); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code }); });
    });
    if (!res.error && res.code === 0 && fs.existsSync(wavPath)) outPath = wavPath;
  }

  if (res.error) throw new Error(res.error);
  if (res.code !== 0 || !fs.existsSync(outPath)) {
    throw new Error(`ffmpeg 音量处理失败（退出码 ${res.code}）`);
  }
  const st = fs.statSync(outPath);
  if (st.size === 0) {
    try { fs.unlinkSync(outPath); } catch {}
    throw new Error('ffmpeg 输出为空文件（源音频可能损坏）');
  }

  const detail = plan.loudness !== null
    ? `智能音量（响度归一 ${plan.loudness} LUFS）`
    // 提升与压低必须分开说明。旧写法 `plan.volume > 1 ? A : A` 两个分支字面相同，把本来要表达的
    // "放大 / 衰减"区别写没了：操作者看到"音量 30%"时分不清是配置生效了还是根本没生效，
    // 排查语音太轻/太响时会白白绕一圈。
    : (plan.volume > 1
      ? `音量提升至 ${Math.round(plan.volume * 100)}%`
      : `音量压低至 ${Math.round(plan.volume * 100)}%`);
  return {
    path: outPath,
    converted: true,
    applied: true,
    volume: plan.volume,
    loudness: plan.loudness,
    mode: plan.loudness !== null ? 'loudnorm' : 'volume',
    detail,
    bytes: st.size
  };
}

/** 删除临时处理文件（失败不抛）。 */
export function cleanupTemp(file, isTemp) {
  if (!isTemp) return;
  try { fs.unlinkSync(file); } catch {}
}
