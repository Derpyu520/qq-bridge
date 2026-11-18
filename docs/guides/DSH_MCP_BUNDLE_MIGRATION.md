# DSH MCP 加载方式迁移：停止注入，改走 bundle

> 读者：qq-bridge 的维护 agent / 后续接手者
> 日期：2026-11-09
> 起因：`C:\Users\30680\Documents\deepseek-harness\default-workspace\DSH-插件注入风险与web_search修复-2026-11-09.md`
> 结论：**注入式安装退役**；MCP 仍然走 stdio，但配置行必须由 bundle 拥有。qq-bridge 是当前机器上最后一个注入器。
>
> **状态：已完成（2026-11-09）。** 本文按方案 A 落地：三个 MCP 行由 `dsh/qq-bridge-mcp` bundle 提供，profile 里的注入区块已删除，`setup-dsh.mjs` 不再写 profile patch（只读检查）。实际执行记录见 §9。

---

## 0. 先读这一段（TL;DR）

1. **"正规加载"不是换 MCP 协议**。MCP 仍是 stdio：bundle 只负责声明 `@deepseek-ai/dsh-mcp-client` 这一行，启动器/子进程模型不变。
2. 正规方式只有一条：插件包自带 `cordis.patch.yml`（`package.json` 里的 `dsh.bundle.patch`），由 DSH 的 `plugin_manager install_bundle` 装载。安装器**不写** profile 的 `cordis.patch.yml`。
3. qq-bridge 的 `scripts/setup-dsh.mjs` 还在用整文件 `yaml.dump` 重写 profile patch。这会：
   - 删掉所有注释（包括它自己的 `BEGIN/END` 标记和 MediaForge 的标记）；
   - 把用户/DSH 设置页写进去的行一起重新序列化；
   - 与 DSH 设置页保存并发时后写者覆盖前者（没有文件锁）。
4. MediaForge 侧已经完成迁移，可作为参考实现：它的 `register.ps1` 已改成**默认不写文件**的迁移工具，安装器不再调用它，profile 里旧的注入区块已安全移除。
5. 本机当前状态：MediaForge 区块已删除、web 搜索三行已保留、MediaForge 已作为 bundle 安装并验证；**qq-bridge 的三个 MCP 行仍是注入区块**，需要按本文迁移。

---

## 1. DSH 的机制（为什么"注入"一定会坏）

### 1.1 三层 patch

```
bundle 自带 patch（随包发布，只读）
  → profile 的 cordis.patch.yml（用户覆盖层）
    → 命令行 --patch overlay（最高优先级）
```

profile patch 只记录与 bundle 不同的设置。插件管理器写它时会做冗余覆盖清理。

### 1.2 `install_bundle` 不碰 profile patch

`plugin_manager install_bundle` 只做两件事：

- 改 profile 的 `package.json`：`dsh.profile.bundles` 增删；
- 用 pnpm 物化依赖（`link:` / registry / git / tarball）。

插件行来自**包自己的** `dsh.bundle.patch`。卸载反向操作，同样不碰 profile patch。这就是"正规路径不会覆盖用户配置"的原因。

### 1.3 设置页的写入方式（关键）

`@deepseek-ai/dsh-config-editor` 用保留注释的 CST 改文件：

- 新行**追加到 YAML 序列末尾**；
- 但**文件末尾的尾随注释会留在最后**；
- 写入有文件锁（`withFileLock(profile/package.json)`）+ 原子替换（`writeFileAtomic`）。

推论：

> 任何把 `# === ... END ===` 放在文件末尾的安装器，都会让随后 DSH 追加的设置行落进这个区块内部。
> 下一次安装器"整块替换"就会把用户设置删掉。这是结构性的，不是偶发。

### 1.4 行 id 是寻址键

- `- insert: [rows]` 追加行；
- `- id: xxx` + 字段：覆盖该行；**`config` 整体替换，不深合并**；
- 不同 id 的行互不影响。

---

## 2. MediaForge 侧做了什么（参考实现）

仓库：`C:\MediaForge`，提交 `2e66682`。

