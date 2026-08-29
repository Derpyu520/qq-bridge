// 自测脚本：不依赖 SnowLuma / QQ，只验证 DSH 侧链路——
//   1. 连接 DSH Web API
//   2. 创建一个独立测试会话（不会碰现有会话）
//   3. 通过 events.mux 订阅事件流
//   4. session.prompt 注入一条消息
//   5. 等 agent 回复（turn/end）并打印
// 用法：node src/self-test.js [baseUrl]
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { NodeApiClient, unwrap, createTurnCollector, discoverDshLaunchToken } from './dsh-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

async function main() {
  const baseUrl = process.argv[2] ?? 'http://127.0.0.1:3080';
  let auth;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    auth = {
      token: cfg.dsh?.authToken || discoverDshLaunchToken(),
      header: cfg.dsh?.authHeader,
      prefix: cfg.dsh?.authPrefix
    };
  } catch {}
  const api = new NodeApiClient(baseUrl, undefined, auth);
  const promptText = process.argv[3] ?? '只回复两个字：收到';

  const desc = unwrap(await api.settings.describe({}), 'settings.describe');
  console.log('✅ DSH 连接成功:', JSON.stringify(desc).slice(0, 200));

  // 独立测试会话，cwd 用临时目录
  const cwd = path.join(ROOT, 'state', 'self-test');
  fs.mkdirSync(cwd, { recursive: true });
  const created = unwrap(await api.sessions.create({ cwd }), 'session.create');
  const sessionId = created.sessionId;
  console.log('✅ 测试会话已创建:', sessionId);

  // 先订阅事件流（在 prompt 之前），再注入消息。
  // 必须等 WebSocket 真正 open 后再 prompt，否则 turn 事件可能在连接建立前产生而被漏掉。
  const collector = createTurnCollector();
  let resolveOpened;
  let openTimer;
  const opened = new Promise((resolve, reject) => {
    openTimer = setTimeout(() => reject(new Error('等待 WebSocket open 超时（10s）')), 10_000);
    resolveOpened = () => { clearTimeout(openTimer); resolve(); };
  });
  const stream = api.events.mux({}, undefined, () => resolveOpened());
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待回复超时（60s）')), 60_000);
    (async () => {
      for await (const envelope of stream) {
        const frame = envelope.payload;
        if (frame.type === 'session/event' && frame.sessionId === sessionId) {
          const ended = collector.push(frame.event);
          if (ended) {
            clearTimeout(timer);
            resolve(ended);
            return;
          }
        }
        if (frame.type === 'stream/error') {
          clearTimeout(timer);
          reject(new Error('事件流错误: ' + JSON.stringify(frame.error)));
          return;
        }
      }
    })().catch((error) => { clearTimeout(timer); reject(error); });
  });
  await opened;
  // 新版 DSH 需要显式 follow 该会话，事件才会通过 remote.mux 推过来。
  stream.follow(sessionId);

  const accepted = unwrap(await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] }), 'session.prompt');
  console.log('✅ prompt 已接受:', JSON.stringify(accepted));

  const ended = await done;
  console.log('✅ 回合结束 reason =', ended.reason.kind);
  console.log('🤖 agent 回复:');
  console.log(ended.text || '（无文本）');
  console.log('🎉 自测通过 —— DSH 侧链路可用');
  process.exit(0);
}

main().catch((error) => {
  console.error('❌ 自测失败:', error?.message ?? error);
  process.exit(1);
});
