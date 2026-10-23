# macOS + NapCat 安装指南

本仓库不再硬依赖 `@snowluma/sdk`。QQ 侧改为内置的 OneBot 11 WebSocket 客户端
（`src/onebot-client.js`），因此 macOS 上可以用 NapCat 作为 OneBot 网关。

## 适用范围

- macOS 12 及以上（Apple Silicon / Intel）
- Node.js ≥ 22.13
- 已安装官方 QQ（`/Applications/QQ.app`）
- NapCat Shell `v4.18.41`（脚本默认版本，可用 `NAPCAT_VERSION` / `NAPCAT_SHA256` 覆盖）

## 快速开始

```bash
npm install
cp config.example.json config.json

# 安装 NapCat，并把 QQ 的启动入口指向 NapCat 加载器
./scripts/install-napcat-macos.sh

# 启动 QQ（首次需要扫码登录）
open -a QQ --args --no-sandbox
```

NapCat WebUI 默认在 <http://127.0.0.1:6099>。登录后启用：

- HTTP 服务端：`127.0.0.1:3000`
- WebSocket 服务端：`127.0.0.1:3001`
- 如设置了 token，把它填进 `config.json`

`config.json` 推荐使用新的 `onebot` 段；旧的 `snowluma` 段仍然兼容：

```json
{
  "onebot": {
    "wsUrl": "ws://127.0.0.1:3001",
    "httpUrl": "http://127.0.0.1:3000",
    "accessToken": "NapCat 里配置的 token（没有就留空）"
  }
}
```

然后检查环境并启动：

```bash
npm run doctor:macos
./start-macos.command
```

看到 `SnowLuma 已连接`（日志里的历史叫法，指 OneBot WebSocket 已连通）后，在 QQ 上给机器人账号发消息测试。

## 脚本做了什么

`scripts/install-napcat-macos.sh`：

1. 从 NapCat 官方 Release 下载 `NapCat.Shell.zip`（优先使用 `gh-proxy.com` 镜像），校验 SHA256；
2. 解压到 `~/Library/Containers/com.tencent.qq/Data/Documents/napcat`；
3. 写入 `loadNapCat.js` 加载器；
4. 备份并修改 `/Applications/QQ.app/Contents/Resources/app/package.json` 的 `main` 字段，让 QQ 启动时加载 NapCat。

第 4 步需要管理员权限。如果 macOS 拒绝修改，请到「系统设置 → 隐私与安全性 → App 管理」允许终端，然后重试。
脚本会在同目录保留 `package.json.bak`，卸载时把它恢复即可。

## 自动发现

macOS 下桥接会额外检查：

- `NAPCAT_HOME`
- `~/Library/Containers/com.tencent.qq/Data/Documents/napcat`

并兼容 NapCat 的 `onebot11_<QQ号>.json` / `onebot11.json`，读取
`network.httpServers` 与 `network.websocketServers`（包括 `token` 字段、`0.0.0.0` / `::` 归一化）。
换 QQ 号后无需手改端口和 token；如需关闭自动跟随，设置：

```json
"onebot": { "followDiscoveredEndpoint": false }
```

## 常见问题

| 现象 | 检查 |
| --- | --- |
| QQ 启动后没有 NapCat 日志 | `npm run doctor:macos` 看「QQ 启动入口是否已切换」；确认 `package.json` 的 `main` 指向 `loadNapCat.js` |
| 修改 `package.json` 失败 | 系统设置 → 隐私与安全性 → App 管理，允许终端；或手动用 sudo 改 |
| 桥接报 `code=1006` | 确认 NapCat 的 WebSocket 服务端已启用，端口和 token 与 `config.json` 一致 |
| 端口被占用 | `lsof -nP -iTCP:3000 -sTCP:LISTEN` / `3001` / `6099`，关闭旧进程 |
| 发消息没反应 | 先看 `npm run doctor:macos`，再确认 `allow.private` / `allow.groups` 白名单不为空 |
| 想恢复官方 QQ | 把 `package.json.bak` 覆盖回 `package.json`，重启 QQ；必要时删除 `loadNapCat.js` 与 `napcat/` |

## 安全说明

- 安装脚本会修改 QQ 应用包内的 `package.json`，这是加载 NapCat 的必要步骤；请自行评估风险。
- `config.json`、`state/`、token 和日志都不会进入仓库；不要把它们提交到 PR。
- 桥接只连接本机 OneBot 端口，不启动、不控制 QQ 或 NapCat 进程。

## 回归测试

```bash
node scripts/test-onebot-client.mjs
node scripts/test-snowluma-conn.mjs
node scripts/test-snowluma-upstream-health.mjs
npm run test:audit
```
