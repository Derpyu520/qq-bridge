#!/usr/bin/env node
// 快速把「准备好的音频」当 QQ 语音发给指定群聊/私聊。
//
// 用法（在 qq-bridge 目录下执行）：
//   node scripts/send-voice.mjs list                       # 有哪些群聊/私聊可发
//   node scripts/send-voice.mjs list-voice                 # 语音库里有哪些音频
//   node scripts/send-voice.mjs send <音频> <目标> [选项]   # 发一条语音
//   node scripts/send-voice.mjs check <音频>               # 只探测音频（不发送）
//   node scripts/send-voice.mjs status                     # 网关/桥接状态
//
// 目标写法：`群号` | `group:群号` | `private:QQ号` | `@昵称/群名`（唯一匹配时）
//
// 设计：默认走 qq-bridge 的 /api/send/voice —— 白名单、限流、审计、发送链路都在桥接里，
// 与 AI 用的工具完全同一条路径（避免 CLI 成为绕过闸门的后门）。
// `--direct` 可绕过桥接直连 SnowLuma，仅用于桥接没启动时的应急排查。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  describeAudio, formatBytes, formatDuration, inspectAudio, listAudioFiles,
  parseTargetKey, resolveAudioSource
} from '../src/send-voice-lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');

// ── 参数解析 ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flags = new Map();
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    if (v !== undefined) flags.set(k, v);
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) { flags.set(k, argv[++i]); }
    else flags.set(k, true);
  } else if (a.startsWith('-') && a.length > 1) {
    const [k, v] = a.slice(1).split('=');
    flags.set(k, v ?? true);
  } else positional.push(a);
}

const has = (k) => flags.has(k);
const val = (k, d = undefined) => (flags.has(k) ? (flags.get(k) === true ? '' : String(flags.get(k))) : d);
const num = (k, d) => {
  if (!flags.has(k)) return d;
  const n = Number(flags.get(k));
  return Number.isFinite(n) ? n : d;
};

