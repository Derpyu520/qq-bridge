# 把本仓库的改动 PR 回上游

目标仓库：[Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)（`main`）。

**范围先说清**：这次不是只 PR 三代。本仓库相对上游是 **55 个文件修改、49 个新增、0 删除**，
包含二代上线后的全部改进（管理员动作、权限、限额、资料/空间、表情、人物卡、主动发言、控制台、
测试）加上三代仿真。逐项清单见 [CHANGES.md](CHANGES.md)。

> 前置：本机目前没有 `git`。先装 [Git for Windows](https://git-scm.com/download/win)（或 GitHub Desktop）。
> 不要把本目录直接 `git init` 成新仓库再 PR——历史对不上，diff 会变成「新增 200 个文件」。

## 一、先对齐基线

```bash
git clone https://github.com/Derpyu520/qq-bridge.git qq-bridge-upstream
cd qq-bridge-upstream
git checkout -b feat/social-improvements
```

上游可能已经前进。先看 `git log --oneline -5`，如果 `main` 比本仓库的基线（`a49877f`）新，
把新提交先合进来或 rebase，避免覆盖别人的改动。

## 二、覆盖

把本目录内容覆盖进去（**不要**覆盖 `.git`、`node_modules`、`state`、`config.json`）：

```powershell
# 在 qq-bridge-upstream 的上一级执行；把 <副本> 换成实际路径
robocopy "<副本>" "qq-bridge-upstream" /E /XD .git node_modules state .tmp /XF config.json *.log
```

```bash
# macOS / Linux
rsync -a --exclude .git --exclude node_modules --exclude state --exclude .tmp \
      --exclude config.json --exclude '*.log' "<副本>/" qq-bridge-upstream/
```

## 三、先核对，再提交

```bash
git status --short
git diff --stat
```

预期：约 55 个修改、49 个新增。重点检查：

- **不应该出现** `src/core/session-router.mjs`、`src/dsh-client.js` 的意外改动（本仓库没动它们）；
- 新增文件里，`src/admin-ops.mjs`、`src/bot-perms.mjs`、`src/quota.js`、`src/qq-social-profile.mjs`、
  `src/person-score.mjs`、`src/proactive-score.mjs`、`src/dsh-endpoint.js`、`src/snowluma-egress.js`
  是二代的支撑模块；
- `dsh/agent-presets/qq-chat-v3/`、`plugins/qq-agent-presets/presets/qq-chat-v3.patch.yml`、
  `docs/design/GEN3*.md`、`docs/guides/GEN3_CHAT_PERSONA_EVAL.md` 是三代的；
- 确认没有 `state/`、`config.json`、`audio/`、`media/`、真实号码。

## 四、拆 commit

`src/bridge.js` 一个文件里同时有二代与三代改动，按 hunk 拆成本很高。给两个可执行方案：

### 方案 A：最小（2 个 commit，最省事）

```bash
# 1) 二代与基础设施
git add src/admin-ops.mjs src/bot-perms.mjs src/quota.js src/qq-social-profile.mjs \
        src/person-score.mjs src/proactive-score.mjs src/dsh-endpoint.js src/snowluma-egress.js \
        src/*.test.mjs scripts/ docs/guides/ADMIN_OPS.md docs/guides/PROACTIVE.md \
        docs/guides/QQ_PROFILE_QZONE.md
git commit -m "feat: admin ops, permissions, quota, profile/qzone, stickers and proactive scoring"

# 2) 引擎、控制台、preset、三代与文档
git add -A
git commit -m "feat(gen3): reserved3 mode, qq-chat-v3 preset, console and docs"
```

### 方案 B：推荐（按主题拆，reviewer 友好）

1. `feat(v2): 管理员动作 + 三档权限` — `src/admin-ops.mjs`、`src/bot-perms.mjs`、对应测试、
   `docs/guides/ADMIN_OPS.md`
2. `feat(v2): 限额 + 资料/空间 + 表情 + 人物卡 + 主动发言` — 其余新模块、`sticker-lib`/`role-card` 改动、测试
3. `feat(v2): 控制台扩展` — `public/console.html`、`scripts/console-ui-*`
4. `feat(gen3): reserved3 模式 + qq-chat-v3 preset` — `dsh/agent-presets/qq-chat-v3/`、v3 patch、
   `src/bridge.js` 的三代部分、`config.example.json` 的 `socialV3`
5. `docs: 二代改进 + 三代设计与评测` — `README`、`RULES`、`docs/`
6. `chore: 隐私扫描修复 + 人格卡 skill` — `scripts/privacy-scan.mjs`、`skills/`

> `bridge.js` 如果一定要拆，用 `git add -p src/bridge.js` 按函数分组；拆不动就整块放进第 2 或第 4 个
> commit，并在 PR 描述里说明「引擎改动集中在 `bridge.js`，按功能模块索引」。

### 方案 C：拆成多个 PR

如果 maintainer 觉得一次太大：

1. **PR 1**：纯新增模块 + 测试 + 文档（不改 `bridge.js`）——能独立合，风险最低；
2. **PR 2**：`bridge.js` / 控制台接入这些模块（二代改进）；
3. **PR 3**：三代模式 + preset + 文档。

## 五、PR 描述模板

```markdown
## 这个 PR 做了什么

把二代上线后的一整批改进同步回上游，并新增三代仿真（`reserved3`）。没有删除任何上游文件
（55 modified / 49 added / 0 deleted），二代 `reserved2` 完整保留。

## 一、二代改进

- **限额**：发送/唤醒滑动窗口（分钟/小时/2 小时/日），分支级 + 全局级，超限 429 + retryAfterMs
- **管理员动作**：改群名片/群名/头像、QQ 昵称/签名/头像、发说说；确认卡、审计、撤销、冷却
- **权限**：「不开放 / 仅应要求 / 人设自主」三档 + persona_veto
- **资料/空间**：白名单字段 + SSRF-safe + 回读校验
- **表情包**：清单/看图/人格匹配/频率档位/收藏/删除；动图抽帧
- **人物卡与关系**：事实/边界/互动/置信度、熟悉度档位
- **主动发言**：会话级概率、冷场/被无视打分
- **多模态**：图片归一化、语音内核、文档阅读（PDF/DOCX/XLSX）、转写/OCR
- **运维**：DSH 端口自愈、state ACL 加固、旁路发送审计、token 账本
- **控制台**：三代页、令牌看板、人格页、表情参数、访问与安全
- **测试**：新增 20+ 离线回归，test-audit-regressions 27 KB → 74 KB

## 二、三代仿真

- 新增 `reserved3` 模式与 `qq-chat-v3` preset；不替换 `reserved2`
- 同一套社交内核 + 独立配置档（`socialV3` 只覆盖 tools/timing/decision/context/document）
- 提示词层：群成员身份、行为合同优先、回复判断、qq_context 一次取齐、收尾以 canSleepNow 为准
- 设计说明：docs/design/GEN3.md；评测口径：docs/guides/GEN3_CHAT_PERSONA_EVAL.md

## 兼容性

- 默认模式不变；切到 `reserved3` 才启用新配置档与 preset
- 两代共用 state/、白名单、工具面、限额；切回 `reserved2` 不需要迁移
- 旧 `config.json` 不写 `socialV3` 也能跑（首次从 `socialV2` 克隆）
- DSH 侧无新增依赖

## 怎么验证

\`\`\`bash
npm run test:quota
npm run test:role-card
npm run test:stickers
npm run test:regressions
npm run privacy-scan
\`\`\`

手工：按 docs/guides/GEN3_CHAT_PERSONA_EVAL.md 的 A/B 卷对比 reserved2 / reserved3。

## 已知边界

- 三代与二代共用引擎，代码级差异主要在模式/配置/preset；默认参数下两代接近，差异来自提示词
- 语音默认关闭；文档阅读默认关闭
- 会话树只有 owner 私聊的只读 /branches、/summary
```

## 六、发 PR 之前的沟通

范围很大，建议先开一个 issue 说明：

> 「我在本地把二代上线后的一批改进 + 三代仿真做完了，想分成 2~3 个 PR 合回来。先发一个
> `docs/CHANGES.md` 级别的清单，想确认哪些部分你愿意收、哪些要拆开或重做。」

把 [CHANGES.md](CHANGES.md) 贴在 issue 里。维护者如果只想要其中一部分（例如管理员动作涉及权限模型），
按 §四 的方案 C 拆。

## 七、提交前自查

- [ ] `npm run privacy-scan` 全绿
- [ ] `git diff` 里没有 `state/`、`config.json`、`audio/`、`media/`、真实号码
- [ ] `config.example.json` 是合法 JSON；`socialV3` 块完整
- [ ] 新增配置项都写进了 `docs/design/GEN3.md` 与 `README`
- [ ] 干净克隆里 `npm install && npm run test:regressions` 能过
- [ ] 版本号（`0.3.0`）是否保留由 maintainer 决定，可以单独一个 commit
