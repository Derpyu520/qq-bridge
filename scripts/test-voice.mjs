// 语音发送自检：
// 1) send-voice-lib 纯函数（来源解析、音频库列举、时长/体积校验、目标 key 解析）
// 2) 配置项 + MCP 工具 + bridge 路由存在性
// 3) 安全边界：AI 通道不许绝对路径（默认）、不许 base64/http 来源
// 4) live 模式（QQ_BRIDGE_TEST_LIVE=1）：对桥接 /api/voice/send 做 dry-run，验证真实链路可解析
//
// 注意：**默认不真发语音**（真发会产生不可撤回的 QQ 消息）。要真发请用 CLI：
//   node scripts/send-voice.mjs send "<音频>" group:<群号>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUDIO_EXTS, describeAudio, formatBytes, formatDuration,
  inspectAudio, isAudioFile, listAudioFiles, parseTargetKey, resolveAudioSource
} from '../src/send-voice-lib.js';
// 独立发语音工具在仓库上一级（不在本仓库里）：位置解析与"不在时怎么跳过"走共享口径。
import { hasVoiceTool, skipVoiceTool, voiceToolPath } from './voice-tool-locator.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.error(`  ❌ ${name}`); }
}

// ── 临时音频库 fixture ─────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-voice-test-'));
const voiceDir = path.join(tmp, 'audio');
fs.mkdirSync(path.join(voiceDir, 'sub'), { recursive: true });
const emptyAudio = path.join(voiceDir, 'empty.mp3');
const fakeAudio = path.join(voiceDir, 'hello.mp3');
const nestedAudio = path.join(voiceDir, 'sub', 'nested.wav');
const notAudio = path.join(voiceDir, 'notes.txt');
fs.writeFileSync(fakeAudio, Buffer.alloc(2048, 7));
fs.writeFileSync(emptyAudio, Buffer.alloc(0));
fs.writeFileSync(nestedAudio, Buffer.alloc(4096, 3));
fs.writeFileSync(notAudio, 'hello');

console.log('## send-voice-lib 纯函数');
{
  ok(isAudioFile('a.mp3') && isAudioFile('A.WAV') && isAudioFile('x.silk'), 'isAudioFile 识别音频扩展名');
  ok(!isAudioFile('a.txt') && !isAudioFile('a'), 'isAudioFile 拒绝非音频');
  ok(AUDIO_EXTS.includes('.amr') && AUDIO_EXTS.includes('.m4a'), 'AUDIO_EXTS 覆盖 QQ 常见格式');
  ok(formatBytes(512) === '512 B' && formatBytes(2048).includes('KB') && formatBytes(3 * 1024 * 1024).includes('MB'), 'formatBytes 分级');
  ok(formatDuration(45) === '45秒' && formatDuration(95) === '1分35秒', 'formatDuration 中文格式');
  ok(parseTargetKey('group:123')?.kind === 'group', 'parseTargetKey 群');
  ok(parseTargetKey('private:456')?.kind === 'private', 'parseTargetKey 私聊');
  ok(parseTargetKey('123') === null && parseTargetKey('group:abc') === null, 'parseTargetKey 拒绝非法 key');
}

console.log('## 语音库列举');
{
  const files = listAudioFiles(voiceDir);
  ok(files.length === 3, `列出 3 个音频（实际 ${files.length}），忽略 txt`);
  ok(files.some((f) => f.endsWith('nested.wav')), '递归列出子目录音频');
  ok(listAudioFiles(path.join(tmp, 'nope')).length === 0, '目录不存在时返回空数组');
}