### 2.1 之前的问题

`integrations/dsh-mediaforge/register.ps1` 会遍历 `~/.dsh/profiles/*`，用正则整块替换自己的 `BEGIN…END` 区块，且区块固定在文件末尾。本机 `desktop` profile 里，DSH 设置页追加的 web 搜索两行（`web-search-deepseek` / `web`）正好落在区块内部（旧文件第 141–150 行，区块 120–152 行）。下一次运行安装器就会删除它们。

### 2.2 现在的做法

- `register.ps1` 不再注入，默认只**报告**遗留区块，不写文件；
- `-RemoveLegacyBlock` 才移除区块，并且**保留区块内的外来行**（例如 web 搜索行），先备份、只留最近 5 份备份；
- 安装器 `installer/mediaforge.iss` 的 `[Run]` 段已不调用它；
- README 明确：安装 = `plugin_manager install_bundle target=link:<安装目录>\integrations\dsh-mediaforge`；
- 测试锁定两条行为：默认运行字节不变；移除区块保留外来行。

### 2.3 本机实际迁移记录

- 备份：`C:\Users\30680\.dsh\profiles\desktop\cordis.patch.yml.bak-20261109-090550`（4250 字节）；
- 删除 MediaForge 区块，保留 `agent-preset-registry`、`web-search-deepseek`、`web` 三行；
- 安装 bundle：`@local/mediaforge-mcp 0.2.2 ← link:...\Programs\MediaForge\integrations\dsh-mediaforge`；
- 验证：`tools/list` 返回 MediaForge 工具，`mediaforge_status` 正常。

### 2.4 给 qq-bridge 的启示

1. 先把**自己的区块**变成"只替换区块文本"，不解析/重排整个文件；
2. 再把三个 MCP 行抽成 bundle，脚本只负责 `package.json` 的 bundles 列表（或直接提示用户用插件管理器安装）；
3. 无论哪一步，**没有锁就不要整文件读-改-写**。

---

## 3. qq-bridge 当前实现分析

> 行号对应 2026-11-09 的快照，改动后按函数名定位。

文件：`scripts/setup-dsh.mjs`

| 位置 | 行为 | 风险 |
| --- | --- | --- |
| L126 `MANAGED_MCP_IDS = ['mcp-snowluma','mcp-snowluma-host','mcp-web-search-safe']` | 正确的"只拥有自己的行"模型 | 模型本身没问题，问题在实现 |
| L135–151 `mcpEntries()` | 生成 `# === qq-bridge MCP BEGIN === … END ===` 文本 | 可复用，迁移时保留这个生成器 |
| L154–188 `prepareCordisPatch()` | `yaml.load` 整个文件 → 删除自己 3 个 id → `yaml.dump` 整个数组 → 末尾拼 `mcpEntries()` | **注释/标记全部消失**；块落在 EOF；与设置页并发丢更新 |
| L190–204 `patchCordis()` | 写 `${patch}.tmp` 再 rename，有备份 | 原子性够；**没有文件锁**，与 DSH 并发会丢改动 |
| L28 `PROFILE = process.argv[2] \|\| 'web'` | 默认 `web` | 桌面版实际 profile 是 `desktop`，排障容易找错文件 |

### 3.1 两个后果（按严重度）

**P0：注释和标记消失 → 下次运行无法识别自己的区块**

`js-yaml` 不保留注释。第一次运行后：

- 自己的 `BEGIN/END` 没了；
- MediaForge 的 `BEGIN/END` 也没了；
- 下一次运行会**再追加**一个 `mediaforge-mcp` 块 → 重复 id / 两个同名 `serverName` → 按 MediaForge `DESIGN.md` §4：后加载的那行报错、工具消失。

**P1：区块在文件末尾 → 吞掉 DSH 设置**

即使注释没丢，只要 `END` 是文件最后的"尾随注释"，DSH 设置页追加的行就会落在 `BEGIN` 和 `END` 之间。下一次整块替换就删掉它们。这是 MediaForge 本机事故的同款结构。

