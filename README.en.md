# QQ ↔ DeepSeek Harness Bridge (qq-bridge)

> Connect QQ messages to DeepSeek Harness (DSH) agents — with an independent persona per chat, memory of the people it talks to, and owner commands from private chat. QQ friends/groups become DSH conversations, and agent replies (including questions and tool approvals) are sent back to QQ.

> ⚠️ **Current release `v0.3.0`: the Gen2-era improvements plus the first public build of the Gen3 simulation (`reserved3`)**, targeting DSH 0.2.1-rc.2.
> `reserved2` is kept intact and can be switched back at any time; both generations share the same config baseline and tool surface.
>
> Gen3 is not a separate engine: it is the same social kernel plus a separate config profile and a separate preset (`qq-chat-v3`). The real difference lives in the prompt: it treats the agent as a QQ group member, decides whether to reply from the behavior contract and reply pressure (staying silent is allowed), and explicitly drives `qq_context`, person cards, digests and the interaction tools. Both generations share the delay/typing layer, episodic summaries, reply pressure, quota, burst splitting and persona-switch isolation.
> Design and configuration: [docs/design/GEN3.md](docs/design/GEN3.md); evaluation protocol: [docs/guides/GEN3_CHAT_PERSONA_EVAL.md](docs/guides/GEN3_CHAT_PERSONA_EVAL.md).
>
> DSH compatibility, older releases and per-release notes live upstream at [Derpyu520/qq-bridge releases](https://github.com/Derpyu520/qq-bridge/releases). The default branch `main` is this version.
>
> **Scope:** this is not only Gen3. Compared with upstream `main`, the tree carries the whole batch of Gen2-era improvements as well (admin operations, permissions, quotas, profile/QZone, sticker system, person cards, proactive scoring, media/document/voice, console, tests). See **[docs/CHANGES.md](docs/CHANGES.md)** for the file-level list.

For the detailed guide, see the Chinese **[README.md](README.md)**.
The documentation index (one line per doc, with "still current?" notes) is **[docs/README.md](docs/README.md)**;
the repository/folder and script-naming conventions are in **[docs/FOLDER_MAP.md](docs/FOLDER_MAP.md)**.

## Architecture

```
QQ messages ──► SnowLuma (OneBot v11 WS) ──► qq-bridge ──► DSH Web API (127.0.0.1:3080/api)
                                                    ▲                      │
                                                    └── agent replies / questions / approvals ┘
```

- **QQ side**: `@snowluma/sdk` provides the OneBot v11 WebSocket client.
- **DSH side**: adapted for DSH 0.1.2+ and **re-verified on 0.2.1-rc.2** — session Cookie minted from the persistent local signing key, `/api/<namespace>/<method>` slash RPC, and `/api/remote.mux` + `session/follow` event stream (the pending queue is read from `value.projections[<id>].values.inbox`, with the unary `session/projections` RPC as the primary path). The per-session model is pinned by the bridge via `session.selectModel` from `config.json`'s `dsh.model` (default `deepseek-flash` = DeepSeek-V41-Flash, multimodal).
- **Agent tools**: three bundled MCP servers expose a restricted QQ toolset (`qq_status`, `qq_list_groups`, `qq_get_group_history`, `qq_send_group_message`, `qq_reply`, etc.), a read-only host probe (`snowluma_status` only), and a read-only `web_search` / `web_fetch` pair with SSRF protection.
  ⚠️ **`start_snowluma` / `stop_snowluma` (and `snowluma.allowProcessControl`) were removed in v0.1.5**: SnowLuma EULA §5.4 requires prior written permission to deploy its proprietary native components through automated scripts. This program only probes, never deploys — installing, starting and scanning SnowLuma is always up to you. See [LICENSE](LICENSE) and [RULES.md](RULES.md).
- **Console**: a local web console at `http://127.0.0.1:3100`, organised into ten task-based pages (Overview, Sessions & Approvals, Persona, Social v2, Social v1, Slang, Usage & Cost, Access & Security, Operations, Tool Reference) with cross-page feature search and a **light / dark theme** (one-click toggle in the header; follows the OS preference until you choose), for mode switching, role management, whitelist/admin settings, slang management, memory, stickers and more. The Persona page manages roles (view/edit/rename/duplicate/delete the prompt of each persona), shows and edits both prompt layers separately — the **simulation prompt** built into the preset (tool/behaviour protocol; synced to DSH, restart required) and the **persona prompt** (`roles/*.md`; applied immediately) — and sets the **DSH reasoning effort** (`max` by default, `high`/`low` selectable). The **Usage & Cost** page shows real-time token consumption and its price in CNY, broken down per group/friend and per conversation turn (see [docs/guides/TOKEN_USAGE_CONSOLE.md](docs/guides/TOKEN_USAGE_CONSOLE.md)).

## Features

- Bridges QQ group/private messages to DSH agent sessions.
- Social simulation mode ("simulated group friend") with idle/active/probing/exiting states.
- Space-based message splitting for more natural multi-message replies.
- Whitelist/blacklist access control, fail-closed by default.
- Sensitive text audit prevents paths/credentials from being sent to QQ.
- MCP tools for reading group history/members, sending messages, replying with quotes, and (in `reserved2` / `reserved3`) full simulated-group-friend tooling.
- Slang/network-expression learning with human confirmation.
- Lightweight memory system for active topics, pending thoughts and member impressions.
- Sticker library integration with AI-friendly sticker usage, including **deleting its own collected
  stickers** (`qq_delete_sticker`): irreversible, therefore default permission is "on request only"
  (the owner must be the last speaker), with per-minute/hour/day caps and a post-delete read-back.
- **Configurable sticker send frequency** (`socialV2.sticker.send.mode`): `off` / `low` / `normal`
  (default) / `high` / `persona` ("entirely by persona"). The tier drives both the injected prompt
  guidance and a bridge-side cap (0/2/6/15 stickers per 10 minutes, min gap 0/45/3/1 s); `persona`
  imposes no tier cap and lets the role card decide, still bounded by the global send quota.
- **QQ profiles / avatars / Qzone (on by default)**: `qq_get_user_profile` returns a whitelisted
  public profile (nickname, remark, sex/age, signature, level, QQ age, online) plus the avatar as
  image content for the vision model — only for people seen in the current chat/group, the private
  peer, or an QQ number the owner explicitly asked about (per-session quota).
  `qq_qzone_read` reads your own posts / friends' feed (HTML is reduced to short text) and
  `qq_qzone_post` publishes a post through the admin-action queue: owner requests run directly,
  everyone else gets a confirmation card; image names are restricted to the `media/` library, with
  hourly/daily caps, duplicate suppression and read-back verification. See
  [docs/guides/QQ_PROFILE_QZONE.md](docs/guides/QQ_PROFILE_QZONE.md).

## Requirements

- Node.js >= 22.13
- Running DeepSeek Harness Web (default `http://127.0.0.1:3080`)
- Running SnowLuma with OneBot v11 WebSocket and HTTP API enabled

## Quick Start

```bash
npm install        # postinstall automatically patches the @snowluma/sdk ESM packaging bug
```

Copy `config.example.json` to `config.json`, then edit:

```bash
cp config.example.json config.json
```

Key settings:

| Field | Description |
| --- | --- |
| `dsh.baseUrl` | DSH Web API URL, default `http://127.0.0.1:3080` |
| `dsh.authToken` | DSH launch token (a process-launch credential). **Normally leave this empty**: with no token the bridge mints the session cookie offline from the persistent signing key in `~/.dsh/.credentials.yaml`, which depends on no per-process state (since DSH 0.1.7 the launch token lives only in memory — the one in the old logs belongs to a previous process and only yields a 401). A value here is honoured first if you set one |
| `dsh.authHeader` / `dsh.authPrefix` | Legacy fields kept for compatibility; the current path uses Cookie auth and does not send this header |
| `snowluma.wsUrl` | SnowLuma OneBot **WebSocket** URL (e.g. `ws://127.0.0.1:3001`) |
| `snowluma.accessToken` | OneBot access token, leave empty if not configured |
| `snowluma.httpUrl` | OneBot **HTTP API** URL (e.g. `http://127.0.0.1:3000`); do not point this at the WebSocket port or you will get HTTP 426 |
| `ownerQQ` | Administrator QQ (highest privilege) |
| `allow.private` / `allow.groups` | Whitelist of QQ/group IDs |
| `consolePort` | Local console port, default `3100` |

Start:

```bash
npm start
```

Or double-click `start.bat` on Windows (guard mode with auto-restart).

## DSH Setup on Another Device

The bridge and console can run without extra DSH setup, but the three DSH chat presets (`qq-chat`, `qq-chat-v2`, `qq-chat-v3`) and the MCP servers must be installed into DSH once per machine:

```bash
node scripts/setup-dsh.mjs
```

This installs:

- the `qq-agent-presets` bundle, which generates the three `@deepseek-ai/dsh-agent-preset` rows (`qq-chat`, `qq-chat-v2`, `qq-chat-v3`) plus the shared `qq-tool-restrict` safety guard
- MCP entries in `~/.dsh/profiles/web/cordis.patch.yml`
- `qq-mode-console` and `qq-agent-presets` in the profile `package.json` (`bundles` + `link:` dependencies)
- Default DSH mode set to `reserved2` (second-generation simulation), with `reserved3` (third-generation) selectable from the console and a local `state/mode.json` fallback

Then restart DSH. See [docs/guides/DSH_SETUP.md](docs/guides/DSH_SETUP.md) for details.

## Security Notes

- `config.json` and `state/` are **never committed**; the repository only ships `config.example.json`. Both are ACL-hardened to the owner / SYSTEM / Administrators (`npm run harden-acl`).
- MCP send tools enforce whitelist checks and reject CQ-code injection.
- Local paths, credentials, tokens and other sensitive patterns are filtered by the audit layer.
- Simulation sessions get **no local execution tools at all**: the preset's `qq-tool-restrict` row hides them from the tool schema at registration time and a runtime allowlist rejects anything outside the QQ MCP namespaces (`npm run scan:tool-names` re-checks that list against the installed DSH).
- The console uses a generated token when none is configured.

## Repository Layout

```
qq-bridge/
  config.example.json   # sanitized config template (real config.json is not in repo)
  docs/
    README.md           # documentation index
    FOLDER_MAP.md       # folder layout and scripts/ naming conventions
    guides/             # DSH_SETUP, ADMIN_OPS, GEN3_CHAT_PERSONA_EVAL, PRIVACY, SECURITY_BASELINE …
    design/GEN3.md      # Gen3 design, configuration and rollback
    UPSTREAM_PR.md      # how to send Gen3 upstream as a PR
  dsh/agent-presets/    # qq-chat / qq-chat-v2 / qq-chat-v3 preset templates
  plugins/              # qq-mode-console + qq-agent-presets (preset patch bundler)
  public/console.html   # local web console (no build step)
  roles/                # persona cards (examples: 傲娇助手, 小鲸鱼)
  skills/qq-persona-card # DSH skill for writing persona cards
  src/                  # bridge core and MCP servers
  assets/               # avatar candidates
  media/                # images sent to QQ (not in repo)
  scripts/              # tests and helper scripts
  state/                # runtime data (not in repo)
```

The standalone voice GUI is not part of this repo; the sending core lives in
`src/voice-core.js` / `src/send-voice-lib.js` and is disabled by default (`socialV2.voice.enabled`).

## Testing

`npm run test:audit` runs isolated regression tests without production credentials, DSH, or QQ messages; `npm run test:regressions` covers the Gen3 regressions, and `npm run privacy-scan` must stay green before publishing a fork.

After upgrading, legacy QQ session mappings without permission metadata are recreated once. Mode or preset changes also retire the old mapping and recreate the session on the next message; DSH history is retained.

```bash
npm run self-test       # DSH-side link test, no QQ/SnowLuma required
npm run test-md
npm run test-wait
npm run test-vision
npm run test-forward
npm run test-slang
npm run test-stickers
```

## Compliance

SnowLuma is an independent third-party project and is not affiliated with Tencent/QQ. This project is for learning and technical research only; please follow the relevant terms and the QQ User Agreement.
