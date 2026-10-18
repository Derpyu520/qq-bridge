# Optional Discord transport

The default transport remains QQ/SnowLuma. Set `"platform": "discord"` to use
Discord's bot Gateway and REST API instead. One checkout runs one transport.
Use separate checkouts, console ports and DSH profiles for simultaneous bots.

Discord uses the same session routing, allowlists, outbound audit, role cards,
memory and web-search tools as QQ. No SnowLuma service is needed for Discord.
The existing `qq_*` MCP names and `snowluma` server name remain as a shared,
backward-compatible tool contract; in Discord mode they operate on Discord.
The separate `discord-mode` settings namespace and `discord-chat` presets
keep QQ settings and prompts independent.

## Installation

Use Node.js >= 22.13 and a running DSH Web instance. The Discord mode settings
plugin targets DSH 0.2.0's loader-derived settings namespaces.

```sh
npm install --include=optional
```

`discord.js` is an optional dependency. QQ continues to work when optional
dependencies are omitted. The Discord client is loaded only in Discord mode.

Copy `config.discord.example.json` to `config.json` and `.env.example` to `.env`.
Use `Copy-Item` on PowerShell or `cp` on Unix. Put the bot token in `.env`:

```dotenv
DISCORD_TOKEN=your_bot_token
```

An existing `DISCORD_TOKEN` environment variable takes precedence over `.env`.
`DISCORD_BOT_TOKEN` is also accepted. Do not commit or share the real token;
the repository ignores `.env`.

In the [Discord Developer Portal](https://discord.com/developers/applications):

1. Create an application and bot.
2. Enable **Message Content Intent** on the Bot page.
3. Install the bot in the intended server with the `bot` scope.
4. Grant **View Channel**, **Send Messages** and **Read Message History**.
   For threads/posts grant **Send Messages in Threads**, and ensure the bot can
   access the thread. Private threads may require adding the bot as a member.

The adapter also uses the Guilds, GuildMessages and DirectMessages intents.
It does not request the privileged GuildMembers or Presence intents.
The recent-member tool reports visible recent participants, rather than
enumerating every server member.

Enable **Developer Mode** in Discord and use **Copy ID** on users, channels
or threads. All Discord IDs must be quoted strings in JSON:

```json
{
  "platform": "discord",
  "discord": {
    "allowDMs": true,
    "guildIds": ["4234567890123456701"]
  },
  "ownerId": "2234567890123456701",
  "allow": {
    "private": ["2234567890123456701"],
    "groups": ["1234567890123456701", "1234567890123456702"]
  },
  "allowAllWhenEmpty": false
}
```

Merge this example with the DSH connection/model fields in
`config.discord.example.json`. Replace every example ID with your own.
An empty `guildIds` list allows any server, subject to the channel allowlist.
Empty destination allowlists deny access unless `allowAllWhenEmpty` is
explicitly true. Deny lists take precedence.

Install the DSH configuration after editing `config.json`:

```sh
node scripts/setup-dsh.mjs web
```

The script selects Discord from `config.json`, links the Discord bundles and
registers the shared chat MCP plus `web-search-safe`. It excludes the QQ-only
`snowluma-host` probe. Existing providers and unrelated profile entries remain
intact. Restart DSH after installation, then run the bridge:

```sh
npm start
```

The console listens on `127.0.0.1:3100` by default. Its startup URL includes the
local console token; treat that URL as a credential.

## Channels, threads and wake behavior

- `allow.groups` contains **text channel or thread/post IDs**, not server or
  category IDs. The aliases `allow.channels` and `allow.users` are also accepted.
- Each allowed channel/thread has its own conversation context.
- Allowing a parent channel does not automatically allow its threads. Allowing
  a category does not allow its child channels. Add each intended ID.
- Private messages use `allow.private` user IDs and honor `discord.allowDMs`.
- A mention in a channel outside the allowlist is ignored.
- `chat` mode accepts ordinary messages without requiring an `@mention`.
  The simulation modes use their existing wake settings (mentions, replies,
  names, keywords, probability and timers); they are not strict mention-only
  filters. Replies remain subject to the model's decision to participate.

The local console can update allowlists while the bridge runs. It preserves
Discord IDs as strings. Changes to the MCP tool list require a DSH restart.

## Supported features and limitations

Supported: inbound channel/thread/DM text, mentions, quoted replies, image
attachments and sticker images; outbound text and links; message history;
per-conversation memory, wake controls and safe web search/fetch.

Incoming image understanding depends on the selected model supporting vision.
The transport can send validated image bytes, but the current agent toolset
does not expose an image-upload or image-generation tool. The agent can send
image URLs as text. It cannot upload a newly generated image attachment.

Messages longer than Discord's 2,000-character limit are split without
breaking surrogate pairs. Reply metadata and attachments are included on the
first chunk only. Outbound allowed mentions are disabled to avoid incidental
user, role and everyone notifications. Messages from bots, webhooks and system
events are ignored to prevent loops.

QQ pokes, merged forwards, QQ avatars, favorite-sticker management and QQ voice
notes are unavailable. They are removed from the Discord MCP tool list and
blocked at the bridge API even if a config attempts to enable them.
Discord voice calls, slash commands and reactions are not implemented.

## Offline validation

```sh
npm run test:discord
npm run test:audit
node scripts/build-agent-preset-patches.mjs --discord --check
```

These tests use fake Discord peers, temporary DSH profiles, local HTTP fixtures
and an MCP stdio client. They cover snowflake precision, channel/thread ACLs,
DM restrictions, reply ownership, message splitting, shared routing and
capability isolation. They do not send messages to a live Discord server.
