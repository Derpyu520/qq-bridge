# 参与开发

## 环境

- Node.js **>= 22.13**（`package.json` 的 `engines` 会检查）
- 一个能跑的 DSH（DeepSeek Harness）+ SnowLuma 才能测端到端；只改代码/文档不需要
- Windows 用 PowerShell；Linux/macOS 用 bash。命令默认在仓库根目录执行

```bash
npm install          # postinstall 会修补 @snowluma/sdk 的 ESM 打包问题
npm start            # 启动桥接（默认控制台 http://127.0.0.1:3100）
```

## 代码约定

- ESM（`import` / `export`），不引入构建步骤；`src/` 直接跑。
- 缩进 2 空格；中文注释写「为什么」，不写「是什么」。
- 新依赖要先说明理由：这个项目刻意保持小依赖面。
- 面向模型的字符串（工具描述、提示词）改动，要同步 `scripts/test-tool-surface.mjs` 里的契约。
- 行为改动必须带离线测试（`scripts/test-*.mjs` 或同目录 `*.test.mjs`），并且能在没有 QQ/DSH 的机器上跑。

## 改完跑什么

```bash
npm run test:quota          # 限额窗口
npm run test:role-card      # 人格卡解析
npm run test:stickers       # 表情清单与频率档位
npm run test:regressions    # 审计回归（含唤醒提示、权限、人格切换）
npm run check:personas      # 人格串台体检（读 state/，本机）
npm run privacy-scan        # 提交前：真实号码/路径/令牌扫描
```

`npm run test:audit` 会跑一轮更全的离线审计；需要真号/真群的 `probe-*`、`verify-*` 是手工脚本，
不要放进 CI。

## 隐私红线（PR 会被直接拒的情况）

- 提交真实的 QQ 号、群号、手机号、姓名、群名、本机路径、令牌。示例一律用
  `1000000001` / `123456789` / `角色A` / `<你的昵称>`。
- 把 `state/`、`config.json`、`audio/`、`media/` 里的实际内容带进来。
- 把别人的聊天记录、空间说说、头像原样贴进文档或测试夹具。
- 在人格卡里写只有你自己群才懂的梗和真人称呼。

提交前请自己跑一遍 `npm run privacy-scan`，它会挡住上面大部分情况。

## 提 PR

1. 从 `main` 切分支：`feat/xxx`、`fix/xxx`、`docs/xxx`。
2. 一个 PR 只做一件事；大的重构先开 issue 说方案。
3. PR 描述写清：改了什么、为什么、怎么验证（命令 + 结果）。
4. 涉及行为变化时，附上「二代 / 三代」两种模式下的表现差异。
5. 文档与代码一起改：新增配置项要进 `config.example.json` 与对应 `docs/`。

## 人格卡贡献

`roles/` 下的卡是示例，不是产品功能。想贡献自己的角色，请：

- 先用 [skills/qq-persona-card/SKILL.md](skills/qq-persona-card/SKILL.md) 的流程写；
- 确认没有真人信息（称呼、群名、口头禅里的真名）；
- 跑 `npm run check:personas` 与 `node scripts/test-behavior-contract.mjs`。