**P2：无锁 + 默认 profile 不一致 + 备份策略不统一**

- 与 DSH 设置页保存并发时，后写者覆盖前者；
- 默认 `web` 与实际 `desktop` 不一致；
- 备份保留策略与 MediaForge 不一致（建议统一最近 5 份）。

---

## 4. 推荐方案

### 方案 A（推荐，彻底）：三个 MCP 行做成 bundle

新建一个目录（仓库内或 `~/.dsh/plugins/` 下），例如 `dsh/qq-bridge-mcp/`：

```
qq-bridge-mcp/
  package.json          # name: "@local/qq-bridge-mcp", dsh.bundle.patch: "./cordis.patch.yml"
  cordis.patch.yml      # 三条 mcp-client 行（id 仍用 mcp-snowluma / mcp-snowluma-host / mcp-web-search-safe）
  README.md
```

`cordis.patch.yml` 用现在 `mcpEntries()` 生成的内容即可（去掉 BEGIN/END 注释，或保留也无害，因为 bundle 文件是只读的）。

然后：

1. 从 profile 的 `cordis.patch.yml` 里删掉旧的 `BEGIN…END` 区块；
2. `plugin_manager install_bundle target=link:<qq-bridge>/dsh/qq-bridge-mcp`；
3. 验证 `mcp__snowluma__*` / `mcp__snowluma_host__*` / `mcp__web_search_safe__*` 出现；
4. `setup-dsh.mjs` 只保留 preset 安装和 `package.json` bundles 注册，**不再写 profile patch**。

注意：如果 profile 里已有 `- id: mcp-snowluma` 的覆盖行（例如 `disabled: true`），要一并删掉，否则 bundle 行会被它关掉。

### 方案 B（最小安全修补，不换安装方式）：文本级区块替换

保留 `mcpEntries()`，把 `prepareCordisPatch` 改成：

```js
function prepareCordisPatch() {
  const patchFile = path.join(DSH_HOME, 'profiles', PROFILE, 'cordis.patch.yml');
  const original = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : '';
  const block = mcpEntries();

  const pattern = /# === qq-bridge MCP BEGIN ===[\s\S]*?# === qq-bridge MCP END ===/;
  if (pattern.test(original)) {
    // 只替换自己的区块，其余字节原样保留（包括注释和其它安装器的区块）
    return { patchFile, original, text: original.replace(pattern, block.trimEnd()) };
  }

  // 没有区块：插到文件开头，而不是末尾。
  // 这样 DSH 设置页追加到末尾的行永远不会落进我们的区块。
  const body = original.replace(/^\uFEFF/, '').replace(/^\[\]\s*$/m, '').trimStart();
  return { patchFile, original, text: block + (body ? '\n' + body : '') };
}
```

配套要求：

1. **替换前检查区块内是否有外来行**：如果有，打印出来并拒绝写入（让人先手工迁移），不要静默删；
2. 加锁或至少与 DSH 设置页串行：最省事的做法是检测 `package.json` 是否被占用，或者接受"运行前请关闭设置页"并在文档写明；
3. 备份保留最近 5 份（`backupBeforeOverwrite` 现在保留 5 份，保持）；
4. `PROFILE` 默认值改为显式必填或自动检测（至少打印实际目标 profile）。

### 方案 C（兜底，仅止血）：拒绝破坏性写入

如果短期不想改结构，至少加一道闸：

```js
if (/#/.test(original) && !hasOwnBlock(original)) {
  fatal('cordis.patch.yml 含注释/其它标记，整文件重写会丢失它们；请先迁移到 bundle 或文本级替换');
}
```

这会让安装器在这台机器上直接失败，但不会删用户的东西。适合"先止血、再迁移"。

---

## 5. 本机迁移 runbook（当前状态）

### 5.1 当前 profile 实际结构（`desktop`，134 行）

```
1–6     默认模型
7–24    UI 设置
26–85   LLM provider
87–118  qq-bridge MCP 区块（BEGIN/END，3 条 mcp-client 行）
120–134 agent-preset-registry + web-search-deepseek + web（已从 MediaForge 区块中救出）
```

