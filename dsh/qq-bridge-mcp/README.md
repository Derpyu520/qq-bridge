# @local/qq-bridge-mcp

qq-bridge 的三个 MCP server 行（`mcp-snowluma` / `mcp-snowluma-host` / `mcp-web-search-safe`），以 **bundle** 形式提供。

## 为什么单独做成 bundle

这三行以前由 `scripts/setup-dsh.mjs` 直接写进 profile 的 `cordis.patch.yml`（`BEGIN/END` 区块）。那种做法有三个结构性问题：

1. `js-yaml` 不保留注释 —— 第一次运行就会抹掉自己和其它安装器的标记，下次只能再追加一份，导致重复 id、工具消失；
2. 区块固定在文件末尾，DSH 设置页追加的行会落进区块内部，下次整块替换就删掉用户设置；
3. 整文件读-改-写没有文件锁，和设置页保存并发时后写者覆盖前者。

bundle 把这三行变成**随包发布的只读 patch**：`plugin_manager install_bundle` 只改 profile 的 `package.json`（`dsh.profile.bundles`），不碰 profile patch，也就不存在覆盖用户配置的问题。

## 安装

```
plugin_manager install_bundle target=link:C:\qq机器人\qq-bridge\dsh\qq-bridge-mcp
```

安装后应看到三条 MCP 行 `active`，并有 `mcp__snowluma__*` / `mcp__snowluma_host__*` / `mcp__web_search_safe__*` 工具。

## 卸载

```
plugin_manager remove_bundle target=@local/qq-bridge-mcp
```

## 改配置

- **改这里**：`cordis.patch.yml`（行 id 不要改，`serverName` 也不要改，否则工具前缀会变）。
- 改完重跑 `install_bundle`（link 安装会重读文件）或重启 DSH。
- **不要**再让安装器往 profile patch 里写这几个 id；profile 里如果还残留同名 `- id:` 覆盖行（例如 `disabled: true`），会把这个 bundle 的行关掉，必须删掉。

## 路径依赖

`command` 写死 `C:\Program Files\nodejs\node.exe`，`args` 指向仓库里的 `src/*.js`。挪动 qq-bridge 目录后要回来改这两个地方。
