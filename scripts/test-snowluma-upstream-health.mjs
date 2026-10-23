// SnowLuma 上游健康与客户端库版本的登记期回归。
//
// 为什么需要这个文件
// ------------------
// 真实发生过的误诊：SnowLuma 的原生 `[Hook]` 收不到 QQ 数据时，它的进程与 OneBot
// WebSocket **都还活着**，于是桥接这边一切正常（WebSocket 通、日志打过「SnowLuma 已连接」），
// 但群里一条消息都不来。**桥接当时对这个状态没有任何观测**：没有状态字段、没有看门狗、
// 没有控制台指示、文档里也没有对应排查分支 —— 于是它被报成「qq-bridge 注入失败」。
//
// 这个文件把「桥接必须观测上游健康」这件事固定下来，并盯住几处**容易静默退化**的地方：
//   ① 客户端库版本：`bot_status` 是 SnowLuma 1.14.17 才有的，库低于此就永远收不到；
//   ② 订阅面：`onEvent` / `onBotStatus` 一旦被删掉，静默检测与账号上下线判断会无声失效；
//   ③ 上报面：`/api/status` 的 `snowluma` 字段与控制台的告警条/卡片；
//   ④ 端点自愈的开关：`followDiscoveredEndpoint` 默认必须仍是「跟随」（保持既有行为），
//      但要真的能关掉（多实例/多账号场景，实测踩过：指向死端口仍被自愈改回真实端点）。
//
// 同时校验一条**依赖契约**：`@snowluma/*` 的 npm 发布版有 ESM 扩展名 bug，必须靠
// postinstall 补丁才能被纯 Node ESM 解析。上游若哪天修好了，这个测试会提醒我们补丁可以退休。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
const consoleHtml = fs.readFileSync(path.join(ROOT, 'public', 'console.html'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));

/** 只要可执行代码：注释里会大段解释这些名字（直接扫原文会把说明当成实现）。 */
const codeOf = (src) => src
  // 顺序很重要：先剥行注释，再剥块注释。行注释里出现的 `/*`（例如 `/api/send/*`）
  // 若先做块注释扫描，会被当成块注释开头、一路吞到后面某个 `*/` —— 实测吞掉过
  // 二十多万字符的代码，让本文件的断言对着"不存在的源码"误报。
  .split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const bridgeCode = codeOf(bridge);

test('本地 OneBot 客户端不再依赖 @snowluma/*', () => {
  assert.equal(pkg.dependencies?.['@snowluma/sdk'], undefined, '@snowluma/sdk 不应再出现在 dependencies');
  assert.equal(pkg.dependencies?.['@snowluma/mcp'], undefined, '@snowluma/mcp 不应再出现在 dependencies');
  assert.equal(pkg.scripts?.postinstall, undefined, '不再需要 patch-snowluma-sdk 的 postinstall');
  assert.ok(fs.existsSync(path.join(ROOT, 'src', 'onebot-client.js')), '本地 OneBot 客户端文件应存在');
  assert.match(bridgeCode, /from '\.\/onebot-client\.js'/, 'bridge 应接入本地 OneBot 客户端');
});

test('本地 OneBot 客户端可被纯 Node ESM 解析', async () => {
  const sdk = await import('../src/onebot-client.js');
  assert.equal(typeof sdk.OneBotWebSocketClient, 'function', 'OneBotWebSocketClient 应可导入');
  assert.equal(typeof sdk.text, 'function', 'text 消息构造器应可导入');
});

