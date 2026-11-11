# work/ —— 经常编辑/运行中使用的文件

和 `data/` 的区别：

- `data/`：很少改动的**静态基线/模板**（旧版快照、旧 ID、配置模板、隐私规则模板）；
- `work/`：当前正在用、正在改的文件。桥接/测试/构建从这里读取最新版本。

| 文件 | 用途 |
| --- | --- |
| `console.html` | 本地控制台前端（桥接 `GET /` 返回它） |
| `console-ui-contracts.json` | 控制台后端契约基线；改前端后用 `test-console-ui --original --record-baseline` 重录 |
| `config.json` | 本机配置（含 token / QQ 号，`work/.gitignore` 排除，不入库） |

`work/config.json` 由 `scripts/ensure-config.mjs` 在 `npm install`（postinstall）或
`npm start`（prestart）时自动补全，已存在时不会覆盖。想手动触发：

```sh
npm run ensure:config
```

改控制台相关文件后建议跑：

```sh
npm run preview:console
npm run test:console-ui
npm run test:audit
```
