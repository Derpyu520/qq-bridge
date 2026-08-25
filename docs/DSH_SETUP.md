# DSH 端安装说明（另一台设备）

`qq-bridge` 仓库本身包含桥接、控制台和插件，但 **DSH 端的两个聊天模式（`qq-chat` / `qq-chat-v2`）以及 MCP 挂载** 不在仓库根目录，需要通过本说明安装到目标设备的 DSH 环境中。

## 安装步骤

在目标设备上：

1. **克隆/获取仓库**：

   ```bash
   git clone https://github.com/Derpyu520/qq-bridge.git
   cd qq-bridge
   ```

2. **安装依赖**：

   ```bash
   npm install
   ```

   > `postinstall` 会自动修补 `@snowluma/sdk` 的 ESM 打包 bug。

3. **创建配置文件**：

   ```bash
   cp config.example.json config.json
   ```

   > Windows CMD 用户请用：`copy config.example.json config.json`

   然后编辑 `config.json`，填写：

   - `snowluma.wsUrl` / `httpUrl`（例如 `ws://127.0.0.1:3001` / `http://127.0.0.1:3000`，分别对应 OneBot WebSocket 与 HTTP API 端口）
   - `snowluma.accessToken`
   - `ownerQQ`
   - `allow.private` / `allow.groups`

4. **运行 DSH 端安装脚本**：

   ```bash
   node scripts/setup-dsh.mjs
   ```

   默认安装到 `web` profile；如果 DSH 使用其他 profile，可以传参：

   ```bash
   node scripts/setup-dsh.mjs <profile名>
   ```

   脚本会完成：

   - 安装 agent preset：`~/.dsh/.agent-presets/qq-chat`、`~/.dsh/.agent-presets/qq-chat-v2`
   - 在 `~/.dsh/profiles/web/cordis.patch.yml` 挂载：
     - `mcp-snowluma`（`src/mcp-snowluma-safe.js`）
     - `mcp-snowluma-host`（`src/mcp-host-server.js`）
     - `mcp-web-search-safe`（`src/mcp-web-search-safe.js`）
   - 在 `~/.dsh/profiles/web/package.json` 注册 `qq-mode-console` 插件
   - 把 `qq-mode-console` 插件的默认模式设为 `reserved2`（二代仿真）
   - 创建本地 `state/mode.json`（`mode: reserved2`）作为 DSH settings 不可用时的兜底

   > 脚本可重复运行；它会覆盖 `~/.dsh/.agent-presets/qq-chat*`、更新 MCP 路径并重建失效的插件链接。
   > 已存在的 `qq-bridge/state/mode.json` 会被保留（不覆盖用户设置）；全新安装才会写入 `mode: reserved2`。
   > 如果之后把 `qq-bridge` 目录移动/重新 clone 到别的路径，请重新运行一次本脚本，否则 DSH 里的 MCP/插件绝对路径会指向旧位置。
   > 也可用环境变量指定 DSH 根目录：`DSH_HOME=/path/to/.dsh node scripts/setup-dsh.mjs <profile>`。

5. **重启 DSH**：

   必须重启 DSH（或让 DSH 重新加载 profile），新 preset 和 MCP 工具才会生效。

   > 默认模式为 **`reserved2`（二代仿真）**，即“文本不自动转发、AI 通过工具自主收发”。如果你想改用 `chat` / `closed-agent` / `reserved`，可在 DSH 设置页的 `qq-mode` 卡片切换，或修改 `state/mode.json` 后重启桥接。

## 验证是否装好

1. **DSH WebUI 设置页**：应能看到 `qq-mode` 配置卡片，可切换 `chat` / `closed-agent` / `reserved` / `reserved2`。
2. **新建会话时**：agent preset 列表中应能看到：
   - `QQ 聊天角色`（`qq-chat`）
   - `QQ 聊天角色（二代仿真）`（`qq-chat-v2`）
3. **工具列表**：QQ 会话中应能看到 `mcp__snowluma__*`、`mcp__snowluma-host__*`、`mcp__web-search-safe__*` 等工具；不应看到 `dev_*` 等开发工具。

## 常见问题

- **看不到 `qq-mode` 设置卡片**：确认 `setup-dsh.mjs` 已把 `qq-mode-console` 加入 profile 的 `package.json` bundles，并重启 DSH。
- **MCP 工具没有出现**：确认 `cordis.patch.yml` 中三个 MCP 条目的路径指向当前仓库，并重启 DSH。
- **preset 没有出现**：确认 `~/.dsh/.agent-presets/qq-chat` 和 `~/.dsh/.agent-presets/qq-chat-v2` 存在，并重启 DSH。
- **发送消息报 HTTP 426（Upgrade Required）**：说明 `config.json` 里的 `snowluma.httpUrl` 指向了 **WebSocket 端口**。`httpUrl` 必须是 OneBot 的 **HTTP API 地址**（例如 `http://127.0.0.1:3000`），而 `wsUrl` 才是 WebSocket 地址（例如 `ws://127.0.0.1:3001`）。请在 SnowLuma WebUI 的 OneBot 配置里分别确认 HTTP 和 WebSocket 的端口。