console.log('## 音频来源解析');
{
  const abs = resolveAudioSource(fakeAudio, { voiceDir });
  ok(abs.path === path.resolve(fakeAudio) && abs.via === 'absolute', '绝对路径解析');

  const rel = resolveAudioSource('hello.mp3', { voiceDir, cwd: tmp });
  ok(rel.path === path.resolve(fakeAudio), '语音库文件名解析');

  // 省略扩展名：'hello' 不在 cwd 里，但语音库里有 hello.mp3 → 补扩展名命中
  const bare = resolveAudioSource('hello', { voiceDir, cwd: tmp });
  ok(bare.path === path.resolve(fakeAudio) && bare.via === 'voice-dir+ext', '省略扩展名解析（补扩展名）');

  // 完全靠 basename 匹配（连补扩展名都不成立时才会走到 fuzzy）
  fs.mkdirSync(path.join(tmp, 'elsewhere'), { recursive: true });
  const fuzzy = resolveAudioSource('hello', { voiceDir, cwd: path.join(tmp, 'elsewhere') });
  ok(fuzzy.path === path.resolve(fakeAudio), '换个 cwd 仍能命中语音库同名文件');

  const nested = resolveAudioSource('sub/nested.wav', { voiceDir, cwd: tmp });
  ok(nested?.path === path.resolve(nestedAudio), '子目录相对路径解析');

  const fileUrl = resolveAudioSource(`file:///${fakeAudio.replace(/\\/g, '/')}`, { voiceDir });
  ok(fileUrl.path === path.resolve(fakeAudio), 'file:// URL 解析');

  const missing = resolveAudioSource('nope.mp3', { voiceDir, cwd: tmp });
  ok(missing.path === null && missing.via === 'not-found', '找不到时返回 not-found');
}

console.log('## 音频校验（体积/空文件）');
{
  const empty = await inspectAudio(emptyAudio);
  ok(!empty.ok && /空/.test(empty.error), '空文件被拒绝');

  const tooBig = await inspectAudio(fakeAudio, { maxBytes: 100 });
  ok(!tooBig.ok && /过大/.test(tooBig.error), '超过体积上限被拒绝');

  const missing = await inspectAudio(path.join(tmp, 'nope.mp3'));
  ok(!missing.ok && /不存在/.test(missing.error), '不存在文件被拒绝');

  const good = await inspectAudio(fakeAudio, { maxBytes: 10 * 1024 * 1024 });
  ok(good.ok && good.size === 2048, '正常文件通过（大小正确）');
  ok(Array.isArray(good.warnings), '返回 warnings 数组');

  const txt = await inspectAudio(notAudio, { maxBytes: 10 * 1024 * 1024 });
  ok(txt.ok && txt.warnings.some((w) => /扩展名/.test(w)), '非音频扩展名给出告警但仍放行（交给网关识别）');

  ok(describeAudio({ duration: 95, size: 2048, codec: 'mp3', sampleRate: 24000, channels: 1 }).includes('1分35秒'), 'describeAudio 含时长与编码');
}

