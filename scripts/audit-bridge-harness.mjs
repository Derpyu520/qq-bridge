// Execute the real bridge initialization/functions against temporary files and fake peers.
// No production config, QQ connection, DSH process, or persistent home is accessed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as markdown from '../src/md-to-plain.js';
import * as sensitive from '../src/sensitive.js';
import * as wait from '../src/v2-wait.js';
import * as safeFetch from '../src/safe-fetch.js';
import * as mediaNormalize from '../src/media-normalize.js';
import * as forward from '../src/forward.js';
import * as slang from '../src/slang-learner.js';
import * as sticker from '../src/sticker-lib.js';
import * as modelPrices from '../src/model-prices.js';
import * as tokenLedger from '../src/token-ledger.js';
import * as voiceLib from '../src/send-voice-lib.js';
import * as presetPrompt from '../src/preset-prompt.js';
import * as stateAcl from '../src/state-acl.mjs';
import * as adminOps from '../src/admin-ops.mjs';
import * as botPerms from '../src/bot-perms.mjs';
import * as socialProfile from '../src/qq-social-profile.mjs';
// 人格卡（normalizeRoleState / mergeRoleState / resolveRoleName …）：bridge.js 顶部
// import 了它，VM 里靠 context 注入提供绑定。**漏注入**的后果不是"少一个功能"：
// readRoleState() 每个请求都调，/api/status 与所有控制台路由会整片 500。
import * as roleCard from '../src/role-card.js';
// 熟悉度计分/档位（person-score）：bridge.js 每条消息都会用到，漏注入会直接 ReferenceError。
import * as personScore from '../src/person-score.mjs';
import * as proactiveScore from '../src/proactive-score.mjs';
import * as quota from '../src/quota.js';
import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import { unwrap, createTurnCollector } from '../src/dsh-client.js';

