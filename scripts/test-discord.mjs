import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { DiscordChatClient, discordId, splitDiscordMessage, text } from '../src/discord-client.js';
import { bridgeHarness as sharedHarness } from './audit-bridge-harness.mjs';
const bridgeHarness = (options = {}) => sharedHarness({ ...options, config: { ...options.config, platform: 'discord' } });

const channelId = '1234567890123456701';
const userId = '2234567890123456701';
const botId = '3234567890123456701';
const guildId = '4234567890123456701';
const messageId = '1234567890123456789';
const replyId = '1234567890123456788';

function fixture(overrides = {}) {
  const sent = [], fetched = [];
  const message = (extra = {}) => ({
    id: messageId, channelId, guildId, createdTimestamp: Date.now(),
    author: { id: userId, username: 'tester', bot: false },
    member: { displayName: 'Test member' },
    content: 'Hello Discord', attachments: new Map(), stickers: new Map(), ...extra,
  });
  const channel = {
    id: channelId, guildId, name: 'bot-testing',
    isTextBased: () => true, isDMBased: () => false,
    permissionsFor: () => ({ has: () => true }),
    messages: {
      async fetch(value) {
        fetched.push(value);
        if (typeof value === 'object') return new Map([[messageId, message()]]);
        return message({ id: value });
      },
    },
    async send(payload) {
      sent.push(payload);
      return message({ id: String(BigInt(messageId) + BigInt(sent.length)), author: { id: botId, bot: true }, content: payload.content });
    },
  };
  const client = new EventEmitter();
  Object.assign(client, {
    user: { id: botId, username: 'Bridge Bot' }, isReady: () => true,
    users: { fetch: async (id) => ({ id, bot: false, createDM: async () => ({ ...channel, guildId: null }) }) },
    channels: { fetch: async (id) => { assert.equal(id, channelId); return channel; } },
    guilds: { cache: new Map() }, destroy() {},
  });
  const config = {
    allow: { groups: [channelId], private: [userId] },
    deny: { groups: [], private: [] },
    discord: { guildIds: [guildId], allowDMs: true },
    allowAllWhenEmpty: false, ...overrides,
  };
  const adapter = new DiscordChatClient({ config, client });
  return { adapter, config, sent, fetched, message, channel, client };
}

test('snowflakes retain every digit and reject imprecise numeric input', () => {
  assert.equal(discordId('18446744073709551615'), '18446744073709551615');
  assert.equal(discordId('01234567890123456789'), messageId);
  assert.throws(() => discordId(Number(messageId)), /quoted strings/);
  for (const invalid of ['0', '-1', '1e18', '18446744073709551616', '1'.repeat(40), {}, null]) {
    assert.throws(() => discordId(invalid));
  }
});

test('Discord events preserve mentions, reply IDs, images and sender identity', async () => {
  const { adapter, message } = fixture();
  let received;
  adapter.onGroupMessage((event) => { received = event; });
  await adapter.receive(message({
    content: `Hello <@${botId}>`,
    reference: { messageId: replyId },
    attachments: new Map([['a', { name: 'cat.gif', contentType: 'image/gif', url: 'https://cdn.discordapp.com/attachments/a/cat.gif' }]]),
  }));
  assert.equal(received.group_id, channelId);
  assert.equal(received.message_id, messageId);
  assert.equal(received.sender.user_id, userId);
  assert.equal(received.message[0].data.id, replyId);
  assert.equal(received.message.find((part) => part.type === 'at').data.qq, botId);
  assert.equal(received.message.find((part) => part.type === 'image').data.summary, 'cat.gif');
});

test('inbound ACL, guild restrictions and bot/webhook loop prevention', async () => {
  const { adapter, message, config } = fixture();
  let count = 0;
  adapter.onGroupMessage(() => { count++; });
  for (const extra of [
    { author: { id: botId, bot: true } }, { webhookId: 'webhook' },
    { guildId: '613096260324556819' }, { channelId: '1234567890123456780' },
  ]) await adapter.receive(message(extra));
  assert.equal(count, 0);
  config.deny.groups = [channelId];
  await adapter.receive(message());
  assert.equal(count, 0);
  config.deny.groups = [];
  await adapter.receive(message());
  assert.equal(count, 1);
});

test('DMs are isolated by user ID and honor the DM switch', async () => {
  const { adapter, message, config } = fixture();
  const received = [];
  adapter.onPrivateMessage((event) => { received.push(event); });
  await adapter.receive(message({ guildId: null }));
  assert.equal(received[0].user_id, userId);
  assert.equal(received[0].group_id, undefined);
  config.discord.allowDMs = false;
  await adapter.receive(message({ guildId: null }));
  assert.equal(received.length, 1);
  await assert.rejects(adapter.sendPrivateMessage(userId, text('hello')), /disabled/);
});

