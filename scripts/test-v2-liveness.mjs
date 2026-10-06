// reserved2 会话活性回归。
//
// 这三处各自对应过一次真实事故（2026-10-07），而且都是「日志里看着人畜无害、
// 实际会话已经废掉」的形态，所以必须钉住：
//
//   1. 长轮询的传输层：走 fetch 就会被 undici 默认 300s headersTimeout 打死，
//      而等待预算默认允许 600s ⇒ 任何 >5 分钟的等待必然在第 301 秒失败。
//   2. 等待被占用时的拒绝语义：必须告诉模型「还要等多久、别立刻重试」。
//      旧文案只说「请等待它结束」，模型只会立刻重试 —— 那次事故里它空转了 13 步，
//      每一步都带着十几万到几十万 token 的上下文。
//   3. 「会话繁忙」判定必须有上限，且 `turn/end` 之后被杂散事件重建出来的、
//      没有 turn/start 时间戳的残留 collector 不得把会话永久判成 busy。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const mcpSource = fs.readFileSync(path.join(root, 'src/mcp-snowluma-safe.js'), 'utf8');
const bridgeSource = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');

test('长轮询必须走 node:http，不得走 fetch（undici 默认 300s headersTimeout）', () => {
    assert.ok(/function postJsonLongPoll/.test(mcpSource), '必须存在长轮询专用传输');
    assert.ok(/http\.request\(/.test(mcpSource), '长轮询传输必须基于 node:http');
    // 传输函数体内不得出现 fetch：它没有默认超时，但 fetch 有。
    const from = mcpSource.indexOf('function postJsonLongPoll');
    const to = mcpSource.indexOf('async function agentApiLongPoll', from);
    assert.ok(from > 0 && to > from, '必须能定位到长轮询传输与其封装');
    const transport = mcpSource.slice(from, to);
    assert.ok(!/\bfetch\s*\(/.test(transport), '长轮询传输体内不得调用 fetch');

    // 等待工具必须使用长轮询传输，且不再使用 fetch 版 agentApi。
    assert.ok(mcpSource.includes("agentApiLongPoll('/api/socialV2/wait'"),
      'qq_wait_for_messages 必须走 agentApiLongPoll');
    assert.ok(!mcpSource.includes("agentApi('/api/socialV2/wait'"),
      'qq_wait_for_messages 不得再用基于 fetch 的 agentApi');
});

test('「会话繁忙」判定必须有上限，残留 collector 不得把会话永久卡住', () => {
    assert.ok(/const TURN_BUSY_LEASE_MS = /.test(bridgeSource), '必须有 busy 租约常量');
    const from = bridgeSource.indexOf('function conversationBusyReasonV2');
    assert.ok(from > 0, 'busy 判定必须能给出原因串（旧版只有布尔值，日志里看不出是哪条信号）');
    const fn = bridgeSource.slice(from, from + 2600);
    assert.ok(/TURN_BUSY_LEASE_MS/.test(fn), 'busy 判定必须使用租约');
    assert.ok(/collectors\.has\(sid\)/.test(fn), '必须仍然考虑「回合在跑」的 collector');
    // 没有 turn/start 时间戳 ⇒ 必须是 turn/end 之后被重建的残留，不能据此判 busy。
    assert.ok(!/if \(!since\) return true;/.test(fn),
      '无时间戳的残留 collector 不得被判成 busy（这正是会话永久卡死的那条路径）');
    // 重连恢复出来的回合同样要带起始时间，否则租约对它无从生效。
    assert.ok(/collectors\.set\(sessionId, collector\);[\s\S]{0,400}?v2TurnStartAt\.set\(sessionId, Date\.now\(\)\)/.test(bridgeSource),
      'rebuildInFlightCollector 恢复的回合必须补上起始时间');
});

test('agent 回合出错必须同时落本地日志（否则只能让用户从 QQ 把错误抄回来）', () => {
    const at = bridgeSource.indexOf("ended.reason.kind === 'error'");
    assert.ok(at > 0, '必须能定位到回合出错分支');
    const block = bridgeSource.slice(at, at + 1200);
    assert.ok(/log\(`agent 处理出错/.test(block), '出错分支必须写 bridge.log');
    assert.ok(/appendActivity\(/.test(block), '出错分支必须写活动流水');
});

async function waitFixture() {
    const h = await bridgeHarness({ config: { socialV2: {
        wake: { preSleepWaitEnabled: true, preSleepWaitMs: 300000 },
        wait: { minMs: 100, maxMs: 600000, minQuietAfterNewMs: 100 },
        proactive: { enabled: false }, sticker: { enabled: false },
    } } });
    h.setMode('reserved2');
    const key = 'group:456';
    const st = h.getSocialV2State(key);
    const server = h.startConsoleServer();
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const post = (route, body) => new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1', port: server.address().port,
            path: `/api/socialV2/${route}`, method: 'POST',
            headers: {
                'x-console-token': 'fixture-console-token',
                'x-agent-token': st.agentToken,
                'content-type': 'application/json'
            }
        }, (res) => {
            let raw = '';
            res.on('data', (chunk) => { raw += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(raw) }));
        });
        req.on('error', reject);
        req.end(JSON.stringify(body));
    });
    return { h, key, post, server };
}

test('并发等待：第二个被拒时要说清「还要等多久」并劝阻立刻重试', async () => {
    const { h, key, post, server } = await waitFixture();
    try {
        const first = post('wait', { key, purpose: 'messages', timeoutMs: 1500, quietMs: 100 });
        await new Promise((resolve) => setTimeout(resolve, 150)); // 让第一个真正进入等待
        const second = await post('wait', { key, purpose: 'messages', timeoutMs: 200, quietMs: 100 });
        assert.equal(second.status, 429, '同一会话的第二个等待必须被拒绝');
        assert.ok(Number.isFinite(second.data.retryAfterMs) && second.data.retryAfterMs > 0,
            '必须给出 retryAfterMs：模型不知道还要等多久就会立刻重试，把上下文空转烧掉');
        assert.ok(/不要立刻重试/.test(String(second.data.error)), '文案必须明确劝阻立刻重试');
        assert.ok(typeof second.data.hint === 'string' && second.data.hint.length > 0,
            '必须给出可执行的替代动作（静候观察窗口自然届满）');
        await first;
    } finally {
        // 不关 server 进程不会退出（既有测试也是这么收尾的）。
        await new Promise((resolve) => server.close(resolve));
        await h.close();
    }
});

test('会话繁忙时唤醒进 pendingWakeReasons，不能丢', async () => {
    const h = await bridgeHarness({ config: { socialV2: {
        proactive: { enabled: false }, sticker: { enabled: false },
    } } });
    try {
        h.setMode('reserved2');
        const key = 'group:456';
        h.getSocialV2State(key);
        // 制造 busy：promptQueues 里有一个在跑的投递（conversationBusyReasonV2 的 signal 之一）。
        h.promptQueues.set(key, { queue: [{}], running: true });
        await h.sendWakePromptV2(key, 'atMention');
        const after = h.getSocialV2State(key);
        assert.ok(Array.isArray(after.pendingWakeReasons)
            && after.pendingWakeReasons.some((r) => r && r.reason === 'atMention'),
            '繁忙期间的唤醒必须被暂存，等回合结束后补发');
    } finally {
        await h.close();
    }
});
