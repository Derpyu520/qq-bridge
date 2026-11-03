# qq-bridge

[中文](README.md) · [Setup guide](docs/guides/DSH_SETUP.md) · [Issues](https://github.com/Derpyu520/qq-bridge/issues)

A local message bridge that forwards message events and AI replies between the **OneBot v11 interfaces provided by SnowLuma** and [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness).

> [!IMPORTANT]
> **qq-bridge is independently maintained. It is not a SnowLuma subproject and is not affiliated with SnowLuma, DeepSeek, or Tencent / QQ.**
> It communicates through the **OneBot v11 interfaces** exposed by SnowLuma. The bridge and the SnowLuma backend are deployed and maintained independently, without affiliation, partnership, or endorsement. OneBot v11 is a public protocol, not a proprietary SnowLuma protocol.
>
> **Terminology and boundaries**: qq-bridge does not inject into or hook the QQ or SnowLuma processes, and does not modify SnowLuma itself or its native components. It does read local OneBot configuration and access tokens, connects to the OneBot interfaces, and patches the local `@snowluma/sdk` installation for ESM imports during `npm install`. “Persona injection” means adding text to prompts, while “prompt injection” means attacks from untrusted content. Upstream `[Hook]` entries refer only to SnowLuma's integration mechanism, not to qq-bridge.

```text
QQ ↔ SnowLuma ↔ qq-bridge ↔ DeepSeek Harness ↔ Model provider
             OneBot v11
```

## Features

| Use case | Capability |
| --- | --- |
| Message bridge | Separate sessions for groups and private chats; text, images, stickers, and quoted replies |
| Chat and simulation | Regular chat (`chat`), two generations of social simulation (`reserved` / `reserved2`), and custom roles |
| Personal assistant | `closed-agent` grants full DSH tools in owner-only private chats; enable with care |
| Local management | Console for modes, allowlists, approvals, logs, and model usage |

## Quick start

Use **Windows 10 / 11 and Node.js ≥ 22.13**, with these two services running separately:

- **DSH Web**: validation records cover `0.2.0-rc.2` / `0.2.1-rc.2`. See [compatibility](docs/guides/DSH_SETUP.md#兼容范围) for other versions.
- **SnowLuma**: follow the [upstream instructions](https://github.com/SnowLuma/SnowLuma) to install, start, and sign in. Enable its OneBot **WebSocket server** and **HTTP API**.

### 1. Get the project

Run in PowerShell:

```powershell
git clone https://github.com/Derpyu520/qq-bridge.git
cd qq-bridge
npm install
Copy-Item config.example.json config.json
```

`main` is the release branch; `dev` is for development and testing.

### 2. Configure

Edit `config.json` and check at least these fields:

| Field | Value |
| --- | --- |
| `dsh.baseUrl` | DSH Web address, default `http://127.0.0.1:3080`; select a provider and model available in DSH |
| `snowluma.wsUrl` / `httpUrl` | OneBot WebSocket / HTTP addresses, for example `ws://127.0.0.1:3001` / `http://127.0.0.1:3000`; keep the ports separate |
| `snowluma.accessToken` / `homeDir` | Your token and SnowLuma installation directory; when HTTP and WS use different tokens, the bridge must be able to discover both from that directory |
| `ownerQQ` | Your administrator QQ ID |
| `allow.private` / `allow.groups` | Allowed QQ IDs / group IDs; empty allowlists accept no conversations by default |

When running on the same machine, normally leave `dsh.authToken` empty so the bridge authenticates using local DSH credentials. See the [setup guide](docs/guides/DSH_SETUP.md) for details and troubleshooting.

### 3. Install DSH plugins

```powershell
node scripts/setup-dsh.mjs
```

This installs the chat presets and MCP tools into DSH. **It is required for a fresh installation.** Restart DSH afterwards. For profiles other than `web`, see the [setup guide](docs/guides/DSH_SETUP.md#安装步骤).

### 4. Start and test

```powershell
npm start
```

Open the [local console](http://127.0.0.1:3100) and enter the console token. Automatically generated tokens are stored in `state/console-token`; if `consoleToken` is set in `config.json`, use that value instead. Startup logs do not print the token. New installations default to second-generation simulation (`reserved2`), which speaks selectively; switch to `chat` for an initial message test from an allowed conversation.

On Windows, `start.bat` also runs the bridge with automatic restart. Closing its window stops it.

## Documentation and development

Most detailed documentation is currently in Chinese.

| Task | Documentation |
| --- | --- |
| Install, upgrade, or troubleshoot | [DSH setup](docs/guides/DSH_SETUP.md) |
| Modes, permissions, and commands | [Usage rules](RULES.md) |
| Model usage and cost estimates | [Usage dashboard](docs/guides/TOKEN_USAGE_CONSOLE.md) |
| Contribute | [Contributing](CONTRIBUTING.md) · [Security baseline](docs/guides/SECURITY_BASELINE.md) |
| Report a vulnerability | [Security policy](SECURITY.md) |
| Find other documentation | [Documentation index](docs/README.md) |

Develop on `dev` and run the offline suite before submitting a PR:

```powershell
npm run test:audit
```

## Usage boundaries and license

- Use only in conversations where participants are informed and use is permitted. Follow platform rules; using an unofficial QQ backend may lead to account restrictions.
- DSH sends chat content to your configured model provider. Automatic slang research is enabled by default and may send extracted keywords to search services. See [NOTICE](NOTICE.md#四数据传输) for data flows and controls.
- Protect `config.json`, `state/`, and console tokens. Keep services accessible only locally.
- While DSH is offline, messages are queued only in memory, up to 50 per conversation. The queue is lost when the bridge exits and delivery is not guaranteed.
- The bridge does not implement QQ login or its underlying protocol, or install, bundle, start, or stop the SnowLuma backend. It currently uses client packages including `@snowluma/sdk`; third-party terms apply separately.

The current code is available under [PolyForm Noncommercial 1.0.0](LICENSE) for noncommercial use. Releases up to and including `v0.2.1-r1` retain their original MIT license. See [NOTICE](NOTICE.md) for third-party components, project independence, and usage risks.
