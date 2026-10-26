#!/usr/bin/env node
/**
 * 强制跑一单主动聊天。
 *
 * 平时的路是「她等 60 秒一次的 tick，还要分数过 55、额度够、不在静默时段、刚聊过就等半小时」，
 * 想验证这条链通不通，不该靠自己发一条 QQ 再等半小时。
 *
 * 这个脚本干两件事：往库里塞一个「已经到期」的话题（到期 35 + 有效 25 = 60 分，
 * 刚好过默认门槛 55），然后打 forceTick 让引擎立刻跑一遍。
 *
 *   node scripts/force-proactive.mjs                       只演练，不发 QQ、不记账
 *   node scripts/force-proactive.mjs --force               演练 + 松开时间与「会话正忙」
 *   node scripts/force-proactive.mjs --send                真调 AI、真发到 QQ
 *   node scripts/force-proactive.mjs --send --force --say  真发，并要她这次必须开口
 *   node scripts/force-proactive.mjs --send "话题内容"      换个话题
 *
 * --force 松开三道：刚聊过要等 30 分钟、3 小时内只主动一次、会话正忙；顺带把评分阈值压到 0
 *   （评分里"以前主动联系过"是 -40，主动过一次就再也凑不够 55 分，强制测试会被自己的历史挡住）。
 *   跑完立刻改回原值（config.json 会被写两次，最终内容不变）。
 *   额度用完了、静默时段、没有会话这几道照旧拦 —— 那是安全阀，测试也不该拆。
 *
 * --say 临时把提示词里「没什么可说就回 [SILENT]」那句换掉。
 *   她判断「现在没什么可说」会回 [SILENT]，引擎按设计就不发 —— 那是正确行为，
 *   但想验证「发出去」这一段，就得让她这次必须开口。
 *
 * 注意：--send 会真的发一条消息到主人手机上，而且会花一次调用额度。
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createProactiveStore } from '../src/proactive/store.mjs';
import { createTopicManager } from '../src/proactive/topic-manager.mjs';

const DIR = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const send = args.includes('--send');
const force = args.includes('--force');
const mustSay = args.includes('--say');
const summary = args.find((a) => !a.startsWith('--')) ?? '（强制测试）她刚才说的那件事还没讲完';

const PORT = 3100;
const CONFIG = path.join(DIR, 'config.json');
const tokenFile = path.join(DIR, 'state', 'console-token');
if (!existsSync(tokenFile)) {
  console.error(`找不到 ${tokenFile}，拿不到控制台令牌。`);
  process.exit(1);
}
const token = readFileSync(tokenFile, 'utf8').trim();
const url = (p) => `http://127.0.0.1:${PORT}${p}?token=${token}`;

/** 只在需要恢复时才读 config.json —— 端点不返回 prompt，只能从文件里拿原值。 */
function readPromptRules() {
  try {
    const raw = JSON.parse(readFileSync(CONFIG, 'utf8'));
    return raw?.socialV2?.proactiveEngine?.prompt?.rules;
  } catch {
    return undefined;
  }
}