test('outbound text splits at the Discord limit without breaking emoji or pinging users', async () => {
  const { adapter, sent } = fixture();
  const content = `${'a'.repeat(1999)}😀${'b'.repeat(2200)} @everyone`;
  await adapter.sendGroupMessage(channelId, text(content));
  assert.ok(sent.length >= 3);
  assert.equal(sent.map((item) => item.content).join(''), content);
  for (const part of sent) {
    assert.ok(part.content.length <= 2000);
    assert.ok(!/[\uD800-\uDBFF]$/.test(part.content));
    assert.deepEqual(part.allowedMentions, { parse: [], repliedUser: false });
  }
  assert.equal(splitDiscordMessage('short')[0], 'short');
});

test('native replies are fetched in the target channel, sent once, and retain the exact ID', async () => {
  const { adapter, sent, fetched } = fixture();
  await adapter.sendGroupMessage(channelId, [
    { type: 'reply', data: { id: replyId } }, ...text('x'.repeat(2100)),
  ]);
  assert.equal(fetched[0], replyId);
  assert.equal(sent[0].reply.messageReference, replyId);
  assert.equal(sent[1].reply, undefined);
});

test('unapproved destinations and unsupported legacy actions fail without a send', async () => {
  const { adapter, sent } = fixture();
  await assert.rejects(adapter.sendGroupMessage('1234567890123456702', text('no')), /allowlist/);
  await assert.rejects(adapter.raw('group_poke', { group_id: channelId }), /unavailable/);
  await assert.rejects(adapter.sendGroupMessage(channelId, [{ type: 'record', data: { file: 'secret.mp3' } }]), /does not support/);
  assert.equal(sent.length, 0);
});

test('history and reply lookups keep channel context and exact message IDs', async () => {
  const { adapter, fetched } = fixture();
  const result = await adapter.raw('get_group_msg_history', { group_id: channelId, message_seq: replyId });
  assert.equal(fetched[0].before, replyId);
  assert.equal(result.messages[0].message_id, messageId);
  const reply = await adapter.getMessage(replyId, { kind: 'group', id: channelId });
  assert.equal(reply.group_id, channelId);
  await assert.rejects(adapter.getMessage('1234567890123456777'), /unknown/);
});

test('a parent channel does not allow its threads; each allowed thread gets its own key', async () => {
  const { adapter, config, message } = fixture();
  const threadId = '1234567890123456710';
  const received = [];
  adapter.onGroupMessage((event) => received.push(event.group_id));
  await adapter.receive(message({ channelId: threadId }));
  assert.deepEqual(received, []);
  config.allow.groups.push(threadId);
  await adapter.receive(message());
  await adapter.receive(message({ channelId: threadId }));
  assert.deepEqual(received, [channelId, threadId]);
});

test('a reply from another channel is rejected, including ACL changes during lookup', async () => {
  const { adapter, config, channel, sent } = fixture();
  const reply = [{ type: 'reply', data: { id: replyId } }, ...text('hello')];
  channel.messages.fetch = async () => ({ channelId: '1234567890123456799' });
  await assert.rejects(adapter.sendGroupMessage(channelId, reply), /different Discord channel/);
  channel.messages.fetch = async () => {
    config.deny.groups.push(channelId);
    return { channelId };
  };
  await assert.rejects(adapter.sendGroupMessage(channelId, reply), /allowlist changed/);
  assert.deepEqual(sent, []);
});