// ── 配置 ────────────────────────────────────────────────────────────────────
function loadConfig() {
  try {
    let text = fs.readFileSync(CONFIG_PATH, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

const cfg = loadConfig();
const httpUrl = String(val('snowluma', cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000')).replace(/\/+$/, '');
const accessToken = String(val('token', cfg.snowluma?.accessToken || ''));
const consolePort = Number(val('console-port', cfg.consolePort)) || 3100;
const consoleToken = String(
  val('console-token', cfg.consoleToken || process.env.QQ_CONSOLE_TOKEN || readConsoleTokenFile() || '')
).trim();
const voiceDir = path.resolve(val('voice-dir', cfg.voice?.dir ? path.resolve(ROOT, cfg.voice.dir) : path.join(ROOT, 'audio')));
const revealToken = has('reveal-token');
const quiet = has('q') || has('quiet');

function readConsoleTokenFile() {
  try {
    return fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

const maskToken = (t) => (t ? '(已配置)' : '(未配置)');
const out = (...a) => { if (!quiet) console.log(...a); };
const fail = (msg, code = 1) => { console.error(`❌ ${msg}`); process.exit(code); };

// ── OneBot 直连（用于 list/status/check 的只读查询；发送默认走桥接） ─────────
async function onebot(action, params = {}, { timeoutMs = 15000 } = {}) {
  const res = await fetch(`${httpUrl}/${action}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {})
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (res.status === 426) {
    throw new Error(`HTTP 426：httpUrl 指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl（当前 ${httpUrl}）`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json().catch(() => ({}));
  if (body.status !== 'ok' || body.retcode !== 0) {
    throw new Error(`OneBot ${action} 失败: retcode=${body.retcode} ${body.wording ?? ''}`.trim());
  }
  return body.data;
}

async function bridgeApi(pathname, init = {}) {
  const headers = {
    'content-type': 'application/json',
    ...(consoleToken ? { 'x-console-token': consoleToken } : {}),
    ...(init.headers ?? {})
  };
  const res = await fetch(`http://127.0.0.1:${consolePort}${pathname}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(init.timeoutMs ?? 60000)
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!res.ok) {
    const err = new Error(body?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// ── 目标表和解析 ────────────────────────────────────────────────────────────
function allowedSet() {
  const allow = cfg.allow ?? {};
  const deny = cfg.deny ?? {};
  return {
    groups: new Set((allow.groups ?? []).map(String)),
    private: new Set((allow.private ?? []).map(String)),
    denyGroups: new Set((deny.groups ?? []).map(String)),
    denyPrivate: new Set((deny.private ?? []).map(String)),
    allowAllWhenEmpty: cfg.allowAllWhenEmpty === true
  };
}

function isAllowedKey(key) {
  const t = parseTargetKey(key);
  if (!t) return false;
  const a = allowedSet();
  if (t.kind === 'group') {
    if (a.denyGroups.has(t.id)) return false;
    if (a.groups.size > 0) return a.groups.has(t.id);
    return a.allowAllWhenEmpty;
  }
  if (a.denyPrivate.has(t.id)) return false;
  if (a.private.size > 0) return a.private.has(t.id);
  return a.allowAllWhenEmpty;
}

async function fetchTargets() {
  const [groups, friends] = await Promise.all([
    onebot('get_group_list').catch((e) => ({ __error: e.message })),
    onebot('get_friend_list').catch((e) => ({ __error: e.message }))
  ]);
  const g = Array.isArray(groups) ? groups : [];
  const f = Array.isArray(friends) ? friends : [];
  return {
    groups: g.map((x) => ({ id: String(x.group_id), name: x.group_name || '', count: x.member_count ?? null })),
    friends: f.map((x) => ({ id: String(x.user_id), name: x.nickname || '', remark: x.remark || '' })),
    groupsError: groups?.__error ?? null,
    friendsError: friends?.__error ?? null
  };
}

/**
 * 把用户输入解析成目标 key。
 * 支持：123456 / group:123456 / private:123456 / @名字（在群名和好友昵称/备注里唯一匹配）
 */
async function resolveTarget(input) {
  const raw = String(input ?? '').trim();
  if (!raw) fail('缺少目标（群号 / group:群号 / private:QQ号 / @名字）');

  const direct = parseTargetKey(raw);
  if (direct) return direct;

  if (/^\d+$/.test(raw)) {
    // 纯数字：优先当群号，群列表里没有则当 QQ 号
    const t = await fetchTargets();
    if (t.groups.some((g) => g.id === raw)) return { kind: 'group', id: raw, key: `group:${raw}` };
    if (t.friends.some((f) => f.id === raw)) return { kind: 'private', id: raw, key: `private:${raw}` };
    return { kind: 'group', id: raw, key: `group:${raw}`, unverified: true };
  }

  const want = raw.replace(/^@/, '').toLowerCase();
  const t = await fetchTargets();
  const hits = [];
  for (const g of t.groups) {
    if (g.name.toLowerCase().includes(want) || g.id.includes(want)) hits.push({ kind: 'group', id: g.id, key: `group:${g.id}`, name: g.name, label: `群 ${g.name}(${g.id})` });
  }
  for (const f of t.friends) {
    if (f.name.toLowerCase().includes(want) || f.remark.toLowerCase().includes(want) || f.id.includes(want)) {
      hits.push({ kind: 'private', id: f.id, key: `private:${f.id}`, name: f.remark || f.name, label: `私聊 ${f.remark ? `${f.remark}/` : ''}${f.name}(${f.id})` });
    }
  }
  if (hits.length === 0) fail(`找不到匹配「${raw}」的群聊或私聊（用 list 看可用目标）`);
  if (hits.length > 1) {
    console.error(`❌ 「${raw}」匹配到多个目标，请写明确：`);
    for (const h of hits) console.error(`   - ${h.label}`);
    process.exit(1);
  }
  return hits[0];
}

// ── 子命令 ──────────────────────────────────────────────────────────────────
async function cmdList() {
  let t;
  try {
    t = await fetchTargets();
  } catch (error) {
    fail(`无法访问 SnowLuma（${httpUrl}）：${error?.message ?? error}\n   请先启动 SnowLuma（config.json 的 snowluma.launcherPath）。`);
  }
  const a = allowedSet();
  const mark = (kind, id) => {
    const allowed = isAllowedKey(`${kind}:${id}`);
    return allowed ? '✅ 可发' : '⛔ 白名单外';
  };
  console.log(`SnowLuma: ${httpUrl}`);
  console.log(`\n【群聊】${t.groups.length} 个`);
  if (t.groupsError) console.log(`  ⚠️ get_group_list 失败：${t.groupsError}`);
  for (const g of t.groups) {
    console.log(`  group:${g.id.padEnd(12)} ${(g.name || '(无名)').padEnd(20)} ${g.count != null ? `${g.count}人` : ''}  ${mark('group', g.id)}`);
  }
  console.log(`\n【私聊/好友】${t.friends.length} 个`);
  if (t.friendsError) console.log(`  ⚠️ get_friend_list 失败：${t.friendsError}`);
  for (const f of t.friends) {
    console.log(`  private:${f.id.padEnd(10)} ${(f.remark ? `${f.remark} / ` : '') + (f.name || '')}  ${mark('private', f.id)}`);
  }
  console.log(`\n白名单（config.json allow）：群 ${[...a.groups].join(', ') || '(空)'}；私聊 ${[...a.private].join(', ') || '(空)'}`);
  if (a.allowAllWhenEmpty) console.log('⚠️ allowAllWhenEmpty=true：白名单为空时全部放行');
  console.log(`\n发送示例：node scripts/send-voice.mjs send "<音频文件>" ${t.groups[0] ? `group:${t.groups[0].id}` : 'private:<QQ号>'}`);
}

async function cmdListVoice() {
  if (!fs.existsSync(voiceDir)) {
    console.log(`语音库目录不存在：${voiceDir}`);
    console.log('（把音频放进去，或用 --voice-dir 指定别的目录；也可以 send 时直接给任意路径）');
    return;
  }
  const files = listAudioFiles(voiceDir);
  console.log(`语音库：${voiceDir}`);
  if (files.length === 0) {
    console.log('（目录为空 —— 把 .mp3/.wav/.ogg/.m4a/.amr/.silk 等音频放进来即可）');
    return;
  }
  console.log(`共 ${files.length} 个音频：\n`);
  const probe = !has('no-probe');
  for (const f of files) {
    const rel = path.relative(voiceDir, f);
    if (!probe) {
      console.log(`  ${rel}  (${formatBytes(fs.statSync(f).size)})`);
      continue;
    }
    const info = await inspectAudio(f, { maxBytes: Infinity, maxSeconds: Infinity });
    console.log(`  ${rel.padEnd(34)} ${describeAudio({ size: info.size, duration: info.duration, codec: info.codec })}`);
  }
  console.log(`\n发送示例：node scripts/send-voice.mjs send "${path.relative(voiceDir, files[0])}" <目标>`);
}

async function cmdStatus() {
  console.log(`配置文件：${CONFIG_PATH}`);
  console.log(`  snowluma.httpUrl   = ${httpUrl}`);
  console.log(`  snowluma.accessToken = ${revealToken ? accessToken : maskToken(accessToken)}`);
  console.log(`  桥接控制台         = http://127.0.0.1:${consolePort}`);
  console.log(`  consoleToken       = ${revealToken ? consoleToken : maskToken(consoleToken)}`);
  console.log(`  语音库目录         = ${voiceDir}`);
  try {
    const login = await onebot('get_login_info');
    console.log(`\n✅ SnowLuma 在线：${login.user_id} (${login.nickname ?? ''})`);
  } catch (error) {
    console.log(`\n❌ SnowLuma 不可达：${error?.message ?? error}`);
  }
  try {
    const st = await bridgeApi('/api/status');
    console.log(`✅ 桥接在线：mode=${st.mode ?? '?'} role=${st.role ?? '?'} dshReady=${st.dshReady ?? '?'} paused=${st.socialV2Paused ?? '?'}`);
  } catch (error) {
    console.log(`⚠️ 桥接不可达（http://127.0.0.1:${consolePort}）：${error?.message ?? error}`);
    console.log('   → 发送语音需要桥接在线（它负责白名单/限流/审计）。应急可用 --direct 直连网关（无闸门）。');
  }
}

async function cmdCheck() {
  const src = positional[1];
  if (!src) fail('用法：node scripts/send-voice.mjs check <音频文件>');
  const r = resolveAudioSource(src, { voiceDir });
  if (!r.path) {
    const hint = r.candidates.length ? `\n   语音库里的近似匹配：${r.candidates.map((c) => path.relative(voiceDir, c.path)).join('、')}` : '';
    fail(`找不到音频「${src}」${hint}`);
  }
  const info = await inspectAudio(r.path, {
    maxBytes: num('max-bytes', undefined) ?? undefined,
    maxSeconds: num('max-seconds', undefined) ?? undefined,
    ffprobePath: val('ffprobe', process.env.FFPROBE_PATH || 'ffprobe')
  });
  console.log(`音频：${r.path}`);
  console.log(`  来源：${r.via}`);
  console.log(`  信息：${describeAudio(info)}`);
  if (info.formatName) console.log(`  容器：${info.formatName}`);
  for (const w of info.warnings ?? []) console.log(`  ⚠️ ${w}`);
  if (!info.ok) fail(info.error);
  if (has('transcode-test')) {
    console.log('\n正在让 SnowLuma 把音频转成 SILK→mp3（验证网关转码链路）…');
    const t0 = Date.now();
    try {
      const data = await onebot('get_record', { file: r.path, out_format: 'mp3' }, { timeoutMs: 120000 });
      const b64 = data?.base64 ?? '';
      console.log(`✅ 网关转码成功：${((b64.length * 3) / 4 / 1024).toFixed(1)} KB mp3，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (error) {
      console.log(`⚠️ 网关转码验证失败：${error?.message ?? error}`);
      console.log('   （get_record 主要面向「收到的语音」缓存；发送路径仍可能正常，可用 send --dry-run 验证）');
    }
  }
  console.log('\n✅ 音频可用于发送');
}

async function cmdSend() {
  const src = positional[1];
  const targetInput = positional[2] ?? val('to', '');
  if (!src) fail('用法：node scripts/send-voice.mjs send <音频文件> <目标> [--dry-run]');
  if (!targetInput) fail('缺少目标：群号 / group:群号 / private:QQ号 / @名字');

  const r = resolveAudioSource(src, { voiceDir });
  if (!r.path) {
    const hint = r.candidates.length ? `\n   语音库里的近似匹配：${r.candidates.map((c) => path.relative(voiceDir, c.path)).join('、')}` : '';
    fail(`找不到音频「${src}」${hint}`);
  }
  const info = await inspectAudio(r.path, {
    maxBytes: num('max-bytes', undefined) ?? undefined,
    maxSeconds: num('max-seconds', undefined) ?? undefined
  });
  if (!info.ok) fail(info.error);

  const target = await resolveTarget(targetInput);
  const allowed = isAllowedKey(target.key);
  const dryRun = has('dry-run') || has('n');

  console.log('─'.repeat(60));
  console.log(`音频  : ${r.path}`);
  console.log(`        ${describeAudio(info)}${info.formatName ? ` · ${info.formatName}` : ''}`);
  console.log(`目标  : ${target.kind === 'group' ? '群聊' : '私聊'} ${target.key}${target.unverified ? '（网关未确认该目标存在）' : ''}`);
  console.log(`白名单: ${allowed ? '✅ 命中' : '⛔ 未命中'}${has('force') ? '（--force 已指定，仍会被桥接拒绝）' : ''}`);
  for (const w of info.warnings ?? []) console.log(`⚠️  ${w}`);
  console.log('─'.repeat(60));

  if (dryRun) {
    // 走桥接的 dry-run：把「桥接会怎么判」原样跑一遍（白名单/限流/尺寸/时长），只是不落消息。
    // 桥接不可达时退回本地判断，保证离线也能做参数检查。
    if (!has('direct')) {
      try {
        const data = await bridgeApi('/api/voice/send', {
          method: 'POST',
          body: JSON.stringify({ target: target.key, file: r.path, dryRun: true })
        });
        console.log('DRY-RUN（经桥接校验）：未发送。');
        if (data?.limits) {
          console.log(`  桥接上限：时长 ≤ ${formatDuration(data.limits.maxSeconds)} · 体积 ≤ ${formatBytes(data.limits.maxBytes)} · ${data.limits.maxPerMinute}/分钟 · ${data.limits.maxPerHour}/小时`);
        }
        console.log(`  桥接解析：${data?.file ?? r.path}`);
        return;
      } catch (error) {
        if (error?.status === 404) {
          console.log('⚠️  桥接还没有 /api/voice/send 端点（需重启桥接）；以下为本地校验结果。');
        } else {
          console.log(`⚠️  桥接校验不可用（${error?.message ?? error}）；以下为本地校验结果。`);
        }
      }
    }
    console.log('DRY-RUN：未发送。去掉 --dry-run 即真发。');
    return;
  }
  if (!allowed && !has('direct')) {
    fail(`目标 ${target.key} 不在白名单（config.json allow.groups/allow.private）。\n   要么把目标加进白名单，要么（仅排查用）加 --direct 绕过桥接直连网关。`);
  }

  const useDirect = has('direct');
  let result;
  if (useDirect) {
    console.log('⚠️  --direct：绕过桥接直连 SnowLuma（不做白名单/限流/审计）');
    const action = target.kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = target.kind === 'private'
      ? { user_id: Number(target.id), message: [{ type: 'record', data: { file: r.path } }] }
      : { group_id: Number(target.id), message: [{ type: 'record', data: { file: r.path } }] };
    const data = await onebot(action, params, { timeoutMs: 180000 });
    result = { ok: true, direct: true, messageId: data?.message_id ?? null };
  } else {
    try {
      result = await bridgeApi('/api/voice/send', {
        method: 'POST',
        body: JSON.stringify({
          target: target.key,
          file: r.path,
          dryRun: false,
          verify: !has('no-verify'),
          readback: has('transcript'),
          // 音量交给桥接处理（与前端面板、图形界面同一条路径）
          volume: has('volume') ? Number(val('volume')) : 1,
          normalize: has('normalize'),
          loudness: has('loudness') ? String(val('loudness')) : 'normal',
          source: 'cli'
        }),
        timeoutMs: 240000
      });
    } catch (error) {
      if (error?.status === 404) {
        fail('桥接还没有 /api/voice/send 端点（需要重启桥接加载新版本 bridge.js）。\n   临时可用 --direct 直连网关发送。');
      }
      fail(`发送失败：${error?.message ?? error}`);
    }
  }

  console.log(`✅ 已作为语音发出（messageId=${result?.messageId ?? '未知'}${result?.direct ? '，直连模式' : ''}）`);
  if (result?.detail) console.log(`   ${result.detail}`);
  if (result?.audioProcessing && result.audioProcessing !== '原始音量') {
    console.log(`   🔊 ${result.audioProcessing}`);
  }
  if (result && 'verified' in result) {
    console.log(result.verified
      ? `   ✅ 已回读校验：网关确认这条消息是语音段${result.recordFile ? `（${result.recordFile}）` : ''}`
      : '   ⚠️ 未能回读校验（消息应已发出，但没读回 record 段；可在 QQ 里肉眼确认）');
  }
  if (result?.readback) console.log(`   转写：${result.readback}`);
}

function usage() {
  console.log(`把准备好的音频当 QQ 语音发送（SnowLuma / OneBot）

用法：
  node scripts/send-voice.mjs list                       列出可发的群聊/私聊（含白名单状态）
  node scripts/send-voice.mjs list-voice [--no-probe]    列出语音库里的音频
  node scripts/send-voice.mjs check <音频> [--transcode-test]
                                                         只探测音频（时长/大小/编码）
  node scripts/send-voice.mjs send <音频> <目标> [选项]   发送语音
  node scripts/send-voice.mjs status                     网关 + 桥接 + 配置状态

目标写法：
  100005 / group:100005 / private:100010 / @群名或昵称（唯一匹配）

send 选项：
  --dry-run        只解析不发送（走桥接的真实校验路径）
  --volume 2       音量倍数（0.1~4，1 = 原样）；手机外放听不清就调到 2~3
  --normalize      智能音量：按 EBU R128 把整体响度拉到目标（录音忽大忽小时最有效）
  --loudness loud  智能音量档位：quiet(-20) / normal(-16) / loud(-13)，默认 normal
  --no-verify      跳过发送后的回读校验（默认会 get_msg 回读确认语音段真的落地）
  --transcript     额外索取 QQ 转写文本（只有"收到的"语音才有，自己发的一般为空）
  --voice-dir DIR  指定语音库目录（默认 config.voice.dir 或 <repo>/audio）
  --max-seconds N  时长上限（默认 300）
  --max-bytes N    体积上限（默认 20MiB）
  --direct         ⚠️ 绕过桥接直连 SnowLuma（无白名单/限流/审计，仅应急排查）
  --reveal-token   在 status 里显示完整令牌（默认打码）
`);
}

// ── 入口 ────────────────────────────────────────────────────────────────────
const cmd = positional[0] || 'list';
try {
  switch (cmd) {
    case 'list': case 'ls': await cmdList(); break;
    case 'list-voice': case 'voices': await cmdListVoice(); break;
    case 'check': case 'probe': await cmdCheck(); break;
    case 'send': case 'voice': await cmdSend(); break;
    case 'status': await cmdStatus(); break;
    case 'help': case '-h': case '--help': usage(); break;
    default:
      console.error(`未知命令：${cmd}\n`);
      usage();
      process.exit(2);
  }
} catch (error) {
  fail(error?.stack && has('debug') ? error.stack : (error?.message ?? String(error)));
}