const root = fileURLToPath(new URL('..', import.meta.url));
export async function bridgeHarness({ config = {}, savedState, files = {}, globals = {} } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-audit-bridge-'));
  fs.mkdirSync(path.join(temp, 'src'));
  fs.mkdirSync(path.join(temp, 'state'));
  fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify({
    // autoDiscover:false —— 端点自愈会去扫本机 LISTENING 端口（execFileSync/netstat），
    // 离线测试不该碰宿主机网络与进程表；关掉后 createDshEndpointWatch 那个分支根本不会求值。
    dsh: { authToken: 'fixture-only', autoDiscover: false }, ownerQQ: 123,
    allow: { private: ['123'], groups: ['456'] }, consolePort: 0,
    consoleToken: 'fixture-console-token', slang: { enabled: false }, ...config,
  }));
  if (savedState) fs.writeFileSync(path.join(temp, 'state/sessions.json'), JSON.stringify(savedState));
  // 额外状态文件（用于测试"启动时读到损坏/旧版文件"这类路径）。
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(temp, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Buffer 必须原样落盘：图片/二进制夹具走 JSON.stringify 会被写成 {"type":"Buffer",…}，
    // 于是「文件存在但内容不是图片」——排查起来像业务 bug，实际是夹具坏了。
    fs.writeFileSync(target, Buffer.isBuffer(content) ? content : (typeof content === 'string' ? content : JSON.stringify(content)));
  }
  const calls = { created: [], archived: [], sent: [], prompts: [], follows: [], cancelled: [], images: [], faces: [], customFaces: [], http: [], qzonePosts: [], stickerDeletes: [] };
  // 语音发送在桥接里是**直接 fetch 网关**（与文本/表情共用 sendChain，但要自己带 record 段），
  // 所以这里给 VM 注入一个记录型 fetch：既不让测试真的发 QQ 消息，又能断言发出的段内容。
  const fakeFetch = async (url, init = {}) => {
    const body = (() => { try { return JSON.parse(init.body ?? '{}'); } catch { return init.body; } })();
    calls.http.push({ url: String(url), body });
    const action = String(url).split('/').pop();
    // fetch_custom_face_detail：同步收藏表情的 HTTP 兜底路径要拿到**数组**（WS 失败时用）。
    if (action === 'fetch_custom_face_detail') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'ok',
          retcode: 0,
          data: [{ emoji_id: 'http-fixture-sticker', resId: 'http-fixture-sticker', url: 'https://public.invalid/http-sticker', md5: 'AABBCCDDEEFF00112233445566778899', desc: 'HTTP 兜底表情' }]
        })
      };
    }
    if (action === 'fetch_ptt_text') {
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { text: 'fixture-transcript' } }) };
    }
    // get_msg：语音落地校验用 —— 回一个带 record 段的消息，模拟真实网关
    if (action === 'get_msg') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'ok',
          retcode: 0,
          data: { message_id: 9001, message: [{ type: 'record', data: { file: 'fixture-record.amr', duration: 3 } }] }
        })
      };
    }
    return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9001 } }) };
  };
  const success = (value) => ({ result: { ok: true, value } });
  // 发说说后让 get_qzone_msg_list 的「最新一条」变成刚发的内容，用于验证回读校验分支。
  const qzoneState = { lastContent: null, lastTid: null };
  const api = {
    events: { follow: (id) => calls.follows.push(id) },
    // settings.describe 的默认桩：没有 qq-mode 命名空间 ⇒ refreshMode() 回退到本地 mode.json。
    // 测试可覆盖它来验证「DSH 设置里的空 ownerQQ 不得覆盖 config.json」等契约。
    settings: {
      describe: async () => success({ namespaces: [] }),
      update: async () => success({ updated: true })
    },
    workspace: {
      create: async () => success({ created: false, workspace: { workspaceId: 'fixture-workspace' } }),
      archiveSession: async ({ sessionId }) => { calls.archived.push(sessionId); return success({}); },
    },
    sessions: {
      create: async (params) => { calls.created.push(params); return success({ sessionId: `fixture-${calls.created.length}` }); },
      selectModel: async () => success({ selected: { provider: 'fixture', model: 'fixture' } }),
      prompt: async (params) => { calls.prompts.push(params); return success({}); },
    },
    respond: async () => success({}),
    stopSessionWork: async (sessionId) => { calls.cancelled.push(sessionId); return { removed: 0 }; },
    callUnary: async (method, params) => { calls.cancelled.push({ method, params }); return success({ accepted: true }); },
  };
  // 表情库夹具：**有状态**——delete_custom_face 会真的把它从列表里拿掉，
  // 这样「删除后回读确认」才能测到（否则同步永远把表情加回来）。
  const stickerState = {
    items: [
      { emoji_id: 'fixture-sticker', resId: 'fixture-sticker', url: 'https://public.invalid/sticker', md5: 'AABBCCDDEEFF00112233445566778899', desc: '测试表情' },
      { emoji_id: 'fixture-sticker-2', resId: 'fixture-sticker-2', url: 'https://public.invalid/sticker2', md5: '11223344556677889900AABBCCDDEEFF', desc: '第二个表情' }
    ],
    deleted: []
  };
  class FakeBot {
    async sendPrivateMessage(id, text) { calls.sent.push({ kind: 'private', id, text }); }
    async sendGroupMessage(id, text) { calls.sent.push({ kind: 'group', id, text }); }
    async getImage({ file }) {
      calls.images.push(file);
      // Valid 1 × 1 PNG, supplied entirely in memory by the fixture gateway.
      return { base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=' };
    }
    async fetchFaceEntity(id) { calls.faces.push(id); return null; }
    async request(action, params = {}) {
      // 群成员列表：v2 读工具 qq_get_group_members 会用到（含 WS 不可用时的 HTTP 兜底路径）。
      if (action === 'get_group_member_list') {
        return {
          status: 'ok', retcode: 0,
          data: [
            { user_id: 111, nickname: '小明', card: '小明', role: 'member' },
            { user_id: 222, nickname: '路人', card: '' },
            { user_id: 123, nickname: '管理员', card: '群主', role: 'owner' }
          ]
        };
      }
      // 群列表：qq_get_prompt 的 groups（名字→key 映射）要用。
      if (action === 'get_group_list') {
        return {
          status: 'ok', retcode: 0,
          data: [
            { group_id: 456, group_name: '测试群' },
            { group_id: 789, group_name: '目标群' }
          ]
        };
      }
      // 单条消息查询：撤回前要验「发送者是不是机器人自己」。
      if (action === 'get_msg') {
        return {
          status: 'ok', retcode: 0,
          data: { message_id: Number(params.message_id), sender: { user_id: 999 } }
        };
      }
      if (action === 'fetch_ptt_text') {
        return { status: 'ok', retcode: 0, data: { text: 'fixture-transcript' } };
      }
      if (action === 'ocr_image') {
        return { status: 'ok', retcode: 0, data: { texts: [{ text: '图片里的字', confidence: 0.9, coordinates: [] }], language: 'zh' } };
      }
      // 机器人自身：管理动作/资料/发说说都要先拿到自己的 QQ 号。
      if (action === 'get_login_info') {
        return { status: 'ok', retcode: 0, data: { user_id: 999, nickname: '测试机器人' } };
      }
      // QQ 资料：qq_get_user_profile 用。返回字段刻意**多于**白名单（uid/企业/电量），
      // 让「不透传未知字段」这条断言真的能测到。
      if (action === 'get_stranger_info') {
        const uid = Number(params.user_id) || 0;
        if (uid === 404) return { status: 'ok', retcode: 0, data: { user_id: 0 } };
        return {
          status: 'ok', retcode: 0,
          data: {
            user_id: uid,
            uid: 'fixture-uid',
            qid: 'fixture-qid',
            nickname: uid === 111 ? '小明' : `用户${uid}`,
            remark: uid === 111 ? '明明' : '',
            sex: uid === 222 ? 'female' : 'male',
            age: 0,
            long_nick: uid === 111 ? '今天也在摸鱼' : '',
            qq_level: 59,
            level: 59,
            reg_time: 1451640197,
            is_vip: false,
            vip_level: 0,
            status: 40,
            batteryStatus: 77,
            qidian_enterprise_name: 'fixture-company'
          }
        };
      }
      // QQ 空间：读自己的说说 / 好友动态 / 发说说（发说说只记录，不真发）。
      if (action === 'get_qzone_msg_list') {
        const nowSec = Math.floor(Date.now() / 1000);
        const list = [];
        if (qzoneState.lastContent) {
          list.push({ tid: qzoneState.lastTid || 'fixture-new', content: qzoneState.lastContent, time: nowSec, comment_num: 0, is_private: false, images: [] });
        }
        list.push(
          { tid: 'tid-1', content: '第一条说说', time: nowSec - 60, comment_num: 1, is_private: false, images: [] },
          { tid: 'tid-2', content: '第二条说说', time: nowSec - 3600, comment_num: 0, is_private: true, images: [{}] }
        );
        return { status: 'ok', retcode: 0, data: { total: list.length, msglist: list } };
      }
      if (action === 'get_qzone_feeds') {
        return {
          status: 'ok', retcode: 0,
          data: {
            feeds: [{
              uin: 111, nickname: '小明', time: Math.floor(Date.now() / 1000) - 120, appid: 311, key: 'feed-key',
              html: '<div class="f-name">小明</div><span>昨天 23:43</span><div class="f-info">海边真好看</div><img src="x.jpg"><span>浏览3次</span>'
            }]
          }
        };
      }
      if (action === 'send_qzone_msg') {
        calls.qzonePosts.push(params);
        qzoneState.lastContent = String(params.content ?? '');
        qzoneState.lastTid = `fixture-tid-${calls.qzonePosts.length}`;
        return { status: 'ok', retcode: 0, data: { tid: qzoneState.lastTid } };
      }
      // 收藏表情的发送通道：桥接优先用它（发出来是表情包而不是图片气泡）。
      if (action === 'send_custom_face') {
        calls.customFaces.push(params);
        return { status: 'ok', retcode: 0, data: { message_id: 9100 } };
      }
      // 收藏表情库：同步 / 收藏 / 改备注 / 删除（有状态，删除后同步不再返回它）。
      if (action === 'fetch_custom_face_detail') {
        return { status: 'ok', retcode: 0, data: stickerState.items.map((item) => ({ ...item })) };
      }
      if (action === 'add_custom_face') {
        calls.customFaces.push(params);
        const emojiId = `fixture-added-${stickerState.items.length + 1}`;
        stickerState.items.push({ emoji_id: emojiId, resId: emojiId, url: `https://public.invalid/${emojiId}`, md5: 'FFEEDDCCBBAA99887766554433221100', desc: '' });
        return { status: 'ok', retcode: 0, data: { emoji_id: emojiId } };
      }
      if (action === 'modify_custom_face') {
        return { status: 'ok', retcode: 0, data: true };
      }
      if (action === 'delete_custom_face') {
        const id = String(params.emoji_id ?? '');
        calls.stickerDeletes.push(id);
        const idx = stickerState.items.findIndex((item) => item.emoji_id === id);
        if (idx < 0) return { status: 'failed', retcode: 100, data: null, wording: '表情不存在' };
        stickerState.items.splice(idx, 1);
        stickerState.deleted.push(id);
        return { status: 'ok', retcode: 0, data: true };
      }
      return { status: 'ok', retcode: 0, data: [{ emoji_id: 'fixture-sticker', url: 'https://public.invalid/sticker' }] };
    }
  }
  let source = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
  // 去掉顶层 import（VM 里靠 context 注入提供这些绑定）。
  // 必须按行处理：这些 import 有**多行**写法，用单行正则（/^import[\s\S]*?;/gm）会在
  // 第一个分号处停下，把紧跟其后的正常代码一起删掉（曾把 `cfg.socialV2.voice = {…}`
  // 整段吞掉，导致语音相关断言在虚拟环境里悄悄失真）。
  source = source.split(/\r?\n/).reduce((acc, line) => {
    if (acc.droppingImport) {
      if (/;\s*$/.test(line)) acc.droppingImport = false;
      return acc;
    }
    if (/^import[\s{*]/.test(line) || /^import\s+['"]/.test(line)) {
      if (!/;\s*$/.test(line)) acc.droppingImport = true;
      return acc;
    }
    acc.out.push(line);
    return acc;
  }, { out: [], droppingImport: false }).out.join('\n');
  source = source.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path.join(temp, 'src/bridge.js')).href));
  source = source.slice(0, source.indexOf("process.on('SIGINT'"));
  source = source.replace('  bot.onPrivateMessage(async (event) => {', `
  return {
    tempDir: ${JSON.stringify(temp)},
    ensureSession, ensureSlangLearnerSession, resolvePresetName, deliverPrompt, drainPromptQueue,
    sendToQQ, sendStickerV2, handleIncoming, startConsoleServer, cfg, state, api, promptQueues,
    getSocialV2State, appendSocialV2Message, recordSentMessagesV2,
    buildWakePromptV2, buildWakeSnapshotV2, sendWakePromptV2, socialV2,
    buildBranchOverviewText, buildBranchSummaryText, resolveBranchKey,
    buildDigestV2, quotaUsageV2, buildDigestSummaryPrompt,
    getStoredDigest, putStoredDigest, formatDigestTextV2, formatDigestRecap, trimWakePromptV2,
    formatMemoryV2, formatPeopleV2,
    parseDocumentBufferV2, readDocumentFromMessageV2,
    rememberSentMessageId, recentSentMessageIds,
    replyPressureV2, formatReplyPressureV2, evaluateWakeTriggerV2, scheduleWakeV2,
    syncStickerLibrary, listStickersForV2, getStickerImageData,
    refreshMode, modeAllowed, trackTurnEvent, replayPendingWakeReasonsV2,
    modePreset, isSocialMode, applySocialConfigForMode,
    collectors, setupSleepTimerV2,
    getInitialPrompt, setInitialPrompt, loadInitialPrompts, formatInitialPromptV2,
    initialPrompts, initialPromptMaxChars,
    extractMediaFromSegments, segmentsToText, fetchOneBotImage, fetchMediaData, resolveMediaList,
    emojiCdnCandidates, getImageDimensions, acceptImageBuffer, MAX_MEDIA_BYTES, bot,
    isConversationBusyV2, v2TurnStartAt, turnLeaseNoted, TURN_BUSY_LEASE_MS,
    settingFromDshNamespace, selfIdentityTextV2, buildWakeReminderPromptV2,
    getMode() { return currentMode; },
    setSelfIdentity(display, id) {
      selfDisplayName = String(display ?? '');
      selfUserId = String(id ?? '');
      selfNickname = selfDisplayName.toLowerCase() || 'deepseek';
    },
    // 测试用：模拟「该会话最近一条消息的发送者是不是 ownerQQ」。
    // 真实链路由 handleIncoming 按进线消息的 user_id 记录；头像预览、私聊直连这类用例
    // 不必为了"管理员刚说过话"真的再进一条 QQ 消息。
    markOwnerSender(key, isOwner) { recordSessionSender(key, isOwner === true); },
    flushQueue, retireSession,
    voiceCfg, voiceLibrary, resolveVoicePathForV2, resolveVoicePathForOperator,
    voiceBudgetCheck, sendVoiceV2, sendVoiceForV2, assertOutboundAuditOk,
    setMode(value) { currentMode = value; },
    // 测试用：模拟「checkDsh 已经和 DSH 确认过模式」。桥接启动后到第一次 checkDsh 成功之间
    // modeConfirmed 是 false，这段窗口里消息只能按原始事件暂存（见 handleIncoming 里的守卫）。
    markModeConfirmed() { modeConfirmed = true; },
    setReady(value) { dshReady = value; },
    setPresets(value) { dshPresetIds = value; dshDefaultPreset = 'standard'; },
    resetEpoch() { sessionEpoch++; },
  };
  bot.onPrivateMessage(async (event) => {`);
  const timers = new Set();
  const context = vm.createContext({
    fs, os, path, http, crypto, fileURLToPath, URL, Buffer, AbortSignal, structuredClone, console: { log() {}, error() {} },
    fetch: fakeFetch,
    // 锁文件探测用（bridge.js 顶层的 consolePortInUse）；
    // 固定桩掉：测试不应该真去 netstat 宿主机。
    execFileSync: () => '',
    // process 桩要带 env：voice-core / bridge 会读 process.env.FFMPEG_PATH、FFPROBE_PATH 等。
    // 之前只给 pid/platform/kill/exit，导致 `process.env.FFMPEG_PATH` 直接抛 TypeError。
    process: { pid: process.pid, platform: process.platform, kill: process.kill, env: {}, exit: (code) => { throw new Error('unexpected exit ' + code); } },
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; },
    clearTimeout, setInterval: () => ({ unref() {} }), clearInterval: () => {},
    NodeApiClient: class { constructor() { return api; } },
    SnowLumaWebSocketClient: FakeBot, text: (s) => s,
    discoverDshLaunchToken: () => '', unwrap, createTurnCollector,
    ...markdown, ...sensitive, ...wait, ...safeFetch, ...forward, ...slang, ...sticker,
    ...modelPrices, ...tokenLedger, ...voiceLib, ...stateAcl, ...presetPrompt, ...adminOps, ...botPerms, ...socialProfile, ...roleCard, ...personScore, ...proactiveScore, ...quota,
    PDFParse, mammoth, XLSX,
    // 桥接的出图出口会调归一化（体积/动图抽帧）：VM 里必须能拿到这几个函数。
    normalizeImageForModel: mediaNormalize.normalizeImageForModel,
    sniffImage: mediaNormalize.sniffImage,
    planNormalization: mediaNormalize.planNormalization,
    planAnimation: mediaNormalize.planAnimation,
    // ACL 收紧会 spawn icacls 去改**真实**文件系统；测试不该做这件事（同理见下面的
    // cleanupTemp / processAudioVolume 桩）。桩成成功，让 hardenStateDirAcl 走正常分支。
    hardenDir: () => ({ ok: true, detail: 'stub' }),
    // 音量靠 ffmpeg；测试环境不该真跑 ffmpeg（也不该在沙箱里 spawn）。
    // 默认桩成"按倍数记账但不转码"，调用方可用 globals 覆盖来断言真实行为。
    processAudioVolume: async (file, { volume = 1, normalize = false, loudness = 'normal' } = {}) => {
      const v = Number(volume);
      const changed = normalize === true || Math.abs(v - 1) > 1e-9;
      return {
        path: changed ? `${file}.vol` : file,
        converted: changed,
        applied: changed,
        volume: normalize ? 1 : v,
        loudness: normalize ? -16 : null,
        mode: normalize ? 'loudnorm' : (changed ? 'volume' : 'original'),
        detail: normalize ? `智能音量（响度归一 ${loudness === 'loud' ? -13 : loudness === 'quiet' ? -20 : -16} LUFS）`
          : (changed ? `音量 ${Math.round(v * 100)}%` : '原始音量')
      };
    },
    cleanupTemp: () => {},
    ...globals,
  });
  // Execute the pure model view in the bridge realm. Its plain-object checks
  // should see the same prototypes as real bridge messages, just as in Node.
  const modelViewSource = fs.readFileSync(path.join(root, 'src/qq-model-view.js'), 'utf8').replace(/^export /gm, '');
  vm.runInContext(`Object.assign(globalThis, (() => { ${modelViewSource}\nreturn { compactModelMessage, compactModelData, serializeModelData, describeAge }; })());`, context);
  vm.runInContext(source + '\nglobalThis.auditReady = main();', context);
  const bridge = await context.auditReady;
  bridge.setPresets(['standard', 'qq-chat', 'qq-chat-v2']);
  bridge.setReady(true);
  return { ...bridge, calls, stickerState, temp, async close() {
    for (const timer of timers) clearTimeout(timer);
    fs.rmSync(temp, { recursive: true, force: true });
  } };
}