test('the shared send API reaches native Discord with the exact destination snowflake', async () => {
  const { adapter, sent } = fixture();
  const h = await bridgeHarness({
    config: { ownerId: userId, allow: { groups: [channelId], private: [userId] }, sendDelayMs: 0 },
  });
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  h.bot.request = (action, params) => adapter.request(action, params);
  h.bot.getMessage = (id, context) => adapter.getMessage(id, context);
  try {
    h.setMode('reserved2');
    const token = h.getSocialV2State(`group:${channelId}`).agentToken;
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/send/group`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', 'x-console-token': 'fixture-console-token',
        'x-agent-call': '1', 'x-agent-token': token,
      },
      body: JSON.stringify({ groupId: channelId, message: 'Shared send path', replyToMessageId: replyId, token }),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.ok, true);
    assert.equal(sent[0]?.content, 'Shared send path');
    assert.equal(sent[0]?.reply.messageReference, replyId);
    const v2Response = await fetch(`http://127.0.0.1:${server.address().port}/api/socialV2/send-message`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', 'x-console-token': 'fixture-console-token',
        'x-agent-call': '1', 'x-agent-token': token,
      },
      body: JSON.stringify({ key: `group:${channelId}`, messages: 'Native v2 path', replyToMessageId: replyId }),
    });
    assert.equal(v2Response.status, 200, JSON.stringify(await v2Response.json()));
    assert.equal(sent[1]?.content, 'Native v2 path');
    assert.equal(sent[1]?.reply.messageReference, replyId);
    for (const [endpoint, invalid] of [
      ['/api/send/group', { groupId: Number(channelId) }],
      ['/api/send/group', { replyToMessageId: Number(replyId) }],
      ['/api/send/group', { atUserId: Number(userId) }],
      ['/api/socialV2/send-message', { replyToMessageId: Number(replyId) }],
      ['/api/socialV2/send-message', { atUserId: Number(userId) }],
    ]) {
      const rejected = await fetch(`http://127.0.0.1:${server.address().port}${endpoint}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json', 'x-console-token': 'fixture-console-token',
          'x-agent-call': '1', 'x-agent-token': token,
        },
        body: JSON.stringify({
          groupId: channelId, key: `group:${channelId}`,
          message: 'Must not send', messages: 'Must not send', token, ...invalid,
        }),
      });
      assert.equal(rejected.status, 400, JSON.stringify(await rejected.json()));
    }
    assert.equal(sent.length, 2);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
});

test('Discord event -> real bridge prompt -> DSH turn events -> Discord reply', async () => {
  const { adapter, message, sent } = fixture();
  const h = await bridgeHarness({
    config: {
      ownerId: userId, allow: { groups: [channelId], private: [userId] },
      ackMessage: '', sendDelayMs: 0,
    },
  });
  try {
    h.setMode('chat');
    h.bot.sendGroupMessage = (id, content) => adapter.sendGroupMessage(id, typeof content === 'string' ? text(content) : content);
    adapter.onGroupMessage((event) => h.handleIncoming('group', event.group_id, event, h.cfg));
    await adapter.receive(message());
    assert.equal(h.calls.prompts.length, 1);
    const sessionId = h.calls.prompts[0].sessionId;
    assert.ok(JSON.stringify(h.calls.prompts[0]).includes('Hello Discord'));
    h.api.events.mux = async function* () {
      for (const event of [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'Hello from DSH' }] } } },
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      ]) yield { payload: { type: 'session/event', sessionId, event } };
      await new Promise(() => {});
    };
    void h.pumpMux();
    const deadline = Date.now() + 3000;
    while (!sent.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(sent[0]?.content, 'Hello from DSH');
    assert.equal(h.calls.created[0].agentPreset, 'discord-chat');
  } finally { await h.close(); }
});

test('console allowlists retain snowflakes and the Discord read API refuses a send bypass', async () => {
  const h = await bridgeHarness();
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token' };
  try {
    const updated = await fetch(`${endpoint}/api/whitelist`, {
      method: 'POST', headers,
      body: JSON.stringify({ ownerId: userId, allow: { groups: [channelId], private: [userId] } }),
    });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).allow.groups[0], channelId);
    const capabilities = await fetch(`${endpoint}/api/socialV2/config`, {
      method: 'POST', headers,
      body: JSON.stringify({ tools: { sendPoke: true, sendVoice: true }, voice: { enabled: true }, sticker: { enabled: true } }),
    });
    const { config } = await capabilities.json();
    assert.equal(config.tools.sendPoke, false);
    assert.equal(config.tools.sendVoice, false);
    assert.equal(config.voice.enabled, false);
    assert.equal(config.sticker.enabled, false);
    const legacySend = await fetch(`${endpoint}/api/voice/send`, {
      method: 'POST', headers, body: '{}',
    });
    assert.equal(legacySend.status, 501);
    const response = await fetch(`${endpoint}/api/chat/action`, {
      method: 'POST', headers: { ...headers, 'x-agent-call': '1' },
      body: JSON.stringify({ action: 'send_group_msg', params: { group_id: channelId, message: 'bypass' } }),
    });
    assert.equal(response.status, 403);
    assert.equal(h.calls.sent.length, 0);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
});

test('partial console updates preserve access lists loaded through aliases', async () => {
  const blockedUser = '2234567890123456702';
  const blockedChannel = '1234567890123456702';
  const h = await bridgeHarness({
    config: {
      allow: { users: [userId], channels: [channelId] },
      deny: { users: [blockedUser], channels: [blockedChannel] },
    },
  });
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/whitelist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token' },
      body: JSON.stringify({ ownerId: userId }),
    });
    assert.equal(response.status, 200);
    const updated = await response.json();
    assert.deepEqual(updated.allow, { private: [userId], groups: [channelId] });
    assert.deepEqual(updated.deny, { private: [blockedUser], groups: [blockedChannel] });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
});
