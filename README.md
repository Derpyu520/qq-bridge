# qq-bridge

[English](README.en.md) · [安装指南](docs/guides/DSH_SETUP.md) · [问题反馈](https://github.com/Derpyu520/qq-bridge/issues)

qq-bridge 是一个本地消息桥接工具，在 SnowLuma 提供的 **OneBot v11 接口**与 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 之间转发消息事件和 AI 回复。

当前候选版本：`v0.2.2-rc1`（GitHub prerelease），适配目标为 DSH `0.2.2-rc.1`。

> [!IMPORTANT]
> **qq-bridge 是独立维护的第三方工具，不是 SnowLuma 的子项目，也不隶属于 SnowLuma、DeepSeek 或腾讯 / QQ。**
> 本项目通过 SnowLuma 提供的 **OneBot v11 接口**互通；桥接与 SnowLuma 后端分别部署、独立维护，无隶属、合作或背书关系。OneBot v11 是公开协议，并非 SnowLuma 专有协议。
>
> **术语与边界**：本项目不向 QQ 客户端或 SnowLuma 进程注入、挂钩，不修改 SnowLuma 本体或其原生组件；但会读取本机 OneBot 配置与接入令牌、连接 OneBot 接口，并在 `npm install` 时修补本机 `@snowluma/sdk` 的 ESM 导入。文档中的“人格注入”指提示词写入，“提示注入”指不可信内容攻击；上游 `[Hook]` 仅指 SnowLuma 的接入机制，不是本项目的行为。

```text
QQ ↔ SnowLuma ↔ qq-bridge ↔ DeepSeek Harness ↔ 模型服务
             OneBot v11
```

## 能做什么

| 场景 | 功能 |
| --- | --- |
| 消息桥接 | 按群聊 / 私聊维护独立会话，支持文本、图片、表情与引用回复 |
| 聊天与仿真 | 普通聊天（`chat`）、两代群友仿真（`reserved` / `reserved2`）、自定义角色 |
| 个人助手 | `closed-agent` 仅限管理员私聊，可使用完整 DSH 工具；请谨慎开启 |
| 本地管理 | 控制台切换模式、管理白名单与审批、查看日志和模型用量 |

## 快速开始

准备好 **Windows 10 / 11、Node.js ≥ 22.13**（与 DSH 0.2.2 同机部署需 ≥24.9），以及以下两个独立运行的服务：

- **DSH Web**：当前有 `0.2.2-rc.1` 的验证记录（上一版为 `0.2.1-rc.2`），其他版本见[兼容范围](docs/guides/DSH_SETUP.md#兼容范围)。
- **SnowLuma**：请自行按[上游文档](https://github.com/SnowLuma/SnowLuma)安装、启动并登录，开启 OneBot **WebSocket 服务端**和 **HTTP API**。

### 1. 获取项目

在 PowerShell 中运行：

```powershell
git clone https://github.com/Derpyu520/qq-bridge.git
cd qq-bridge
npm install
# 首次安装会用 data/config.example.json 自动生成 work/config.json（已存在则跳过）
```

默认分支 `main` 为正式发布线；`dev` 用于开发与测试。

### 2. 填写配置

编辑 `work/config.json`，至少核对这些字段：

| 字段 | 填写内容 |
| --- | --- |
| `dsh.baseUrl` | DSH Web 地址，默认 `http://127.0.0.1:3080`；模型选择需与 DSH 中可用的配置一致 |
| `dsh.provider` / `model` / `reasoningEffort` | 模型提供方、模型名与思考强度；强度可使用 DSH 模型目录公布的档位，设为 `none` 表示不下发该字段、跟随模型默认 |
| `snowluma.wsUrl` / `httpUrl` | OneBot WebSocket / HTTP 地址，示例分别为 `ws://127.0.0.1:3001` / `http://127.0.0.1:3000`，不要混用端口 |
| `snowluma.accessToken` / `homeDir` | 按实际配置填写令牌与 SnowLuma 安装目录；HTTP、WS 令牌不同时，需能从该目录发现各自令牌 |
| `ownerQQ` | 你的管理员 QQ 号 |
| `allow.private` / `allow.groups` | 允许接入的 QQ 号 / 群号；默认空白名单不响应任何会话 |

同机运行时，`dsh.authToken` 通常留空，由桥接使用本机 DSH 凭据完成鉴权。完整配置与连接排查见[安装指南](docs/guides/DSH_SETUP.md)。

### 3. 安装 DSH 插件

```powershell
node scripts/setup/setup-dsh.mjs
```

这一步会把聊天预设和 MCP 工具接入 DSH，**首次安装也必须执行**。完成后重启 DSH；使用非 `web` profile 时见[安装指南](docs/guides/DSH_SETUP.md#安装步骤)。

### 4. 启动并测试

```powershell
npm start
```

打开 [本地控制台](http://127.0.0.1:3100) 并输入控制台令牌。自动生成的令牌保存在 `state/console-token`；如果已在 `work/config.json` 配置 `consoleToken`，则使用该值。启动日志不会打印令牌。新装默认使用二代仿真模式（`reserved2`），会选择性发言；测试收发时可先切到 `chat`，再从白名单会话发送消息。

`npm start` 是守护模式（桥接崩溃后 5 秒自动重启）；`npm run start:once` 只跑一次；`npm run restart` 会先验证停止本仓库实例再启动；Ctrl+C 或关闭终端即停止。

## 文档与开发

| 我想…… | 入口 |
| --- | --- |
| 安装、升级或排查连接 | [DSH 安装指南](docs/guides/DSH_SETUP.md) |
| 了解模式、权限与管理命令 | [使用规则](docs/RULES.md) |
| 查看模型用量与费用口径 | [用量看板](docs/guides/TOKEN_USAGE_CONSOLE.md) |
| 参与开发 | [贡献指南](docs/CONTRIBUTING.md) · [安全基线](docs/guides/SECURITY_BASELINE.md) |
| 报告安全漏洞 | [安全报告](docs/SECURITY.md) |
| 查找其他说明 | [文档索引](docs/README.md) |

开发基于 `dev`，提交 PR 前运行离线回归：

```powershell
npm run test:audit
```

## 本地扩展：QQ 文件与工具护栏

> 以下是在上游基础上保留的本地功能，尚未合并进上游；配置字段都在 `work/config.json`，模板见 `data/config.example.json`。完整的代码位置、测试与升级检查清单见 [本地扩展说明](docs/guides/LOCAL_EXTENSIONS.md)。

### QQ 文件（`files.*`）

- OneBot `file` 段会渲染成 `[文件 名字 (大小)]`，字节由桥接主动换取（群文件 `get_group_file_url`、缓存 `get_file`、段内 URL），抓取统一走 `safeFetchBytes`（与图片同一套 SSRF/重定向/大小防护，但**不校验图片签名**，HTML/ZIP/PDF 都能下）。
- **两套 fileId**：聊天消息里的 `file_id` 与群文件里的 `file_id` 不同；用消息 id 查不到时会按「文件名 + 大小」回退群文件列表。
- 落盘：`files.download` 开启时自动另存到 `files.dir`；同名同大小直接复用，不重复下载/不产生 `-2` 副本。
- 进上下文：文本文件正文默认**内联**（`files.inlineMode: always`，按 `maxInlineChars` 截断，单条消息受 `maxInlineTotalChars` 约束）；附件 `{type:'file'}` 同时上传 DSH，但 DSH 只会把它投影成一段带路径的 handle 文本，字节不会进模型，所以内联才是内容通路。
- 工具：`qq_download_file`（会话消息里的文件）、`qq_list_group_files`（列群文件）、`qq_download_group_file`（按 fileId 下载群文件）；受 `socialV2.tools.downloadFile` / `listGroupFiles` 控制。
- 上限：`files.maxBytes` 默认 20 MB；桥接把整个文件读进内存，调大前确认内存与磁盘余量。

### 上传文件（出站，仅封闭 agent）

- `qq_upload_file(key, token, path, name?)`：把本地文件发到 QQ。群聊走 `upload_group_file`（进**群文件**），私聊走 `upload_private_file`（发文件消息）；返回 `fileId`，群文件上传后会按「名字+大小」在群文件列表里验证，`verified` 表示是否看到。
- **按会话实际 preset 开放**：带工具的工作区预设 `qq-chat-tools` 与 `closed-agent`（owner 私聊）可以上传；`qq-chat` / `qq-chat-v2` 这类纯聊天预设会在端点 403、并用 `denyTools` 把工具从 schema 隐藏——纯聊天模式只能发图片与表情（发表情包、截图不需要文件通道）。允许的 preset 名单是 `files.uploadPresets`（默认 `["qq-chat-tools"]`）。
- 路径白名单：只允许 **会话工作区（`sessionCwd`）** 与 **`files.dir`** 里的真实文件；path 会先 `realpath` 再比对，防 `../` 穿越与工作区内软链逃逸。`files.uploadRoots` 可追加根目录（相对仓库根 / `~` / 绝对路径）。
- 大小受 `files.maxBytes` 约束；单次上传请求预算 5 分钟，大文件慢但不要反复重试。
- 开关：`files.upload`（默认 `true`）总闸，`socialV2.tools.uploadFile`（默认 `true`）控制工具暴露。
- 注意：群文件上传需要机器人在该群有上传权限；权限不足时网关会拒绝，工具会把原因带回来。

### 工具护栏（`agentGuard.*` + `qq-chat-tools` preset）

- 新增 `qq-chat-tools` preset（二代仿真 + 本地工具）：`read` / `read_image` / `write` / `edit` / `glob` / `grep` + `bash`（Windows 上 `pwsh`）。写边界靠 DSH 的 `workspace-write`（会话 cwd = `sessionCwd`），工作区外内核级写不了。
- `qq-agent-guard` 插件读 `work/config.json` 的 `agentGuard`（按 mtime，改完即生效）：
  - `denyRead`：排除路径（目录含子树，支持 `~`/绝对/相对仓库根）不可读写；`glob`/`grep` 还会拒绝包含排除目录的搜索根与绝对/`..` pattern。
  - `denyExec`：正则拒绝 `rm -r`/`sudo`/`dd of=`/`mkfs`/`find -delete` 等。
- 诚实边界：fs 工具的路径检查可靠（结构化参数 + realpath）；bash 的命令检查是**字符串级尽力而为**，脚本可绕过；真正的写边界仍是 DSH 沙盒。群聊输入不可信，开这套前请确认 `denyRead` 覆盖了敏感目录。

## 使用边界与许可

- 仅在知情并获准的会话中使用，遵守平台规则；使用非官方 QQ 后端可能导致账号受限。
- 聊天内容会经 DSH 发送给所配置的模型服务；黑话自动研究默认开启，可能将提取的关键词发送给搜索服务。数据流与关闭方式见 [NOTICE](docs/NOTICE.md#四数据传输)。
- 保护 `work/config.json`、`state/` 与控制台令牌，保持服务仅在本机可访问。
- DSH 离线期间的消息队列仅保存在内存中，每个会话最多 50 条；桥接进程退出后队列丢失，不保证送达。
- 本工具不实现 QQ 登录或底层协议，不安装、打包或启停 SnowLuma 后端；当前客户端仍依赖 `@snowluma/sdk` 等包，第三方组件适用各自条款。

当前代码按 [PolyForm Noncommercial 1.0.0](LICENSE) 提供，限非商业用途；`v0.2.1-r1` 及更早已发布版本沿用其发布时的 MIT 许可。第三方组件、独立关系与使用风险见 [NOTICE](docs/NOTICE.md)。
