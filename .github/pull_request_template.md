<!-- 一个 PR 只做一件事。标题建议用 Conventional Commits：fix: / feat: / docs: / chore: / refactor: -->

## 改了什么

<!-- 一两句话说清这个 PR 解决什么。关联 issue：#123 -->

## 为什么

<!-- 现象 / 根因。如果是对某个上游行为变化的适配，写清是哪个版本、哪条契约变了 -->

## 怎么验证的

<!--
必填。至少贴出：
  npm run test:audit
  → Audit suite: N/N scripts passed.

涉及活 DSH / SnowLuma 的改动，额外说明你怎么实测的（哪个群、哪一步、看到了什么）。
-->

```
Audit suite: / scripts passed.
```

## 自查

- [ ] 跑过 `npm run test:audit`，结果写在上面
- [ ] 跑过 `npm run privacy-scan`（没有新增命中；历史命中和误报已逐项说明）
- [ ] 新增行为带了回归脚本，**并已加进 `scripts/test-audit.mjs` 的清单**
- [ ] 没有提交 token / Cookie / 真实 QQ 号 / 群号 / 本机绝对路径 / `state/`
- [ ] 行为变更（配置项、工具名、端点、默认值）已同步更新 README 或 `docs/`
- [ ] 没有绕过 [RULES.md](https://github.com/Derpyu520/qq-bridge/blob/main/RULES.md) 的设计不变量（尤其 L6 / L7）

## 破坏性变更 / 需要使用者做什么

<!-- 没有就写「无」。有的话：要不要重启 DSH、要不要改 config.json、旧配置还能不能直接用 -->
