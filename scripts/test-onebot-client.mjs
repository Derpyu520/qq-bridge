import assert from 'node:assert/strict';
import test from 'node:test';
import { OneBotWebSocketClient, text } from '../src/onebot-client.js';

class FakeWebSocket {
  static last = null;

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    FakeWebSocket.last = this;
  }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  send(raw) {
    this.sent = raw;
    const request = JSON.parse(raw);
    this.emit('message', {
      data: JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 42 }, echo: request.echo })
    });
  }

  close(code = 1000, reason = '') {
    this.readyState = 3;
    this.emit('close', { code, reason });
  }
}

function openClient(options = {}) {
  const bot = new OneBotWebSocketClient({
    url: 'ws://127.0.0.1:3001/',
    accessToken: 'test-token',
    reconnect: false,
    webSocket: FakeWebSocket,
    ...options
  });
  const connected = bot.connect();
  FakeWebSocket.last.readyState = 1;
  FakeWebSocket.last.emit('open');
  return { bot, connected };
}

test('连接时把 access_token 写入 URL', async () => {
  const { bot, connected } = openClient();
  await connected;
  assert.match(FakeWebSocket.last.url, /access_token=test-token/);
  bot.close();
});

test('发送文本消息并解析响应信封', async () => {
  const { bot, connected } = openClient();
  await connected;
  const data = await bot.sendPrivateMessage(10001, text('你好'));
  const request = JSON.parse(FakeWebSocket.last.sent);
  assert.equal(request.action, 'send_private_msg');
  assert.equal(request.params.user_id, 10001);
  assert.deepEqual(request.params.message, [{ type: 'text', data: { text: '你好' } }]);
  assert.equal(data.message_id, 42);
  bot.close();
});

test('分发私聊、通知与 bot_status 事件', async () => {
  const { bot, connected } = openClient();
  await connected;
  const seen = [];
  bot.onPrivateMessage((event) => seen.push(['private', event.user_id]));
  bot.onNotice('notify', (event) => seen.push(['notify', event.target_id]));
  bot.onBotStatus((event) => seen.push(['status', event.sub_type]));
  bot.onEvent((event) => seen.push(['event', event.post_type]));

  FakeWebSocket.last.emit('message', { data: JSON.stringify({ post_type: 'message', message_type: 'private', user_id: 7 }) });
  FakeWebSocket.last.emit('message', { data: JSON.stringify({ post_type: 'notice', notice_type: 'notify', target_id: 8 }) });
  FakeWebSocket.last.emit('message', { data: JSON.stringify({ post_type: 'notice', notice_type: 'bot_status', sub_type: 'online', user_id: 9 }) });
  assert.deepEqual(seen, [
    ['private', 7],
    ['event', 'message'],
    ['notify', 8],
    ['event', 'notice'],
    ['status', 'online'],
    ['event', 'notice']
  ]);
  bot.close();
});

test('动作失败时拒绝并保留响应信封', async () => {
  const { bot, connected } = openClient();
  await connected;
  FakeWebSocket.last.send = (raw) => {
    const request = JSON.parse(raw);
    FakeWebSocket.last.emit('message', {
      data: JSON.stringify({ status: 'failed', retcode: 100, echo: request.echo })
    });
  };
  await assert.rejects(() => bot.getLoginInfo(), (error) => {
    assert.equal(error.name, 'OneBotApiError');
    assert.equal(error.response.retcode, 100);
    return true;
  });
  bot.close();
});