console.log('## 配置项（AI 发语音默认关闭，等语音库准备好再开）');
{
  // 这一段查的是**「出厂默认就应该是关的」**这类契约。该契约的权威声明是
  // `config.example.json` —— 它随仓库发布、代表本项目承诺的默认值。
  //
  // ⚠️ 刻意**只查 example，不查用户的 config.json**（早期版本查的是后者，两个毛病）：
  //   ① 全新 clone 里根本没有 config.json（它是 .gitignore 的本机配置）⇒ 直接 ENOENT 崩溃，
  //      于是"照 README 克隆完跑自检"会看到假红；
  //   ② 更要紧的是语义错了：AI 发语音是**受支持的功能**，用户按文档打开它之后，
  //      这条断言会去断言**用户的当前状态**并失败 —— 测试不该因为用户用了功能而变红。
  // 用户当前值只做提示，不参与判定。
  const exCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  ok(exCfg.socialV2?.tools?.sendVoice === false, 'config.example.json tools.sendVoice=false（出厂默认不给 AI 发语音）');
  ok(exCfg.socialV2?.voice?.enabled === false, 'config.example.json voice.enabled=false（出厂默认总闸关闭）');
  ok(exCfg.socialV2?.voice?.allowAbsolutePath === false, '出厂默认禁止绝对路径（安全默认）');
  ok(Number(exCfg.socialV2?.voice?.maxPerHour) > 0, '出厂默认带每小时限流');
  try {
    const localCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    console.log(`  ℹ  你本机的值（仅供参考，不参与判定）：tools.sendVoice=${localCfg.socialV2?.tools?.sendVoice} / voice.enabled=${localCfg.socialV2?.voice?.enabled}`);
  } catch {
    console.log('  ℹ  本机没有 config.json（不入库）——本段只查随仓库发布的出厂默认');
  }
  const cfg = exCfg;
  const ex = exCfg;
  ok(ex.socialV2?.voice?.dir === 'audio', 'config.example.json 含 voice 段');
  // 代码里的默认值也必须一致，否则删掉 config.json 里那两行就会变回"默认开"
  const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  ok(/sendVoice: false,/.test(bridgeSrc), 'bridge.js 里 tools 默认 sendVoice: false');
  ok(/cfg\.socialV2\.voice = \{\s*\n\s*enabled: false,/.test(bridgeSrc), 'bridge.js 里 voice 默认 enabled: false');
}

console.log('## MCP 工具与 bridge 路由');
{
  const mcp = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');
  ok(mcp.includes("'qq_send_voice'"), 'MCP 注册 qq_send_voice');
  ok(mcp.includes("'qq_list_voices'"), 'MCP 注册 qq_list_voices');
  ok(mcp.includes("qq_send_voice: 'sendVoice'"), 'qq_send_voice 受 sendVoice 开关控制');
  ok(mcp.includes("qq_list_voices: 'sendVoice'"), 'qq_list_voices 受 sendVoice 开关控制');
  const voiceBlock = mcp.slice(mcp.indexOf("'qq_send_voice'"), mcp.indexOf("'qq_list_voices'"));
  ok(voiceBlock.includes('/api/socialV2/send-voice'), 'qq_send_voice 调 /api/socialV2/send-voice');
  ok(!voiceBlock.includes("绝对路径的音频"), 'qq_send_voice 不暴露绝对路径参数');

  const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  for (const s of [
    '/api/voice/send', '/api/socialV2/send-voice', '/api/socialV2/voices',
    'sendVoiceV2', 'sendVoiceForV2', 'resolveVoicePathForV2', 'resolveVoicePathForOperator',
    'voiceBudgetCheck', 'assertOutboundAuditOk', 'type: \'record\''
  ]) {
    ok(bridge.includes(s), `bridge 包含 ${s}`);
  }
  ok(bridge.includes("v2ToolEnabled('sendVoice')"), 'send-voice 路由受 sendVoice 开关控制');
  ok(/resolveVoicePathForV2[\s\S]{0,1200}allowAbsolutePath/.test(bridge), 'AI 通道绝对路径受 allowAbsolutePath 约束');
}

console.log('## 安全边界（AI 通道来源限制）');
{
  const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  const fn = bridge.slice(bridge.indexOf('function resolveVoicePathForV2'), bridge.indexOf('function resolveVoicePathForOperator'));
  ok(/base64:|data:|https\?:/.test(fn), 'AI 通道拒绝 base64/data/http 来源');
  ok(/allowAbsolutePath/.test(fn), 'AI 通道检查 allowAbsolutePath');
  const sendRoute = bridge.slice(bridge.indexOf("url.pathname === '/api/socialV2/send-voice'"), bridge.indexOf("url.pathname === '/api/socialV2/send-sticker'"));
  ok(sendRoute.includes('v2SessionAllowed(key)'), '语音发送校验会话白名单');
  ok(sendRoute.includes('agentTokenOk(key, token)'), '语音发送校验 agent token');
  ok(sendRoute.includes('shouldBlockSilentReply(key)'), '语音发送尊重静默模式');
  ok(sendRoute.includes('voiceBudgetCheck'), '语音发送走语音限流');
}

console.log('## 独立工具（不依赖桥接；已拆到仓库上一级 voice-tool/）');
if (!hasVoiceTool()) {
  skipVoiceTool('独立工具的结构断言（voice-cli.mjs 存在性、零依赖、OneBot 动作、共享内核指向、两个启动器）');
} else {
  const standalone = voiceToolPath('voice-cli.mjs');
  ok(fs.existsSync(standalone), 'voice-tool/voice-cli.mjs 存在（独立直连 SnowLuma）');
  const src = fs.readFileSync(standalone, 'utf8');
  ok(!/send-voice-lib/.test(src), '独立工具不 import 桥接模块（真正零依赖）');
  ok(/send_private_msg|send_group_msg/.test(src), '独立工具直接调 OneBot 发送动作');
  ok(/type: 'record'/.test(src), '独立工具构造 record 段');
  ok(/get_msg/.test(src), '独立工具做发送后回读校验');
  ok(/'close'/.test(src) && /readFileSync\(out/.test(src), '独立工具 ffprobe 结果经文件回传（兼容受限沙箱）');
  ok(/readline/.test(src), '独立工具带交互菜单');
  // 共享内核只有一份实现：工具必须引 qq-bridge 的，而不是自带副本
  ok(/from '\.\.\/qq-bridge\/src\/voice-core\.js'/.test(src), '独立工具的语音内核指向 qq-bridge（单一实现）');
  ok(fs.existsSync(voiceToolPath('发语音.cmd')), 'voice-tool/发语音.cmd 双击启动器存在');
  ok(fs.existsSync(voiceToolPath('config.example.json')), 'voice-tool/config.example.json 存在');
  ok(fs.existsSync(path.join(ROOT, '..', '发语音-图形界面.cmd')), '上级 发语音-图形界面.cmd 启动器存在');
}

console.log('## preset 人设已描述语音能力（否则 AI 不知道自己会说话）');
{
  const preset = fs.readFileSync(path.join(ROOT, 'dsh', 'agent-presets', 'qq-chat-v2', 'agent.cordis.yml'), 'utf8');
  ok(preset.includes('qq_send_voice'), 'qq-chat-v2 人设提到 qq_send_voice');
  ok(preset.includes('qq_list_voices'), 'qq-chat-v2 人设提到 qq_list_voices');
  ok(preset.includes('verified=true'), '人设说明 verified=true 的语义');
  ok(/不要假装发了语音/.test(preset), '人设禁止假装发语音');
  // DSH 0.1.7 起守卫的权威实现只有一份，在 qq-agent-presets bundle 里
  // （dsh/agent-presets/<preset>/qq-tool-restrict.mjs 只是 re-export 壳）。
  const restrict = fs.readFileSync(path.join(ROOT, 'plugins', 'qq-agent-presets', 'qq-tool-restrict.mjs'), 'utf8');
  ok(restrict.includes("'mcp__snowluma__qq_send_voice'"), '守卫白名单显式登记 mcp__snowluma__qq_send_voice');
  ok(restrict.includes("'mcp__snowluma__qq_list_voices'"), '守卫白名单显式登记 mcp__snowluma__qq_list_voices');
  ok(!restrict.includes('SAFE_PREFIXES'), '守卫不再按命名空间前缀放行（改为显式全名）');
}

console.log('## 控制台契约');
{
  const html = fs.readFileSync(path.join(ROOT, 'public', 'console.html'), 'utf8');
  const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  ok(html.includes('data-v2-tool="sendVoice"'), '控制台有 sendVoice 工具开关');
  ok(bridgeSrc.includes("'sendVoice']"), 'config API 的 toolFlags 含 sendVoice');
  const uniq = (a) => [...new Set(a)].sort();
  const views = uniq([...html.matchAll(/data-view="([a-z0-9-]+)"/g)].map((m) => m[1]));
  const pages = uniq([...html.matchAll(/data-page="([a-z0-9-]+)"/g)].map((m) => m[1]));
  ok(JSON.stringify(views) === JSON.stringify(pages), `data-view 与 data-page 一一对应（${views.length} 个视图）`);
}

console.log('## 回归：AI 语音通道不许穿出语音库（P1，曾可复现）');
{
  // 由来：resolveVoicePathForV2 只拦绝对路径，而 resolveAudioSource 会**先用 process.cwd()
  // 解析相对路径**，于是 AI 传 `..\..\某本机文件.mp3` 就能读库外文件（allowAbsolutePath
  // 那道闸门形同虚设）。修法是相对路径一律走 safeJoinLibrary。这里用真实 bridge 闭包验证。
  const { bridgeHarness } = await import('./audit-bridge-harness.mjs');
  const h = await bridgeHarness({ config: { socialV2: { voice: { enabled: true } } } });
  try {
    const dir = path.join(h.temp, 'audio');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ok.mp3'), Buffer.alloc(1024, 1));
    const outside = path.join(h.temp, 'secret-outside.mp3');
    fs.writeFileSync(outside, Buffer.alloc(512, 1));

    // 正常用法必须仍然可用（别把功能一起修死）
    ok(h.resolveVoicePathForV2('ok.mp3').path === path.join(dir, 'ok.mp3'), '合法文件名可用');
    ok(h.resolveVoicePathForV2('ok').path === path.join(dir, 'ok.mp3'), '省略扩展名仍可用');

    for (const [label, payload] of [
      ['..\\..\\ 相对穿越', '..\\..\\secret-outside.mp3'],
      ['../../ 相对穿越', '../../secret-outside.mp3'],
      ['sub/../../ 混合穿越', 'sub/../../secret-outside.mp3'],
    ]) {
      let threw = null;
      try { h.resolveVoicePathForV2(payload); } catch (e) { threw = e; }
      ok(Boolean(threw), `${label} 被拒`, threw ? threw.message.slice(0, 30) : '竟然放行了！');
    }
    let abs = null;
    try { h.resolveVoicePathForV2(outside); } catch (e) { abs = e; }
    ok(Boolean(abs), '库外绝对路径被拒');
    let sys = null;
    try { h.resolveVoicePathForV2('C:\\Windows\\Media\\Alarm01.wav'); } catch (e) { sys = e; }
    ok(Boolean(sys), '系统绝对路径被拒');
    for (const p of ['base64://AAAA', 'data:audio/mp3;base64,AAAA', 'https://x/a.mp3']) {
      let t = null;
      try { h.resolveVoicePathForV2(p); } catch (e) { t = e; }
      ok(Boolean(t), `${p.split(':')[0]} 来源被拒`);
    }
    // 关键不变量：任何"被接受"的路径都必须在语音库目录内
    const accepted = [];
    for (const p of ['ok.mp3', 'ok', '..\\..\\secret-outside.mp3', outside, 'sub/../../x.mp3']) {
      try { accepted.push(h.resolveVoicePathForV2(p).path); } catch {}
    }
    ok(accepted.every((p) => p.startsWith(dir + path.sep)), '被接受的路径全部落在语音库内', `${accepted.length} 个被接受`);
  } finally { await h.close(); }
}

console.log('## 回归：长消息里的 URL 不许被切碎（P1，曾静默丢 URL）');
{
  // 由来：splitLongSegment 用 \u0000URL<n>\u0000 占位符保护 URL，但对超长片段直接按
  // max 硬切，会拦腰切断占位符 → 还原正则失配 → URL 整条消失 + 裸 NUL + 字面量 "URL0"
  // 被发进 QQ 消息。这里把函数从 bridge.js 抽出来，对 1..max+20 所有长度做校验。
  const src = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  const at = src.indexOf('function splitLongSegment');
  ok(at > 0, '在 bridge.js 里找到 splitLongSegment');
  if (at > 0) {
    const endMarker = src.indexOf('\n  }', src.indexOf('return out', at));
    const fnSrc = src.slice(at, endMarker + 4);
    const splitLongSegment = eval(`(${fnSrc})`);   // eslint-disable-line no-eval
    const url = 'https://example.com/very/long/path?q=1&x=2';
    const max = 500;
    let broken = 0;
    const samples = [];
    for (let n = 1; n <= max + 20; n++) {
      const parts = splitLongSegment('啊'.repeat(n) + url, max);
      const joined = parts.join('');
      const bad = !joined.includes(url) || joined.includes('\u0000') || joined.includes('URL0') || joined.includes('URL1');
      if (bad) { broken += 1; if (samples.length < 3) samples.push(`${n}:${JSON.stringify(parts.slice(-2))}`); }
    }
    ok(broken === 0, `1~${max + 20} 所有长度下 URL 都完整、无 NUL 泄漏`, broken ? `${broken} 个损坏，例：${samples.join(' ')}` : `共检查 ${max + 20} 个长度`);
    const worst = Math.max(...splitLongSegment('啊'.repeat(2000) + url, max).map((s) => s.length));
    ok(worst <= max + 40, '分段长度仍在合理范围（占位符不可切的让步）', `最长 ${worst}`);
    const two = splitLongSegment('啊'.repeat(600) + url + '中间' + url, max).join('');
    ok(two.includes(url) && two.split(url).length - 1 === 2, '两个 URL 都保留');
  }
}

console.log('## 回归：AI 通道的语音库响应不许带出绝对路径（P1）');
{
  // 由来：/api/socialV2/voices 的 dir 字段做了 agentCall ? undefined 抑制，
  // 但紧邻的 hint 模板字符串仍然无条件插值 ${voice.dir} —— 绝对路径又从旁边漏给模型了。
  // 这类"字段堵了、文案没堵"的漏法静态查最有效：AI 通道的所有响应字段与文案都不该含盘符/家目录。
  const src = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  const at = src.indexOf("url.pathname === '/api/socialV2/voices'");
  ok(at > 0, '找到 voices 路由');
  const section = src.slice(at, at + 3200);
  ok(/dir: agentCall \? undefined : voice\.dir/.test(section), 'dir 字段对 AI 通道抑制');
  // hint 里对 voice.dir 的插值必须被 agentCall 条件保护
  const hintLine = section.split('\n').find((l) => l.includes('hint:')) ?? '';
  const guarded = /agentCall \?/.test(section.slice(section.indexOf('hint:'), section.indexOf('hint:') + 400));
  ok(guarded, 'hint 里的路径插值同样受 agentCall 保护', hintLine.trim().slice(0, 60));
  // 整个 AI 可见响应体里不得出现盘符路径（粗略但有效的守门）
  const aiVisible = section.slice(0, section.indexOf('} catch'));
  const pathLeaks = [...aiVisible.matchAll(/\$\{[^}]*\.dir[^}]*\}/g)].map((m) => m[0]);
  ok(pathLeaks.every((p) => aiVisible.includes('agentCall ?')), '响应里没有无保护的路径插值');
}