- MediaForge 区块已删除；
- 备份：`cordis.patch.yml.bak-20261109-090550`；
- web 搜索配置当前是 `deepseek-search-api` / `deepseek-fetch-api`（每 fetch 计费，见 §7）。

### 5.2 迁移步骤（建议顺序）

1. `Copy-Item cordis.patch.yml cordis.patch.yml.bak-<ts>`；
2. 按方案 A 建 `dsh/qq-bridge-mcp` bundle（内容用现在的 `mcpEntries()`）；
3. 从 profile patch 删除 qq-bridge 区块（保留 web 三行与 agent-preset-registry）；
4. `plugin_manager install_bundle target=link:<qq-bridge>/dsh/qq-bridge-mcp`；
5. 用 Stdio 探针验证（和 MediaForge 一样）：
   ```
   initialize → notifications/initialized → tools/list
   ```
   期望看到 snowluma / snowluma-host / web-search-safe 的工具；
6. 检查 `plugin_manager list_plugins`：三条 MCP 行 `active`；
7. 再跑一次 `setup-dsh.mjs`，确认 profile patch **字节不变**（它不该再写 patch）。

### 5.3 回滚

- 恢复 `cordis.patch.yml.bak-<ts>`；
- `plugin_manager remove_bundle target=@local/qq-bridge-mcp`；
- 重启/重连 DSH。

---

## 6. 验收清单

全部通过才算完成：

1. 连续跑 3 次新的安装逻辑：
   - 注释仍在；
   - 自己的 `BEGIN/END` 仍在（若保留方案 B）；
   - 其它安装器的标记仍在；
2. 连续跑 3 次 MediaForge 的迁移脚本（`register.ps1`，默认不写）：
   - profile patch 字节不变；
3. 两个安装器交替各跑 2 次：无重复 id、无注释丢失；
4. 在 DSH 设置页保存一次：
   - `cordis.patch.yml` 没有重复行、没有行被删、注释仍在；
5. `plugin_manager list_plugins`：三条 MCP 行 `active`，工具在；
6. 卸载 bundle 后：工具消失、profile patch 没有残留行。

---

## 7. 附：web_search 的现状（不要改坏）

原生 `web_search` 不出现的根因不是"模型绑定"，而是**搜索 provider 按凭据就绪**：没有 `DEEPSEEK_API_KEY` 时，`dsh-tool-web` 会在每个模型步骤把 `web_search` 从请求里撤下（插件仍启用）。

当前配置（本机）：

- `~/.dsh/.credentials.yaml` 的 `refs` 里有 `DEEPSEEK_API_KEY`；
- profile patch 里两行：
  - `- id: web-search-deepseek` → `apiKeyEnv: DEEPSEEK_API_KEY`；
  - `- id: web` → `searchProvider: deepseek-search-api`，`fetchProvider: deepseek-fetch-api`。

**注意**：

1. 这两行现在在 profile patch 里，**不在任何注入区块内**。任何"整文件重写"的安装器都必须保留它们。
2. `fetchProvider: deepseek-fetch-api` 每次 `web_fetch` 走 DeepSeek 接口计费；改回 `http` 是本地抓取（带 SSRF 防护、免费）。这是使用成本决策，迁移时不要顺手改掉，除非用户明确要求。
3. 凭据是明文存在 `~/.dsh/.credentials.yaml`，不要复制到仓库或日志里。

---

## 8. 明确不要做

- 不要再用整文件 `yaml.dump` 重写 `cordis.patch.yml`；
- 不要把 `BEGIN/END` 区块留在文件末尾；
- 不要在区块里删除"不是自己写的行"；
- 不要在未备份、未验证 YAML 的情况下改 live profile；
- 不要为了"省事"让安装器遍历所有 profile（每个 profile 由用户显式安装 bundle）；
- 不要修改 MediaForge 的 bundle 行（`mediaforge-mcp`）来"修复"重复问题——重复的根因是安装器，不是 bundle。

---

