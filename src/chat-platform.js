import { discordId } from './discord-id.js';

export const DISCORD_UNAVAILABLE_TOOLS = new Set([
  'sendPoke', 'getForwardMsg', 'listStickers', 'getStickerImage', 'sendSticker',
  'setStickerRemark', 'stickerNote', 'collectSticker', 'getSelfImage', 'sendVoice',
]);

export function chatPlatform(config = {}) {
  const platform = Object.hasOwn(config, 'platform') ? config.platform : 'qq';
  if (!['qq', 'discord'].includes(platform)) {
    throw new Error('platform must be "qq" or "discord".');
  }
  return platform;
}

// QQ's SDK expects numbers. Discord snowflakes must never pass through Number.
export function platformId(value, platform = 'qq') {
  if (platform !== 'discord') return Number(value);
  try { return discordId(value); } catch (error) {
    error.statusCode = 400;
    throw error;
  }
}

export function validPlatformId(value, platform = 'qq') {
  if (platform === 'discord') {
    try { discordId(value); return true; } catch { return false; }
  }
  return Number.isFinite(value) && value > 0;
}

export function applyPlatformCapabilities(config) {
  if (chatPlatform(config) !== 'discord') return config;
  config.socialV2.tools = { ...config.socialV2.tools };
  for (const flag of DISCORD_UNAVAILABLE_TOOLS) config.socialV2.tools[flag] = false;
  config.socialV2.sticker = { ...config.socialV2.sticker, enabled: false };
  config.socialV2.voice = { ...config.socialV2.voice, enabled: false };
  return config;
}

// Optional dependency: QQ installations do not load discord.js.
export async function createDiscordChatClient(config) {
  const { DiscordChatClient } = await import('./discord-client.js');
  return new DiscordChatClient({ config });
}