test('桥接订阅了「上游还活着」的证据（onEvent）', () => {
  assert.match(bridgeCode, /bot\.onEvent\(/, '必须用 onEvent 旁路统计上游事件包（静默检测的依据）');
  assert.match(bridgeCode, /noteUpstreamPacket\(/, 'onEvent 回调必须记账到 noteUpstreamPacket');
});

test('桥接订阅了 bot_status（账号上下线），且对老运行时优雅降级', () => {
  assert.match(bridgeCode, /bot\.onBotStatus\(/, '必须订阅 bot_status');
  // 老运行时不会发这个事件；订阅调用被 try 包住，失败只提示不致命
  assert.match(bridgeCode, /bot_status 订阅不可用/, '订阅失败必须明确提示（老运行时应优雅降级）');
});

test('good 取自心跳 status.good / get_status —— 绝不能取自 get_login_info', () => {
  // 这是本文件存在的最重要理由。SnowLuma 的字段分布（实测核对过 1.14.9 运行时源码）：
  //   get_login_info → 只有 { user_id, nickname }
  //   get_status     → { online, good }
  //   30 秒一次的心跳载荷 → status: { online, good: online && receiveHealthy }
  // 而 SDK **只校验 status/retcode 信封、不校验 data 载荷**，所以取错字段不会报错 ——
  // 它只会让 good 永远停在 null，把"权威信号"变成一条永不触发的死分支。
  // 本文件第一版就是这么写错的（health 代码的第一次实现整条 dead code），故立此断言。
  assert.match(bridgeCode, /\/get_status/, '必须轮询 get_status 拿 online/good');
  assert.match(bridgeCode, /body\.data\?\.good/, 'get_status 的 good 必须被读取');
  // 主信号：心跳里的 status.good（免费、30 秒一次、老运行时也有）
  assert.match(bridgeCode, /meta_event_type === 'heartbeat'/, '必须识别 meta_event/heartbeat');
  assert.match(bridgeCode, /event\.status\?\.good/, '必须从心跳载荷读 status.good（主信号）');
  assert.match(bridgeCode, /noteReceiveHealth\(/, '心跳/轮询都必须经 noteReceiveHealth 归一记录');
  // 反面：不得再从 get_login_info 取 good
  const loginCall = bridgeCode.slice(
    Math.max(0, bridgeCode.indexOf('/get_login_info') - 400),
    bridgeCode.indexOf('/get_login_info') + 900,
  );
  assert.ok(loginCall.length > 0, '应能定位 get_login_info 调用点');
  assert.ok(
    !/good/.test(loginCall.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')),
    'get_login_info 的返回里没有 good —— 不要从它身上取（会静默失效）。'
    + '若要昵称就用它，要 online/good 就用 get_status 或心跳。',
  );
});

test('静默检测不得声称能判断 hook 死活（心跳是本地生成的）', () => {
  // SnowLuma 的心跳由**它自己的定时器无条件**发出（HEARTBEAT_INTERVAL = 3e4），
  // 不经过 QQ 事件流水线。所以「没有事件包」只能证明 SnowLuma 进程/WS 卡住了，
  // **不能**证明它的 [Hook] 收不到 QQ 数据 —— 那个只能靠 status.good。
  // 措辞若写成"沉默=hook 死了"，运维会被引到错误的结论上。
  const silentHint = bridgeCode.slice(
    bridgeCode.indexOf('else if (silent)'),
    bridgeCode.indexOf('else if (silent)') + 420,
  );
  assert.ok(silentHint.length > 0, '应能定位静默分支的提示文案');
  assert.ok(
    !/\[Hook\]/.test(silentHint),
    '静默分支不得把结论指向 [Hook]（心跳会一直来，沉默说明的是进程/WS 层面）',
  );
  assert.match(silentHint, /心跳/, '静默分支应点明"连心跳都没有"，把结论落在进程/WS 上');
});

test('/api/status 暴露 snowluma 健康快照，且只给操作者', () => {
  assert.match(bridgeCode, /snowluma: snowlumaHealthSnapshot\(\)/, '/api/status 必须带 snowluma 字段');
  // 智能体视图（带 x-agent-token 的那支）不得包含它
  const agentBranch = bridgeCode.slice(
    bridgeCode.indexOf("req.headers['x-agent-token'] || req.headers['x-agent-call'] !== undefined"),
    bridgeCode.indexOf('snowluma: snowlumaHealthSnapshot()'),
  );
  assert.ok(agentBranch.length > 0, '应能定位智能体分支与操作者分支');
  assert.ok(
    !/snowluma\s*:/.test(agentBranch),
    '受限的智能体视图不得带 snowluma 诊断字段（那是管理侧观测）',
  );
});

test('控制台有对应的告警条与卡片', () => {
  assert.match(consoleHtml, /id="snowlumaWarn"/, '控制台应有 SnowLuma 告警条');
  assert.match(consoleHtml, /renderSnowlumaHealth\(/, '告警条必须被接线到 /api/status 的渲染路径');
  assert.match(consoleHtml, /\[Hook\]/, '告警文案必须把排查方向指向 SnowLuma 的 [Hook] 日志');
});

test('端点自愈可关，且默认保持「跟随」（向后兼容）', () => {
  assert.match(
    bridgeCode,
    /cfg\.snowluma\?\.followDiscoveredEndpoint !== false/,
    '必须支持 snowluma.followDiscoveredEndpoint 关闭端点跟随',
  );
  assert.equal(
    example.snowluma?.followDiscoveredEndpoint, true,
    '示例配置里默认值必须是 true —— 关闭会改变既有自愈行为，不能悄悄改默认',
  );
  // 关掉时不得把发现的端点写回文件
  assert.match(
    bridgeCode,
    /\.\.\.\(followEndpoint \? \{ wsUrl, httpUrl: r\.baseUrl \} : \{\}\)/,
    '关闭跟随时不得把 wsUrl 写回 config.json（否则"我设了别处"会被持久化抹掉）',
  );
  assert.equal(typeof example.snowluma?.silenceWarnMs, 'number', '示例配置应记录静默告警阈值');
});