if (process.env.QQ_BRIDGE_TEST_LIVE === '1') {
  console.log('## live：桥接 voice 端点 dry-run');
  if (!fs.existsSync(path.join(ROOT, 'config.json'))) {
    // live 段要打**真的**桥接：端口、consoleToken、白名单群号、语音库目录全部来自
    // 用户本机 config.json。config.example.json 给不出这些（groups 是空的），
    // 硬跑只会得到"前置条件不足"这种假失败 —— 如实跳过（措辞与 skipVoiceTool 同款）。
    console.log('  ⏭  跳过：live 段需要本机 config.json（端口/consoleToken/白名单群号/语音库目录）');
    console.log('     原因：config.json 被 .gitignore（含真实 QQ 号/token），config.example.json 给不出这些值');
    console.log('     想跑这段：先照 config.example.json 建好自己的 config.json，再设 QQ_BRIDGE_TEST_LIVE=1。');
    console.log('     注意：这是**跳过，不是通过** —— 这台机器上没有覆盖到 live 链路。');
  } else {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    const port = Number(cfg.consolePort) || 3100;
    let token = String(cfg.consoleToken ?? '').trim();
    if (!token) {
      try { token = fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim(); } catch {}
    }
    const target = (cfg.allow?.groups ?? [])[0];
    const dir = path.resolve(ROOT, String(cfg.socialV2?.voice?.dir ?? 'audio'));
    const first = listAudioFiles(dir)[0];
    if (!target || !first) {
      ok(false, `live 前置条件不足（目标群 ${target ?? '无'}，语音库文件 ${first ?? '无'}）`);
    } else {
      const res = await fetch(`http://127.0.0.1:${port}/api/voice/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { 'x-console-token': token } : {}) },
        body: JSON.stringify({ target: `group:${target}`, file: first, dryRun: true }),
        signal: AbortSignal.timeout(30000)
      });
      const body = await res.json();
      ok(res.ok && body.ok === true && body.dryRun === true, `dry-run 通过（${body.detail ?? body.error ?? ''}）`);
      ok(body.limits?.maxSeconds > 0, '返回 limits 上限');
      // 白名单外目标必须被拒
      const denied = await fetch(`http://127.0.0.1:${port}/api/voice/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { 'x-console-token': token } : {}) },
        body: JSON.stringify({ target: 'group:100004', file: first, dryRun: true }),
        signal: AbortSignal.timeout(30000)
      });
      ok(denied.status === 403, `白名单外目标被拒（HTTP ${denied.status}）`);
    }
  } catch (e) {
    ok(false, `live 端点检查异常: ${e.message}`);
  }
  }
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