## 9. 落地记录（2026-11-09，方案 A）

### 新增的 bundle

```
C:\qq机器人\qq-bridge\dsh\qq-bridge-mcp\
  package.json        @local/qq-bridge-mcp 1.0.0，dsh.bundle.patch → ./cordis.patch.yml
  cordis.patch.yml    三条 insert（mcp-snowluma / mcp-snowluma-host / mcp-web-search-safe）
  README.md           为什么是 bundle、怎么装/卸载、路径依赖
```

安装：

```
plugin_manager install_bundle target=link:C:\qq机器人\qq-bridge\dsh\qq-bridge-mcp
```

结果：`@local/qq-bridge-mcp 1.0.0 ← ..\qq机器人\qq-bridge\dsh\qq-bridge-mcp`，三条 MCP 行 `active`，`mcp__snowluma_host__snowluma_status` 可调用。

### profile patch 的变化

- 删除第 87–119 行的 `# === qq-bridge MCP BEGIN === … END ===` 区块（33 行）；
- 其余字节原样保留：`agent-default-model` / `ui-*` / `llm-pi-ai` / `agent-preset-registry` / `web-search-deepseek` / `web`；
- 行数 135 → 102，文件大小 3808 → 2734 字节；
- 备份：`cordis.patch.yml.bak-mcpbundle-20261109-091629`（删区块前）、`cordis.patch.yml.bak-before-remove-*`（工具级）。

> 删除用的是一次性的文本级脚本：先校验区块内所有 `id` 都属于 `MANAGED_MCP_IDS`、行数正好 3，否则拒绝删除；删完再和「按行删同一段」的结果逐字节比对。

### `setup-dsh.mjs` 的变化

- 删掉 `MANAGED_MCP_IDS` / `mcpEntries()` / `prepareCordisPatch()` / `patchCordis()`，以及 `js-yaml` 依赖和 `yamlSingleQuote()`；
- 新增只读的 `inspectLegacyCordisBlock()`：发现遗留区块就打印处理办法，不写文件；
- 文件头注释改成「只检查、不修改 profile patch」。

### 验收结果

| 项 | 结果 |
|---|---|
| `setup-dsh.mjs desktop` 连跑 4 次 | profile patch SHA-256 不变（`14D5DD57…`，2734 字节） |
| MediaForge `register.ps1` 默认运行 | 同一 hash 不变 |
| profile patch YAML 解析 | 8 行、无重复 id、注释只剩必要内容 |
| 三条 MCP 行 | `active`，工具可调用 |
| 遗留区块检测 | 输出「无遗留注入区块；MCP 行由 @local/qq-bridge-mcp bundle 提供」 |

未在本轮验证：卸载 bundle 后工具消失（会中断当前会话的 MCP 工具，留待无人使用时做）；DSH 设置页保存一次后的行序（需要真实 UI 操作）。

### 后续注意

- 移动 qq-bridge 目录后要重装 bundle（`cordis.patch.yml` 里写死了 node 路径和脚本路径）。
- 新增 MCP server 一律加进 `dsh/qq-bridge-mcp/cordis.patch.yml`，不要回到写 profile patch 的老路。
- 如果将来 DSH 支持「插件自带 MCP 声明」的一等公民形式，这个 bundle 可以再简化，但**判断标准不变**：安装器不写用户的 profile 覆盖层。

---

## 10. 参考

- 原始报告：`C:\Users\30680\Documents\deepseek-harness\default-workspace\DSH-插件注入风险与web_search修复-2026-11-09.md`
- MediaForge 修复提交：`2e66682`（`integrations/dsh-mediaforge/register.ps1` + README + 2 个测试）
- 当前 profile：`C:\Users\30680\.dsh\profiles\desktop\cordis.patch.yml`
- 备份：`C:\Users\30680\.dsh\profiles\desktop\cordis.patch.yml.bak-20261109-090550`
- DSH 包：`@deepseek-ai/dsh-config-editor`、`@deepseek-ai/dsh-plugin-manager`、`@deepseek-ai/dsh-mcp-client`
