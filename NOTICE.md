# NOTICE

本文件载明 qq-bridge（下称「本软件」）的著作权归属、许可范围、第三方组件与合规边界。

本文件不是许可条款，亦不构成对许可条款的补充、限制或解释。本软件的许可条款以 `LICENSE` 为准；
本文件与 `LICENSE` 不一致时，以 `LICENSE` 为准。

---

## 一、著作权与许可

### 1.1 著作权归属

本软件著作权由 Derpyu520 及 qq-bridge 贡献者共同享有，依
**PolyForm Noncommercial License 1.0.0**（SPDX 标识符：`PolyForm-Noncommercial-1.0.0`）授权。
许可全文见 [`LICENSE`](LICENSE)，官方文本见
<https://polyformproject.org/licenses/noncommercial/1.0.0>。

### 1.2 许可范围

以下为条款索引，仅供查阅；权利义务以 `LICENSE` 正文为准。

| 事项 | 规定 |
| --- | --- |
| 使用目的 | 限于非商业目的 |
| 修改 | 允许 |
| 分发 | 允许，包括分发含修改的版本 |
| 商业使用 | 不允许 |
| 再许可、转让 | 不允许 |
| 分发时的义务 | 须随附本许可条款或其 URL，以及 `LICENSE` 中 `Required Notice:` 行 |

依许可「Noncommercial Purposes」「Personal Uses」「Noncommercial Organizations」三条，个人学习、
研究、实验、业余项目，以及慈善组织、教育机构、公共研究机构、公共安全与卫生机构、环境保护组织、
政府机构的使用，均属许可用途，不受经费来源影响。

### 1.3 版本适用

`v0.2.1-r1` 及更早发布版本仍可按其发布时的 MIT 条款使用；`v0.2.1-r1` 之后的发布版本及
基于这些新版本形成的修改，适用其发布时的许可。仅取得旧版本或创建过 fork，不会改变后续版本的许可。

仓库内随附的子包（`plugins/qq-agent-presets`、`plugins/qq-mode-console`）与根目录适用同一
许可；它们的 `package.json` `license` 字段与根清单保持一致，不构成单独的 MIT 例外。

### 1.4 托管平台的许可标识

GitHub 的许可识别清单不包含 PolyForm 系列（2026-10-30 核验：`GET /licenses` 共返回 13 项，
均为开源许可；`GET /licenses/polyform-noncommercial-1.0.0` 返回 404），其仓库页面因此显示
`Other / NOASSERTION`。该显示不影响许可效力。许可类型以 `LICENSE` 正文及 `package.json`
的 `license` 字段为准。

---

## 二、第三方组件

### 2.1 组件与许可

本软件包含或依赖下列第三方组件。各组件依其自身许可授权，不适用本软件的许可。

