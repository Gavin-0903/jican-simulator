# 机惨模拟器 · 纯网页版

把原版「服务端权威」的游戏逻辑整包搬进浏览器。单机玩法、AI、道具、JC、结算与桌面版一致，另带一个「只当客户端」的联机模式。

## 两种打开方式

1. **单文件**：双击 `dist-web/index.html`（或根目录 `打开网页版.bat`），`file://` 直接玩，不需要 Node.js、不需要服务器。
2. **可单独拷走的文件夹**：`disk-web/`。整个文件夹拷到任何有 Python 3 的机器上，双击 `启动服务.bat` 或执行 `python serve.py`，浏览器打开 <http://127.0.0.1:8000>。也支持直接在该目录 `python -m http.server 8000`。

`disk-web/` 与项目其余部分没有任何运行时依赖：配置、存档等 JSON 全部存在浏览器 localStorage 里。详见 `disk-web/README.md`。

## 功能

- **单机**：大厅选角色 → 开始游戏；移动、提问、讨好、JC、道具、暂停/倍速、结算全部可用。
- **联机（客户端）**：大厅「联机」里填服务器源地址与 256 位 Token（「高级」中），即可创建/加入房间、选座、房主开局。加入普通房间后需房主批准座位（服务端 v0.8 排队制）。
- **不能自己当服务器源**：`/api/net/admin*` 一律 403，`/api/local/id` 只返回网页自身份；DevTools 也变不出监听逻辑（没有实现）。
- **配置**：大厅「设置 → config.json」可视化编辑 `config/default.json`、`llm.json`、`balance.json` 和联机段，写入浏览器。桌面版会落盘，网页版没有磁盘文件；**修改后刷新页面生效**。
- **存档**：对局中每 5 秒自动写入 localStorage，默认保留最近 10 局；刷新后大厅出现「继续上局」。续局以暂停状态载入，按空格继续。
- **移动端**：按 UA 自动判定手机/平板，也支持 `?mobile=1` / `?desktop=1` 强制切换。移动端使用左下虚拟摇杆 + 右下「交互/统计/提问/讨好/JC/积分/商店」按钮，道具栏改成顶部图标，HUD 收成两行；横屏时进一步压缩。设置 →「按键」里可查看当前设备判定。

## 重新构建

```bash
npm run build:web      # = node scripts/build-web.mjs，同时产出 dist-web/index.html 与 disk-web/index.html
```

构建原理（零第三方依赖）：

- 从 `web/runtime/boot.js` 出发遍历 `import` 图（`client/`、`shared/`、`server/`）。
- 每个 ES 模块编成 Blob URL，模块内的相对路径改写成裸标识符 `jican:<id>`，运行时注入 import map 解析——因此 `file://` 下也能互相 import。
- `node:events` / `node:perf_hooks` / `node:util` 用内置 shim 顶上；`config/*.json`、地图 SVG、图标、CSS 全部内联。
- `web/runtime/engine.js` 在浏览器里实例化 `GameMap` + `GameController` + `MessageRouter`，伪装成一条本地 WebSocket（`/ws`）喂给原版 `client/js/main.js`。
- `web/runtime/configStore.js` / `saveManager.js` 用 localStorage 实现原版 `ConfigAdmin` 与 `SaveManager` 的接口。
- `web/runtime/boot.js` 兜底 `/api/map`、`/api/lobby`、`/api/config*`、`/assets/*` 等接口；联机请求在有服务器源时转发到远端，否则返回可读错误。

## 数据存储（浏览器 localStorage）

| 键 | 内容 |
| --- | --- |
| `jican.web.config.default` / `.llm` / `.balance` | 改过的三个 config JSON 全文 |
| `jican.web.online` | 联机段配置 |
| `jican.web.save.index` | 存档索引 |
| `jican.web.save:round-…` | 单局完整存档 |
| `jican.web.source` / `.token` / `.idkey` | 联机服务器源、Token、本机网页身份 |

清除数据：开发者工具 → Application → Local Storage → 删除该地址下的 `jican.web.*`。

## 联机对服务器源的要求

服务器源必须是**本仓库当前版本**（相关改动在 `server/net/`，不影响单机）：

- `server/net/WsServer.js` 的 `originAllowed()` 允许 `Origin: null`（`file://` 页面发起 WebSocket 的 Origin）。
- `server/net/LobbyHttp.js` 的 CORS `access-control-allow-headers` 包含 `x-jican-client`（房间管理 POST 会带）。

启动服务器源：

```bash
node server/index.js --port 8899 --host 127.0.0.1 --server-source
```

## 自动冒烟

```bash
node scripts/web-smoke.mjs         # file:// 单机：大厅、开局、W 移动、截图 dist-web/game.png
node scripts/web-mobile-smoke.mjs  # 移动端：CDP 模拟 iPhone，设备判定、摇杆、技能按钮、横竖屏、桌面端对照
node scripts/disk-web-smoke.mjs    # disk-web：python serve.py + 配置读写持久化 + 自动存档 + 继续上局 + 配置面板
node scripts/web-online-smoke.mjs  # 联机：需先在 8899 起服务器源
```

## 已知限制

- 不能作为服务器源；联机房间依赖别人的服务器源。
- 配置修改与部分联机段设置在刷新页面后生效；没有服务端热重载。
- 更新检查、服务端管理、日志落盘等依赖 Node 进程的能力不可用。
- file:// 下数据按「文件路径」隔离，挪动文件或换电脑不会带走存档；想长期保存推荐用 `disk-web/` 起本地服务（固定端口即固定数据源）。
- localStorage 通常上限约 5MB；写满时存档会自动丢弃最旧的几局。
