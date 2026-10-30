# 发布前隐私检查（PRIVACY）

> 这个项目在一台**真实机器**上运行过，工作树里天然散落着真实 QQ 号、群号、本机绝对路径、
> 令牌、以及个人化的人格卡内容。任何一次「忘了就 push」都会把这些**永久写进公开仓库历史**
> ——Git 历史里的东西删提交也删不干净（还会被 fork 保留）。
>
> 所以发布前跑一遍扫描，是发布流程的**硬性一步**，不是可选建议。

---

## 一、跑扫描

```bash
node scripts/privacy-scan.mjs                # 扫"将要提交的内容"（推荐）
node scripts/privacy-scan.mjs --tracked-only # 只扫 git 已跟踪文件
node scripts/privacy-scan.mjs --history      # 追加扫描全部 git 历史（发布前必跑）
node scripts/privacy-scan.mjs --json         # 机读输出（给 CI 用）
```

> `--history` 需要**完整克隆**（`git fetch --unshallow`），且只跑低误报规则。
> 它按「历史 blob」逐份扫描，因此不会因为同一文件在几十个提交里没变而重复报告。
> 目前它会稳定报出 `docs/AUDIT_REPORT_2026-09-18.md` 里的本机路径泄漏 ——
> **清掉历史之前，这条不会被消除**，这正是它应该起的作用。

退出码：`0` = 干净，`1` = 有命中（**必须逐个判读**），`2` = 规则文件坏了或目录扫不动。

它扫描：`git ls-files` + 未被 ignore 的未跟踪文件（git 不可用时退化为目录遍历，并尽力套用 `.gitignore`；
遍历会跳过 junction/symlink，免得被指回自身的联接搞成无限递归）。

## 二、内置规则（挡住最常见的泄漏）

| 规则 | 说明 |
| --- | --- |
| 本机绝对路径 | `C:\Users\<名字>\…` 与 `D:\<工作盘>\…` 这类工作盘路径 |
| QQ 号 / 群号 | 9–10 位连续数字（真实账号长度；文档里的 `123456789` 属占位符） |
| 高熵串 | 疑似令牌/密钥。**过滤掉**全 hex（git SHA）、全大写下划线（环境变量名）、小写文件名式串 —— 真凭据是"大小写+数字混合" |
| 凭据赋值 | `accessToken: "<12 位以上实际值>"` 形态（空值/模板不算，避免噪音） |
| 私钥头 / 带凭据的 URL | `-----BEGIN … PRIVATE KEY-----`、`https://user:pass@host` |
| 不应入库的文件 | `config.json`、`state/`、`audio/`、`*.log`、`*.bak*` |

## 三、判读命中：三种处理，别一律"忽略"

| 情况 | 处理 |
| --- | --- |
| **真实数据**（你的 QQ 号、群号、本机路径、令牌） | 换成占位符（`123456789` / `C:\path\to\…`），或把该文件移出版本控制 |
| **该文件本来就不该入库** | 加进 `.gitignore`；若已提交过，见下面第四节 |
| **误报**（脱敏模板、测试夹具、文档示例） | 加进白名单 —— 两种方式：<br>① 文件级：`scripts/privacy-rules.json` 的 `allowPaths`；<br>② 规则级：在同一文件里加一条更精确的 `deny` 规则覆盖默认规则 |

### `scripts/privacy-rules.json`（可选的本地规则文件）

- **它含你机器上的真实标识，必须加进 `.gitignore`**（模板见 `privacy-rules.example.json`）。
- 结构：

```jsonc
{
  "comment": "本机专用；不入库",
  "deny": [
    { "name": "我的真实群号", "pattern": "1001[0-9]{6}", "flags": "" }
  ],
  "denyFiles": ["notes/", "*.private.md"],
  "allowPaths": ["docs/guides/VOICE.md", "scripts/console-ui-"]
}
```

`allowPaths` 支持前缀或 `*` 通配。**加入白名单前先确认那个文件里确实只有占位数据**——
白名单是"误报豁免"，不是"这个文件不用检查"。

## 四、已经提交进去了怎么办

| 情况 | 处理 |
| --- | --- |
| 还没 push | `git reset --soft` 回退提交、清掉敏感内容、重新提交 |
| 已 push，但**没有被 fork / 没人拉过** | `git filter-repo --replace-text` 清历史，再 `git push --force`。要提前通知协作者 |
| 已 push 且可能被 fork / 已公开一段时间 | **当作已泄露**：① 立刻**轮换**所有涉及的凭据（控制台令牌、SnowLuma token、DSH launch token 都是本地生成，轮换成本低）；② 再清历史；③ 新仓库（QSH）从干净起点开始，不带旧历史 |

> 这也是 `QSH_FORK_AND_SITE_PLAN.md` 建议**新建仓库、不带 qq-bridge 历史**的原因之一：
> 旧历史里既有 11 MB 演示视频，也有难以逐条确认的本地痕迹。新起点一次扫干净，成本最低。

## 五、CI 里怎么用

```yaml
# .github/workflows/ci.yml 片段
- name: Privacy scan
  run: node scripts/privacy-scan.mjs --tracked-only
```

CI 上只扫**已跟踪**文件（未跟踪文件在干净 checkout 里不存在），命中即失败。
历史扫描（`--history`）**不进 CI**：CI 默认浅克隆看不到历史，且它需要完整 clone、更慢；
它属于发布前的人工检查（`npm run privacy-scan:history`）。

## 六、本仓库 2026-09-20 的扫描结果（存档）

首次运行发现的问题，供拆分新仓库时逐条处理：

| 文件 | 命中 | 处理建议 |
| --- | --- | --- |
| `public/console.html` | 真实群号 `100012` × 2 | **必须替换为占位符**（这是会随 QSH 一起发布的文件） |
| `src/bridge.js` | `accessToken` 键名（配置读取处，无真实值） | 误报：键名不是值；已在规则里区分"有实际值" |
| `docs/guides/PROJECT_GUIDE.md`、`docs/guides/VOICE.md` | 真实 QQ 号/群号、`C:\Users\<名字>`、`D:\<工作盘>` | **不带进新仓库**（旧项目的实现说明，已被 `QSH_PLAN.md` 取代） |
| `docs/audits/*`、`docs/design/*`、`docs/research/*`、`docs/legacy/*` | 本机路径、真实 QQ 号 | 同上：**不带进新仓库**；只把 `AUDIT_FIXES` 与 `SECURITY_BASELINE` 带走（这两份已确认只含占位符） |
| `scripts/test-*`、`scripts/console-ui-*`、`src/sensitive.js`、`config.example.json` | 刻意构造的假 ID / 假凭据 / 占位符 | 误报：已在 `allowPaths` 白名单里 |

**结论**：真正必须在**代码**里改掉的只有 `public/console.html` 的群号；其余全部靠"不带进新仓库"解决。