| 组件 | 许可 | 说明 |
| --- | --- | --- |
| [`@deepseek-ai/dsh`](https://github.com/deepseek-ai/deepseek-harness) 及 `@deepseek-ai/*` 各包 | MIT | DeepSeek Harness 本体与官方 API 客户端 |
| [`@snowluma/sdk`](https://www.npmjs.com/package/@snowluma/sdk)、[`@snowluma/mcp`](https://www.npmjs.com/package/@snowluma/mcp) | 声明为 `SEE LICENSE IN LICENSE`，发布包内未附许可文件（见 2.2） | 经 npm 依赖使用 |
| [SnowLuma](https://github.com/SnowLuma/SnowLuma) 本体 | 源码可见的非商业许可（非 OSI 开源许可） | 本软件不在仓库内包含或分发其源码与二进制，仅经 OneBot v11 协议通信；并在本机读取安装目录下 `config/onebot_*.json` 中的接入令牌，令牌仅用于连接相应的 OneBot 地址 |
| `@modelcontextprotocol/sdk`、`js-yaml`、`zod` 等 | MIT / ISC | 见各自包内 LICENSE |

### 2.2 `@snowluma/sdk` 与 `@snowluma/mcp` 的许可状态

**核验事实**（2026-09-20，可自行复核）：

1. 两个包的 `package.json` 均声明 `"license": "SEE LICENSE IN LICENSE"`；
2. 发布的 npm 包内不含 LICENSE 文件：`npm pack @snowluma/sdk --dry-run` 的文件清单仅有
   `dist/`、`README.md`、`CHANGELOG.md`、`VERSIONING.md`；
3. 成因在源仓库：`packages/sdk/package.json` 与 `packages/mcp/package.json` 的 `files` 字段
   未包含 `LICENSE`，且 `packages/sdk/LICENSE`、`packages/mcp/LICENSE` 均不存在。

**认定**：上述两个包的许可状态在包内不可判定，`SEE LICENSE IN LICENSE` 指向的文件并不存在。
但 SnowLuma LICENSE §1 对 "Software" 的定义为「the SnowLuma source code and assets **in this
repository**」，而 `packages/sdk`、`packages/mcp` 位于该仓库之内，故二者受同一非商业许可约束。
此为 §1 定义的直接结论。

**本软件的处理**：

1. 仓库内不含、不分发上述两个包的代码。`node_modules/` 已在 `.gitignore` 中；已跟踪文件内不包含
   任何原生二进制（`.node` / `.dll` / `.so`），亦不包含 `@snowluma` 路径下的文件。
2. `npm install` 的 `postinstall` 会运行 `scripts/patch-snowluma-sdk.mjs`，对
   `node_modules/@snowluma/{sdk,mcp}` 的 `dist/**/*.js` 执行一次机械修补（为相对导入补充 `.js`
   扩展名，规避该两包自身的 ESM 打包缺陷）。该修补仅作用于本机安装副本，不进入本仓库；
   SnowLuma 许可 §2(c) 允许为自身非商业使用而修改。**本软件不修改 SnowLuma 应用本体，
   上述说明仅指对本机 npm 安装副本进行兼容性修补。**
3. 后续如替换这些依赖，需同步调整客户端实现与 `postinstall` 修补，避免留下失效的构建步骤。
   `@snowluma/mcp` 的 `catalog.js` 快照属于再分发其内容，不得提交至本仓库；
   仓库根目录曾跟踪的 `_snowluma-catalog.json` 已删除并加入 `.gitignore`。
4. 如需消除上述不确定性，应向 SnowLumaDevs 书面确认 `packages/sdk` 与 `packages/mcp` 所适用的许可。

---

## 三、与 SnowLuma 的关系

### 3.1 独立关系声明

qq-bridge 是独立维护的第三方工具，不是 SnowLuma 的子项目；qq-bridge 与 SnowLuma、DeepSeek、
腾讯 / QQ 之间不存在隶属、官方合作或背书关系。

### 3.2 互操作性质

本软件不在仓库内包含或分发 SnowLuma 的源码与二进制，仅通过 OneBot v11 协议与其通信。
它会在本机读取安装目录下的 `config/onebot_*.json`，从已有账号配置中寻找当前可用的接入令牌，
并只将令牌用于连接相应的 OneBot 地址。本软件不是 SnowLuma 的修改版或衍生版本。

### 3.3 条款对照

SnowLuma 采用源码可见的非商业许可（[LICENSE](https://github.com/SnowLuma/SnowLuma/blob/main/LICENSE)，
以中文文本为准）。本软件与其为协议互操作关系，对照如下。**以下为工程层面的判断，不构成法律意见。**

| 条款 | SnowLuma 的要求 | 本软件的判断 |
| --- | --- | --- |
| §2 授权 | 允许为非商业目的使用、运行，以及为自身非商业使用而修改 | 在授权范围内 |
| §3(d) | 公开发布修改版或衍生版须事先取得书面许可 | 不适用：本软件不含、不分发其源码与二进制，非其修改版或衍生版 |
| §4(a) | 禁止商业使用 | 两项许可分别适用：qq-bridge 自身许可与 SnowLuma 许可均禁止商业使用，不构成相互豁免 |
| §4(b) | 不得基于本软件开发、发布或分发另一个项目 | 见 3.4 |

### 3.4 关于 §4(b) 的解释与不确定性

本软件注意到该条存在两种解释：

- 一种解释认为，§4(b) 紧接商业限制，且 §1 已将基于本软件的付费托管、部署、代搭列为商业用途，
  故其意旨在于禁止将商业使用包装为周边项目以规避 §4(a)，而非禁止一切互操作工具。
- 另一种解释更为严格，且更具文本依据：§4(a) 已表述为「Commercial Use of the Software **in any
  form** is PROHIBITED」，若采用前一种解释，§4(b) 将不具独立适用范围，与同一许可内部应作一致
  解释的原则相悖。赋予 §4(b) 独立含义的正是字面解释：它是一项不含商业限定语的独立禁止。

此外，§2 授予的权利为可撤销（revocable），EULA §8 允许著作权人单方面更新条款。

**本软件的立场**：不因协议互操作而假定获得额外授权。使用者在评估公开分发、托管或相关服务时，
应自行核对 SnowLuma 条款，并在需要时联系 SnowLumaDevs 确认；本软件不声称已取得额外许可。

### 3.5 EULA §5.4：必须遵守的边界

> EULA §5.4（以中文文本为准）：「除事先取得著作权人的书面授权外，您仅可为 `LICENSE` 允许的
> 非商业用途，以专有组件随本软件提供的形式运行该组件；不得复制、修改、单独再分发或再许可该组件。
> **将其并入第三方安装包或 Docker 镜像、通过自动化脚本部署**，或者将其用于任何商业用途，
> 均须事先取得书面授权。」

据此，本软件不安装、不复制、不打包、不自动部署 SnowLuma 及其原生组件，亦不以程序化方式启动或
结束其进程；仅进行端口探测与状态查询，缺失时提示使用者自行经官方渠道获取并启动。

该约束已作为设计不变量 L6 记录于本项目的[安全基线](docs/guides/SECURITY_BASELINE.md)。
原 `start_snowluma` / `stop_snowluma` 工具与 `snowluma.allowProcessControl` 配置项已于 v0.1.5 移除，
并有回归断言（`scripts/test-audit-setup-guards.mjs`）防止回退。

### 3.6 构成本软件明示排除的使用形态

下列形态将直接落入 SnowLuma §4(a) 的禁止范围，不因本软件采用何种许可而改变：

1. 提供付费的托管、部署、代搭或代运营服务，包括以成本价收费；
2. 将本软件并入任何付费产品或服务；
3. 以收费方式运行本软件对外提供服务；
4. 将赞助或捐赠与可获得的服务相绑定。

### 3.7 结论

本软件的版权许可仅覆盖本软件自身的代码，不对 SnowLuma 授予任何权利，亦不替代使用者依其许可
应承担的义务。使用者应自行取得 SnowLuma 并遵守其许可。

---

## 四、数据传输

本软件运行时主要有下列网络出口。部署方应在部署前知悉，并按适用法律与所在平台规则履行告知义务。

| 目的地 | 传输的数据 | 默认 | 关闭方式 |
| --- | --- | --- | --- |
| 本机 DSH（默认 `127.0.0.1:3080`） | 群聊与私聊消息文本、图片、昵称、会话上下文 | 启用 | 不运行 DSH |
| LLM 提供方（经 DSH 调用，默认 `deepseek-official`） | 同上，包含群内其他成员的消息 | 启用 | 在 DSH 中更换 provider 或 model |
| OneBot 网关（默认 `127.0.0.1:3000/3001`） | 发出的消息与动作参数 | 启用 | 不接入 QQ |
| `web_search` → DeepSeek 搜索接口（默认）／Bing（回退）；也支持自定义 `webSearch.baseURL` | 搜索关键词，以及 DeepSeek / 自定义搜索端点所需的 API key 请求头。黑话自学习默认启用（`slang.autoResearch: true`），会将自群聊提取的词条作为关键词发出；自定义 `baseURL` 时 API key 也发往该端点 | 启用 | 不挂载 `mcp-web-search-safe`，或关闭黑话自动研究 |
| `web_fetch` → 公网 URL | 被抓取的页面地址（由模型决定，可能来自聊天内容中的线索） | 启用 | 不挂载 `mcp-web-search-safe`；`safe-fetch.js` 拦截内网、私有及保留地址 |
| 图片与表情等媒体 URL → QQ CDN 或其他公网地址 | 媒体地址及下载请求；地址可来自聊天消息或 OneBot 返回数据 | 启用 | 不发送含媒体的会话，或不接入 QQ |
| 使用者配置的 TTS 服务（默认地址 `127.0.0.1:9880`） | 待合成文本、音色引用；可能包含聊天上下文中的内容 | 关闭 | 保持 `socialV2.tts.enabled: false`；AI 另有 `tools.synthesizeVoice` 开关 |

搜索、网页与媒体请求的目标和内容可能由模型、聊天消息或自定义配置决定，可能包含群聊中出现的
词条或线索。部署方可通过搜索服务配置、关闭黑话自动研究及限制媒体输入控制这些出口。

本软件不包含遥测、统计或 phone-home 机制。上表描述本软件运行时的主要网络出口，
不包括安装依赖、操作系统或用户自行启动的其他服务产生的网络流量。

---

## 五、使用风险与免责

1. 使用非官方协议工具接入第三方平台，可能违反该平台的服务条款并导致账号受限，风险由使用者承担。
2. 本软件将聊天内容交由第三方大语言模型处理，并可能代账号发言。部署方应仅在
   [RULES.md](RULES.md) 所述白名单与审计机制下运行，不应在未配置白名单的情况下向任意群聊或
   陌生人开放。
3. 部署方应保护控制台令牌、`config.json` 与 `state/` 的访问权限，不应将 DSH 或本软件的端口
   暴露于公网。
4. 本软件按「现状」提供，不附带任何明示或默示担保。在适用法律允许的最大范围内，著作权人
   不对使用本软件所产生的任何后果承担责任。此条与 `LICENSE` 的 No Liability 条款一致。

---

## 六、联系

- 安全漏洞：依 [SECURITY.md](SECURITY.md) 通过 GitHub 私密漏洞上报渠道提交，不得以公开 issue 披露。
- 许可与合规问题：于本仓库提交 issue。
