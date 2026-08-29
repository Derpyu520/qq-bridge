import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { NodeApiClient, unwrap, createTurnCollector, discoverDshLaunchToken } from './src/dsh-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname);

async function main() {
  let auth;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    auth = {
      token: cfg.dsh?.authToken || discoverDshLaunchToken(),
      header: cfg.dsh?.authHeader,
      prefix: cfg.dsh?.authPrefix
    };
  } catch {}
  const api = new NodeApiClient('http://127.0.0.1:3080', undefined, auth);
  const cwd = path.join(ROOT, 'state', 'self-test-v2-wait');
  fs.mkdirSync(cwd, { recursive: true });
  const created = unwrap(await api.sessions.create({ cwd, agentPreset: 'qq-chat-v2' }), 'session.create');
  const sessionId = created.sessionId;
  console.log('SESSION_CREATED', sessionId);

  const stream = api.events.mux({});
  const collector = createTurnCollector();
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待回复超时（120s）')), 120_000);
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

  stream.follow(sessionId);
  const accepted = unwrap(await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: '请只输出你当前可用的工具名列表（JSON 数组），不要调用任何工具，不要发送消息。只输出 JSON。' }] }), 'session.prompt');
  console.log('PROMPT_ACCEPTED', JSON.stringify(accepted).slice(0, 120));
  const ended = await done;
  const text = ended.text || '';
  console.log('TOOLS_TEXT_START');
  console.log(text.slice(0, 3000));
  console.log('TOOLS_TEXT_END');
  const hasWait = text.includes('qq_wait_for_messages');
  console.log('HAS_qq_wait_for_messages=' + hasWait);
  console.log('RESULT=' + (hasWait ? 'WAIT_TOOL_VISIBLE' : 'CHECK_FAILED'));
}

main().catch((e) => { console.error(e); process.exit(1); });
