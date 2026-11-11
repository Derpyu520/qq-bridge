# 本地扩展说明（相对上游 v0.2.2-rc1）

> 本文记录本 fork 在 `Derpyu520/qq-bridge` 之上保留的功能、代码位置与验证方式。
> 上游没有这些功能；从上游 rebase 过来时，以本文清单为准逐项复查。
> 上游能力与安装方式见 [DSH 安装指南](DSH_SETUP.md) 与根目录 `README.md`。

## 一、功能清单

| 功能 | 配置 | 代码入口 | 测试 |
| --- | --- | --- | --- |
| QQ 文件下载/落盘/进上下文 | `files.*` | `src/qq/qq-file.js`（服务）、`src/qq/qq-file-lib.js`（纯函数）、`src/bridge.js`（端点与投递） | `scripts/tests/offline/test-qq-file.mjs` |
| 群文件列表与下载工具 | `socialV2.tools.listGroupFiles` | `src/mcp-snowluma-safe.js`、`src/bridge.js` | `scripts/tests/offline/test-qq-file.mjs` |
| 本地文件上传到 QQ | `files.upload` / `files.uploadRoots` / `files.uploadPresets` / `socialV2.tools.uploadFile` | `src/qq/qq-file.js`（`uploadLocalFileToQQ`）、`src/qq/qq-file-lib.js`（`resolveUploadPath`）、MCP `qq_upload_file` | `scripts/tests/offline/test-qq-file.mjs` |
| 带工具的群聊预设 | `socialV2.agentPreset = "qq-chat-tools"` | `dsh/agent-presets/qq-chat-tools/` | `scripts/tests/offline/test-qq-agent-guard.mjs`、`scripts/tests/offline/test-agent-preset-patches.mjs` |
| 路径/命令护栏 | `agentGuard.*` | `plugins/qq-agent-presets/qq-agent-guard.mjs` | `scripts/tests/offline/test-qq-agent-guard.mjs` |
| 按 preset 屏蔽工具 | preset 里的 `denyTools` | `plugins/qq-agent-presets/qq-tool-restrict.mjs` | `scripts/tests/offline/test-qq-agent-guard.mjs` |
| 被点名唤醒的 2s 快速窗口 | `socialV2.wake.batchWindowMs` | `src/bridge.js`（`QUICK_WAKE_WINDOW_MS`） | `scripts/tests/offline/test-code-scanning-boundaries.mjs` |
| ffprobe 4.4 兼容（无 `-o`） | — | `src/media/voice-core.js`（`probeAudio`） | `scripts/tests/offline/test-voice-volume.mjs` |

## 二、QQ 文件链路

- **入站**：OneBot `file` 段 → 元数据（`fileId`/`busid`/`name`/`size`/`url`）→ 按需抓取
  （`safeFetchBytes`：与图片同一套 SSRF/重定向/大小防护，但不校验图片签名）→ 落盘
  `files.dir` → 文本文件正文内联进 prompt；二进制文件只给元数据与只读副本路径。
- **两套 fileId**：聊天消息里的 `file_id` ≠ 群文件列表里的 `file_id`。消息 id 查不到时，
  按「文件名 + 大小」回退群文件列表（`findGroupFileByMeta`/`pickGroupFileFromList`）。
- **出站**：`qq_upload_file(key, token, path, name?)`。群聊走 `upload_group_file`（进群文件），
  私聊走 `upload_private_file`；返回 `fileId`，群文件会按「名字+大小」验证 `verified`。
- **上传边界**：路径必须 realpath 后落在 `sessionCwd`、`files.dir` 或 `files.uploadRoots` 内；
  大小 ≤ `files.maxBytes`；只允许 `files.uploadPresets` 里的 preset（默认 `qq-chat-tools`）
  和 `closed-agent`；纯聊天 preset（`qq-chat` / `qq-chat-v2`）用 `denyTools` 屏蔽，只能发图片/表情。

## 三、qq-chat-tools 与护栏

- `qq-chat-tools` = 二代仿真人格（同步自 `qq-chat-v2`）+ 本地工具
  （`read`/`read_image`/`write`/`edit`/`glob`/`grep` + `bash`/`pwsh`）。
- 写边界来自 DSH `workspace-write`（会话 cwd = `config.sessionCwd`），不是提示词。
- `qq-agent-guard`（读 `config.json` 的 `agentGuard`，按 mtime 热更新）：
  - `denyRead`：排除路径不可读写，`glob`/`grep` 也拒绝包含排除目录的搜索根；
  - `denyExec`：`rm -r` / `find -delete` / `shred` / `truncate` / `sudo` / `dd of=` /
    `mkfs` / `chmod -R` / fork bomb 等一律拒绝。
  - 诚实边界：fs 工具路径检查可靠；bash 是字符串级尽力而为，不是沙盒。
- `qq-tool-restrict` 的 `denyTools` 可按 preset 屏蔽单个工具（例如聊天 preset 屏蔽
  `mcp__snowluma__qq_upload_file`）。

## 四、预设源文件与生成物

```
dsh/agent-presets/<preset>/
├── preset.yml            # 名称/描述/排序
├── agent.cordis.yml      # 人格正文 + 工具行（唯一手改入口）
└── qq-*.mjs              # re-export 壳，实现只在 plugins/qq-agent-presets/
plugins/qq-agent-presets/
├── qq-tool-restrict.mjs  # 工具白名单/隐藏/denyTools（权威实现）
├── qq-agent-guard.mjs    # 路径与命令护栏（权威实现）
└── presets/*.patch.yml   # 由 build-agent-preset-patches.mjs 生成，勿手改
```

改完 preset 源之后：

```bash
node scripts/setup/build-agent-preset-patches.mjs   # 生成 patch（--check 可只校验）
node scripts/setup/setup-dsh.mjs                    # 安装到 DSH profile
# 重启 DSH + 重启桥接
```

## 五、升级上游时的检查清单

1. `git fetch origin && git rebase origin/main`，冲突优先保留本文清单里的本地功能；
2. 重新生成 patch：`node scripts/setup/build-agent-preset-patches.mjs`；
3. `node scripts/tests/offline/test-agent-preset-patches.mjs`、`node scripts/tests/offline/test-qq-file.mjs`、
   `node scripts/tests/offline/test-qq-agent-guard.mjs`；
4. `node scripts/setup/setup-dsh.mjs` → 重启 DSH → 重启桥接；
5. 确认 `config.json` 里的 `dsh.provider` 与本机 DSH 模型目录一致
   （账号登录是 `deepseek-account`，API-key 部署是 `deepseek-official`）。

## 六、配置速查

```json
{
  "files": {
    "enabled": true,
    "download": true,
    "intoContext": true,
    "inlineMode": "always",
    "dir": "state/downloads",
    "maxBytes": 20971520,
    "upload": true,
    "uploadRoots": [],
    "uploadPresets": ["qq-chat-tools"]
  },
  "agentGuard": {
    "enabled": true,
    "denyRead": [],
    "denyExec": []
  },
  "socialV2": {
    "agentPreset": "qq-chat-tools",
    "tools": { "downloadFile": true, "listGroupFiles": true, "uploadFile": true },
    "wake": { "batchWindowMs": 4000, "maxWakePerMinute": 4 }
  }
}
```

完整模板见 `data/config.example.json`；`work/config.json` 不入库（npm install 自动生成）。
