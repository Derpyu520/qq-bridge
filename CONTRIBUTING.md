# 参与贡献

先把两件事说在前面：**这个项目只在 Windows 上跑**，**维护者通常会直接把改动提交到 `dev`**。
后者会影响你怎么提 PR，所以第 4 节请读完。

## 1. 环境

| 需要 | 版本 | 说明 |
| --- | --- | --- |
| Windows | 10 / 11 | 大量依赖 Windows 的 ACL、控制台编码与进程行为；Linux / macOS 不在支持范围 |
| Node.js | **>= 22.13** | 见 `package.json` 的 `engines` |
| npm | 随 Node | 仓库带 `package-lock.json`，请用它锁定版本 |

## 2. 本地跑起来

```bat
git clone https://github.com/Derpyu520/qq-bridge.git
cd qq-bridge
npm install
npm run test:audit
```

⚠️ **不要用 `npm ci --ignore-scripts`**。`postinstall` 会跑 `scripts/patch-snowluma-sdk.mjs`，
给 `@snowluma/sdk` 的相对导入补 `.js` 扩展名（这两个上游包自己的 ESM 打包有问题）。
跳过它，`test-snowluma-upstream-health.mjs` 会稳定失败——那是预期行为，不是你的改动坏了。

## 3. 测试

| 命令 | 环境要求 | 说明 |
| --- | --- | --- |
| `npm run test:audit` | 离线，无需 QQ / DSH | **提 PR 前必须跑**。fixtures + mock，不碰真实账号 |
| `npm run privacy-scan` | 无需额外环境 | 扫入库文件里的 token、本机路径、真实 QQ 号/群号（CI 会跑） |
| `npm run privacy-scan:history` | 需要完整 clone | 追加扫描全部 git 历史（发布前必跑，历史未清理时会报出已知泄漏） |
| `npm run verify:adaptation` | **需要活的 DSH** | DSH 协议适配对账（含活体回合），CI 里跑不了 |
| `npm run test:mcp-servers` | 离线 | 三个 MCP server 的工具清单 |
| `node src/self-test.js` | 需要 DSH + SnowLuma 在线 | 端到端链路 |

`privacy-scan` 的规则文件 `scripts/privacy-rules.json` **不进仓库**（它本身会记录敏感判断依据）。
没有它时扫描只走内置默认规则；干净 clone 上应当**直接通过**（内置规则已把测试夹具与文档占位符排除）。
如果本机补了 `privacy-rules.json`（含你自己的真实 QQ 号/路径），扫描会在内置默认规则之上追加你的本地规则。

## 4. 提交 PR

**一个 PR 只做一件事。** 把 12 个不相关的修复塞进一个 PR，评审成本会高到没人看得完。
**PR 的目标分支是 `dev`**（见第 5 节的分支模型）；`main` 只在发布时从 `dev` 合并。

PR 里请写清楚：

1. **改了什么、为什么**（贴 issue 号更好）；
2. **怎么验证的**——贴 `npm run test:audit` 最后那行 `Audit suite: N/N scripts passed.`；
3. 有没有**行为变更**（配置项、工具名、端点、默认值）；有的话同步改 README / `docs/`。

新增行为请带回归脚本，并把它加进 `scripts/test-audit.mjs` 的清单——**不加进去的测试等于不存在**，
因为没人会记得手动跑它。

**不要提交**：真实 QQ 号 / 群号 / 昵称、任何 token 或密钥、本机绝对路径、`state/`、`node_modules/`。
`privacy-scan` 会拦一部分，但它不是万能网。

## 5. 维护者的合并方式（据实说明）

本仓库分两条线：`main` 是**正式发布线**，只收经过验证的版本；`dev` 是**测试 / 开发线**，
持续更新、随时提交，正常状态下**领先** `main`。发布时才把 `dev` 合入 `main`，所以两条线可能
短暂同步，但 `dev` 不应落后于 `main`。由此：

- 维护者的日常改动**直接提交到 `dev`**；
- **外部贡献者的 PR 一律以 `dev` 为目标分支**（提向 `main` 的 PR 会被改指向 `dev`）；
- 你的 PR **可能直接合并**，也可能被**参考后重新实现**，还可能在 `dev` 里已经修好了；
- 以上三种情况都会在 PR 里回复说明，不会让你干等；
- 如果 `dev` 里已包含等价修复，维护者会指出对应的提交并关闭 PR——**这不代表你的工作没价值**，
  通常只是两条线同时撞上了同一个问题。

想用正式发布版就待在 `main`（`git clone` 默认拿到的就是它）；想跟最新改动就切到 `dev`
（测试线，**不保证稳定**）。

## 6. 许可

提交 PR 即表示你同意你的贡献按本仓库的
[PolyForm Noncommercial 1.0.0](LICENSE) 发布（许可范围与第三方组件声明见 [NOTICE.md](NOTICE.md)）。

如果你不能接受这一点（例如你的雇主对该代码有 CLA 或再许可要求），**请先开 issue 讨论**，
不要直接提 PR。

## 7. 安全

**不要用公开 issue 报漏洞。** 走 [SECURITY.md](SECURITY.md) 里的私密上报渠道。
