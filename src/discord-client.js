import './load-env.js';
import { discordId } from './discord-id.js';
import { EventEmitter } from 'node:events';
import { Client, Events, GatewayIntentBits, Partials, PermissionFlagsBits } from 'discord.js';

export { discordId };

export function text(value) {
  return [{ type: 'text', data: { text: String(value) } }];
}

export function splitDiscordMessage(value, limit = 2000) {
  const chunks = [];
  let remaining = String(value);
  while (remaining.length > limit) {
    let end = remaining.lastIndexOf('\n', limit);
    if (end < limit / 2) end = limit;
    if (/[\uD800-\uDBFF]/.test(remaining[end - 1])) end--;
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function unescapeCq(value) {
  return String(value).replace(/&#91;/g, '[').replace(/&#93;/g, ']')
    .replace(/&#44;/g, ',').replace(/&amp;/g, '&');
}

function memberInfo(user, member) {
  return { user_id: user.id, nickname: user.globalName || user.username, card: member?.displayName || '' };
}

// Keep the bridge's existing conversation/segment model at this boundary.
// All network I/O uses Discord's Gateway and REST client.
export class DiscordChatClient extends EventEmitter {
  constructor({ config = {}, client } = {}) {
    super();
    this.config = config;
    this.client = client || new Client({
      intents: [
        GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
      allowedMentions: { parse: [], repliedUser: false },
      rest: { timeout: 15000, retries: 2 },
    });
    this.url = 'wss://gateway.discord.gg';
    this.messageChannels = new Map();
    this.connecting = null;
    this.heartbeat = null;
    this.client.on(Events.ClientReady, () => {
      this.emit('open');
      this.emit('botStatus', { sub_type: 'online' });
      clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => this.emitHeartbeat(), 30000);
      this.heartbeat.unref?.();
      this.emitHeartbeat();
    });
    this.client.on(Events.MessageCreate, (message) => {
      void this.receive(message).catch((error) => this.emit('error', error));
    });
    this.client.on(Events.ShardDisconnect, (event) => {
      this.emit('close', { code: event.code });
      this.emit('botStatus', { sub_type: 'offline' });
    });
    this.client.on(Events.ShardResume, () => {
      this.emit('open');
      this.emitHeartbeat();
    });
    this.client.on(Events.Error, (error) => this.emit('error', error));
    this.client.on(Events.ShardError, (error) => this.emit('error', error));
  }

  emitHeartbeat() {
    const online = this.client.isReady();
    this.emit('event', { post_type: 'meta_event', meta_event_type: 'heartbeat', status: { online, good: online } });
  }

  connect() {
    if (this.client.isReady()) return Promise.resolve();
    if (this.connecting) return this.connecting;
    const token = String(process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN || this.config.discord?.token || '').trim();
    if (!token) return Promise.reject(new Error('Set DISCORD_TOKEN in .env, then restart.'));
    this.connecting = this.client.login(token).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  close() {
    clearInterval(this.heartbeat);
    return this.client.destroy();
  }

  onPrivateMessage(listener) { this.on('privateMessage', listener); }
  onGroupMessage(listener) { this.on('groupMessage', listener); }
  onEvent(listener) { this.on('event', listener); }
  onBotStatus(listener) { this.on('botStatus', listener); }
  onNotice(type, listener) { this.on(`notice:${type}`, listener); }

  guildAllowed(guildId) {
    const guilds = this.config.discord?.guildIds || [];
    return !guilds.length || guilds.map(String).includes(String(guildId));
  }

  targetAllowed(kind, id) {
    const allow = this.config.allow?.[kind === 'group' ? 'groups' : 'private']
      ?? this.config.allow?.[kind === 'group' ? 'channels' : 'users'] ?? [];
    const deny = this.config.deny?.[kind === 'group' ? 'groups' : 'private']
      ?? this.config.deny?.[kind === 'group' ? 'channels' : 'users'] ?? [];
    return !deny.map(String).includes(id)
      && (allow.length ? allow.map(String).includes(id) : this.config.allowAllWhenEmpty === true);
  }

  remember(message) {
    this.messageChannels.set(message.id, message.channelId);
    if (this.messageChannels.size > 10000) {
      this.messageChannels.delete(this.messageChannels.keys().next().value);
    }
    if (message.reference?.messageId) this.messageChannels.set(message.reference.messageId, message.channelId);
  }

  toEvent(message) {
    this.remember(message);
    const segments = [];
    if (message.reference?.messageId) segments.push({ type: 'reply', data: { id: message.reference.messageId } });
    const content = String(message.content || '');
    const mention = /<@!?(\d+)>/g;
    let start = 0;
    for (const match of content.matchAll(mention)) {
      if (match.index > start) segments.push({ type: 'text', data: { text: content.slice(start, match.index) } });
      segments.push({ type: 'at', data: { qq: match[1] } });
      start = match.index + match[0].length;
    }
    if (start < content.length) segments.push({ type: 'text', data: { text: content.slice(start) } });
    for (const attachment of message.attachments?.values() || []) {
      const image = attachment.contentType?.startsWith('image/')
        || /\.(?:png|jpe?g|gif|webp|avif)(?:$|\?)/i.test(attachment.name || '');
      segments.push(image
        ? { type: 'image', data: { file: attachment.url, url: attachment.url, summary: attachment.name, sub_type: 0 } }
        : { type: 'text', data: { text: `\n[Attachment: ${attachment.name || 'file'}] ${attachment.url}` } });
    }
    for (const sticker of message.stickers?.values() || []) {
      if (sticker.url) segments.push({ type: 'image', data: { url: sticker.url, file: sticker.url, summary: sticker.name } });
    }
    return {
      post_type: 'message', message_type: message.guildId ? 'group' : 'private',
      self_id: this.client.user?.id, user_id: message.author.id,
      ...(message.guildId ? { group_id: message.channelId, guild_id: message.guildId } : {}),
      message_id: message.id, message: segments, raw_message: content,
      time: Math.floor(message.createdTimestamp / 1000),
      sender: memberInfo(message.author, message.member),
    };
  }

  async receive(message) {
    if (message.author?.bot || message.webhookId || message.system) return;
    const kind = message.guildId ? 'group' : 'private';
    const id = kind === 'group' ? message.channelId : message.author.id;
    if (!this.targetAllowed(kind, id) || (message.guildId && !this.guildAllowed(message.guildId))) return;
    if (!message.guildId && this.config.discord?.allowDMs === false) return;
    const event = this.toEvent(message);
    this.emit('event', event);
    const name = kind === 'group' ? 'groupMessage' : 'privateMessage';
    for (const listener of this.listeners(name)) await listener(event);
  }

  async channel(kind, value) {
    const id = discordId(value);
    if (!this.targetAllowed(kind, id)) throw new Error(`Discord ${kind}:${id} is outside the allowlist.`);
    if (kind === 'private') {
      if (this.config.discord?.allowDMs === false) throw new Error('Discord direct messages are disabled.');
      const user = await this.client.users.fetch(id);
      if (user.bot) throw new Error('Direct messages to other bots are disabled.');
      return user.createDM();
    }
    const channel = await this.client.channels.fetch(id);
    if (!channel?.guildId || !channel.isTextBased() || channel.isDMBased?.() || !channel.messages) {
      throw new Error('Use a Discord text channel or thread ID.');
    }
    if (!this.guildAllowed(channel.guildId)) throw new Error('Discord server is outside discord.guildIds.');
    const permissions = channel.permissionsFor?.(this.client.user);
    if (permissions && !permissions.has(PermissionFlagsBits.ViewChannel)) throw new Error('Bot cannot view this Discord channel.');
    return channel;
  }

  async send(kind, value, message) {
    const channel = await this.channel(kind, value);
    const segments = typeof message === 'string' ? text(message) : (Array.isArray(message) ? message : [message]);
    const body = [];
    const files = [];
    let reply;
    for (const segment of segments) {
      const data = segment?.data || {};
      if (segment?.type === 'text') body.push(unescapeCq(data.text || ''));
      else if (segment?.type === 'at') body.push(`<@${discordId(data.qq)}>`);
      else if (segment?.type === 'reply') reply = discordId(data.id);
      else if (segment?.type === 'image') {
        const file = String(data.file || data.url || '');
        if (!file.startsWith('base64://')) throw new Error('Outgoing images must be downloaded and checked by the bridge first.');
        files.push({ attachment: Buffer.from(file.slice(9), 'base64'), name: `image-${files.length + 1}.png` });
      } else throw new Error(`Discord does not support the legacy ${segment?.type} action.`);
    }
    if (reply) {
      // A Discord reply must belong to the target channel, even after a restart.
      const original = await channel.messages.fetch(reply);
      if (original.channelId !== channel.id) throw new Error('Reply belongs to a different Discord channel.');
    }
    const chunks = splitDiscordMessage(body.join(''));
    if (!chunks.length && files.length) chunks.push('');
    if (!chunks.length) throw new Error('Cannot send an empty Discord message.');
    let result;
    for (const [index, content] of chunks.entries()) {
      if (!this.targetAllowed(kind, discordId(value))) throw new Error('Discord allowlist changed before send.');
      if (kind === 'private' && this.config.discord?.allowDMs === false) throw new Error('Discord direct messages are disabled.');
      if (channel.guildId && !this.guildAllowed(channel.guildId)) throw new Error('Discord server is outside discord.guildIds.');
      result = await channel.send({
        ...(content ? { content } : {}),
        allowedMentions: { parse: [], repliedUser: false },
        ...(index === 0 && reply ? { reply: { messageReference: reply, failIfNotExists: true } } : {}),
        ...(index === 0 && files.length ? { files } : {}),
      });
      this.remember(result);
    }
    return { message_id: result.id };
  }

  sendPrivateMessage(id, message) { return this.send('private', id, message); }
  sendGroupMessage(id, message) { return this.send('group', id, message); }
  async getLoginInfo() {
    return this.client.user ? memberInfo(this.client.user) : { user_id: null, nickname: null };
  }

  async getMessage(id, context = {}) {
    const messageId = discordId(id);
    let channel;
    if (context.kind && context.id) channel = await this.channel(context.kind, context.id);
    else {
      const channelId = this.messageChannels.get(messageId);
      if (!channelId) throw new Error('Message channel is unknown. Read recent messages in this conversation first.');
      channel = await this.client.channels.fetch(channelId);
      if (channel.guildId) channel = await this.channel('group', channel.id);
      else {
        const recipient = channel.recipient?.id;
        if (!recipient) throw new Error('Cannot identify the direct message recipient.');
        channel = await this.channel('private', recipient);
      }
    }
    return this.toEvent(await channel.messages.fetch(messageId));
  }

  async getGroupMemberInfo(channelId, userId) {
    const channel = await this.channel('group', channelId);
    const member = await channel.guild.members.fetch(discordId(userId));
    return memberInfo(member.user, member);
  }

  async getGroupMemberList(channelId) {
    const channel = await this.channel('group', channelId);
    // Use visible recent participants; no privileged GuildMembers intent is needed.
    const recent = await channel.messages.fetch({ limit: 100 });
    const members = new Map();
    for (const message of recent.values()) {
      if (!message.author.bot) members.set(message.author.id, memberInfo(message.author, message.member));
    }
    return [...members.values()];
  }

  async getImage({ file }) {
    const url = new URL(file);
    if (!['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname) || url.protocol !== 'https:') {
      throw new Error('Image metadata is only available for Discord CDN attachments.');
    }
    return { url: url.href };
  }

  async raw(action, params = {}) {
    switch (action) {
      case 'get_login_info': return this.getLoginInfo();
      case 'get_status': return { online: this.client.isReady(), good: this.client.isReady() };
      case 'send_private_msg': return this.sendPrivateMessage(params.user_id, params.message);
      case 'send_group_msg': return this.sendGroupMessage(params.group_id, params.message);
      case 'get_msg': return this.getMessage(params.message_id, params.context);
      case 'get_group_member_info': return this.getGroupMemberInfo(params.group_id, params.user_id);
      case 'get_group_member_list': return this.getGroupMemberList(params.group_id);
      case 'get_group_msg_history': {
        const channel = await this.channel('group', params.group_id);
        const messages = await channel.messages.fetch({
          limit: Math.max(1, Math.min(100, Number(params.count) || 30)),
          ...(params.message_seq ? { before: discordId(params.message_seq) } : {}),
        });
        return { messages: [...messages.values()].reverse().map((message) => this.toEvent(message)) };
      }
      case 'get_group_list': {
        const result = [];
        for (const guild of this.client.guilds.cache.values()) {
          if (!this.guildAllowed(guild.id)) continue;
          const channels = await guild.channels.fetch();
          for (const channel of channels.values()) {
            if (channel?.isTextBased() && channel.messages && this.targetAllowed('group', channel.id)
              && channel.permissionsFor(this.client.user)?.has(PermissionFlagsBits.ViewChannel)) {
              result.push({ group_id: channel.id, group_name: `${guild.name} / #${channel.name}` });
            }
          }
        }
        return result;
      }
      default: throw new Error(`The legacy action "${action}" is unavailable on Discord.`);
    }
  }

  async request(action, params) {
    return { status: 'ok', retcode: 0, data: await this.raw(action, params) };
  }
}