async function readStatus() {
  try {
    const res = await fetch(url('/api/socialV2/proactive'));
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

const before = await readStatus();
if (!before) {
  console.error(`连不上桥（127.0.0.1:${PORT}）—— 先把桥启动起来。`);
  process.exit(1);
}

const store = createProactiveStore({ file: path.join(DIR, 'state', 'proactive.db') });
const topics = createTopicManager({ store });

const scope = store.listScopes()[0];
if (!scope) {
  console.error('库里还没有 scope —— 先让她和主人私聊过一次，引擎才知道该跟谁说话。');
  process.exit(1);
}

const recorded = topics.record({ userId: scope.userId, summary, followUpAt: Date.now() - 1000 });
if (!recorded.ok) {
  console.error(`话题没登记上：${recorded.error}`);
  process.exit(1);
}
console.log(`已排入到期话题 ${recorded.topic.id}`);
console.log(`  内容：${recorded.topic.summary}`);
console.log(`  跟着的会话：${scope.dshSessionId}`);

// --force 顺手把评分阈值压到 0：评分里「以前主动联系过」是 -40 分，
// 只要主动过一次，35（到期）+25（有效话题）+15（空闲）-40 就永远只有 35 分，
// 卡在默认门槛 55 底下——测试脚本不该被这个自证循环挡住。
const loose = { idleThresholdMs: 0, minProactiveIntervalMs: 0, ...(force ? { scoreThreshold: 0 } : {}) };
const patchedPolicy = force ? { ...(before.policy ?? {}), ...loose } : undefined;
const originalRules = mustSay ? readPromptRules() : undefined;
const patchedPrompt = mustSay
  ? {
      rules: [
        '这不是她发来的消息，是你自己突然想找她说话。',
        '要求：只说一两句，像人突然想起来才说的那种。别解释你为什么联系她，别复述上面这些信息。',
        '这次是她在测链路，你必须真的说一句话，不要回 [SILENT]。',
      ].join('\n'),
    }
  : undefined;

let body;
try {
  const res = await fetch(url('/api/socialV2/proactive'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      enabled: true,
      dryRun: !send,
      ...(patchedPolicy ? { policy: patchedPolicy } : {}),
      ...(patchedPrompt ? { prompt: patchedPrompt } : {}),
      ...(force ? { forceBusy: true } : {}),
      forceTick: true,
    }),
  });
  body = await res.json().catch(() => null);
  if (!res.ok) {
    console.error(`桥拒绝了这次请求（HTTP ${res.status}）：${JSON.stringify(body)}`);
    process.exit(1);
  }
} catch (error) {
  console.error(`连不上桥（127.0.0.1:${PORT}）：${error?.message ?? error}`);
  process.exit(1);
} finally {
  if (patchedPolicy || patchedPrompt) {
    await fetch(url('/api/socialV2/proactive'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled: before.enabled === true,
        dryRun: before.dryRun !== false,
        ...(patchedPolicy ? { policy: before.policy ?? {} } : {}),
        ...(patchedPrompt ? { prompt: originalRules === undefined ? {} : { rules: originalRules } } : {}),
      }),
    }).catch(() => {});
  }
}

const report = body?.report ?? {};
console.log('');
console.log(send ? '=== 真发模式 ===' : '=== 演练模式（不发 QQ、不记账）===');
console.log(
  JSON.stringify(
    {
      candidates: report.candidates,
      merged: report.merged,
      generated: report.generated,
      calls: report.calls,
      skippedProb: report.skippedProb,
      durationMs: report.durationMs,
      detail: Array.isArray(report.details)
        ? report.details.map((d) => ({ decision: d.decision, blocked: d.blocked, score: d.score, threshold: d.threshold }))
        : [],
    },
    null,
    2,
  ),
);

const detail = Array.isArray(report.details) ? report.details[0] : null;
if (detail?.blocked?.length) {
  console.log('');
  console.log(`没走通：${detail.blocked.join('、')}`);
  const why = {
    'recent-user-message': '刚聊过 —— 加 --force 松开这道',
    cooling: '3 小时内已经主动过一次 —— 加 --force 松开这道',
    'conversation-busy': '她那边的会话还排着队 —— 加 --force 松开这道',
    'daily-limit': '今天的主动消息发满 3 条了',
    'call-limit': '今天的调用额度用完了',
    'quiet-hours': '现在在静默时段（23:00–08:00），改 config 的 policy.quietHours 才能测',
    'no-session': '她还没有会话',
  };
  for (const code of detail.blocked) console.log(`  ${code}：${why[code] ?? '（见 policy.mjs 的 BLOCK）'}`);
  if (detail.blocked.includes('generate-failed')) {
    console.log('  生成阶段失败：她回 [SILENT] 也算这一种（按设计不发）—— 加 --say 让她这次必须开口。');
  }
}
if (report.generated > 0) {
  console.log('');
  console.log(send ? '生成并发出去了，去 QQ 上看。' : '演练通过（真发请加 --send）。');
}
