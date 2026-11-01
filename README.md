# 机惨模拟器 · jican-simulator

按《[技术方案 v0.0](docs/技术方案-v0.0.md)》实现的校园模拟器：30 名学生 + 5 名老师，你扮演其中一人，其余 34 人由规则 AI 驱动，围绕「积分获取」与「积分劫持（JC）」博弈。

**v0.2 新增**：5 件道具的系统、输入控制加固（禁用剪贴板 + 输入法强制英文）、TailScale Funnel 联机（房间 / ID 密钥 / 违规封禁）、Windows 双安装包发行版。

**v0.3 新增**：安装后**强制检测 TailScale 并自动开启联机**（缺 TailScale 时安装向导询问并引导下载）、软件内「设置 → 输入与联机」一键切 Serve / Funnel、主程序改名 `jican-simulator.exe` 并写入自绘图标与版本信息。

- **服务端权威**：Node.js 固定 10 Hz 逻辑帧，玩家和 AI 走同一条指令队列、同一套规则。道具的购买、升级、使用、结算全部在服务端判定。
- **原生 SVG**：地图、角色、图标全部自绘，前端零构建、零外网请求，离线可玩。
- **视野遮挡**：墙、隔板、柜子等完全挡住视线；桌子、沙发能藏住紧贴在后面的人。看不到的区域显示为黑色。
- **LLM 可选**：本地 Ollama（Qwen2-0.5B）只负责台词与性格倾向；没有模型时自动降级为纯规则 AI，不影响游玩。
- **生产依赖只有 `ws` 一个**；测试使用 Node 内置 `node:test`。

## 安装包（Windows 发行版）

仓库里的 `dist/` 为构建产物（已被 `.gitignore` 忽略），用 `npm run build:all` 现场生成：

| 安装包 | 目标平台 | 说明 |
| --- | --- | --- |
| `机惨模拟器-Win10满血-v0.2beta-setup-1031.exe` | Windows 10 / 11 x64 | 单文件自带运行时（Node SEA），**满血版**：内嵌 `ws`，无需安装 Node.js |
| `机惨模拟器-Win7兼容-v0.1dev-setup-1031.exe` | Windows 7 SP1 x86 / x64 | **兼容版**：安装目录同样自带 exe，Node 20+ 二进制不支持 Win7，因此运行期退回系统 Node.js（需先装 Node 18） |

- 两个安装包都声明 `PrivilegesRequired=admin`，**非管理员运行时会自动弹出 UAC 提权**（内部提权）。
- 主程序统一叫 **`jican-simulator.exe`**（两个 flavor 同名），图标与版本信息由 `packaging/win/IconRes.cs` 在打包后写入 PE 资源段（`RT_GROUP_ICON` + `RT_VERSION`）。
- **双击请用 `jican-simulator-launcher.exe`**（开始菜单与桌面快捷方式都指向它）：它是 GUI 子系统（`/target:winexe`）的**常驻宿主**，不弹黑框，会自己弹出**内嵌 WebView2 的应用窗口**并常驻**系统托盘**（见 v0.4 变更）。直接双击 `jican-simulator.exe` 仍然可用，但会带一个黑窗口，关掉黑窗口服务就停。
- **安装即开联机（v0.3）**：安装向导先检查 `%ProgramFiles%\Tailscale\tailscale.exe`；
  - 已安装 → 装完自动以 `jican-simulator.exe --setup --server-source` 跑一次，检测 TailScale、生成 256 位 Token、写 `data/config.json`，并用 `tailscale serve --bg 5173` 暴露给同一 tailnet。
  - 未安装 → 弹窗询问是否去下载；同意则打开 https://tailscale.com/download/windows，装完双击开始菜单里的「**机惨模拟器（一键联机配置）**」即可补做。
- 静默安装：`"机惨模拟器-Win10满血-v0.2beta-setup-1031.exe" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART`。
- **没装浏览器也能玩（v0.4）**：应用窗口内嵌 Edge WebView2，Windows 11 与绝大多数 Windows 10 已预装；没有运行时的机器上宿主会引导安装，仍失败则退回系统默认浏览器，服务照常跑。

打包命令：

```bash
npm i -D postject          # 一次性
npm run build:all          # 生成 dist/win10-full、dist/win7-compat（单文件 exe + assets.json）
npm run dist:win10         # 调 Inno Setup 出安装包到 dist/inno
npm run dist:win7
```

## 快速开始（源码运行）

需要 Node.js 20 或以上版本。

| 方式 | 操作 |
| --- | --- |
| macOS | 双击 `启动游戏.command` |
| Windows | 双击 `启动游戏.bat` |
| 终端 | `npm install` 后执行 `npm run play`（自动打开 960×600 窗口）或 `npm start`（只启动服务） |

默认地址 `http://127.0.0.1:5173`。端口被占用时会自动尝试 5174～5183，以终端打印的地址为准。首次运行需要联网安装 `ws`，之后完全离线可用。

## 怎么玩

**学生**

1. 去办公室，靠近老师按 `Q` 提问，在老师身边连续停留 10 秒得 50 分（冷却 30 秒，每局 10 次）。
2. 按 `F` 讨好老师：成功率 40%～80%（随老师好感度变化），成功得 0～100 分，失败扣 5～40 分。
3. 走到别人的电脑旁按 `E` 进入，可以看到对方积分；按 `J` 打开 JC，输入**自己的用户名**和数量 x（x ≤ 对方积分），对方 −x，你 +x。
4. JC 提交的一瞬间，如果在老师视野（橙色扇形）内且没被遮挡，可能被目击：扣除相应积分，老师工资 +100￥。老师走近检查到你在用别人的电脑，也会扣 30 分。
5. 积分只能回**自己的电脑**按 `V` 查看；正在用自己电脑时别人无法 JC 你（免疫），但你不能移动。
6. 厕所每停留 3 秒速度 +10%（最多 5 层，离开后按半衰期衰减）；聊天室全属性每秒 +0.01%。
7. 积分 ≤ −1000 被淘汰。率先达到 2000 分立即获胜，否则 10 分钟后按积分排名。
8. 按 `B` 打开道具商店，`1`～`5` 使用已购道具（详见下节）。

**老师**

- 鼠标控制朝向。扇形视野 260 px、±60°，墙和桌子会挡住视线。
- 亲眼看到学生 JC 自动获得 +100￥。电脑旁出现**红圈**说明有人在用别人的电脑，走近按 `E` 检查即可抓获。
- 本班学生每被 JC 一次，任课老师工资 −20￥。初始工资 200￥，**工资 < 0 即失败**（AI 老师不会失败）。办公室常驻老师不带班，不承担扣薪。

**快捷键**：`WASD`/方向键移动（也可按住鼠标左键朝鼠标方向移动）· `E`/空格 交互 · `Q` 提问 · `F` 讨好 · `J` JC · `V` 查看积分 · `B` 道具商店 · `1`～`5` 使用道具 · `Esc` 关闭/暂停 · `Tab` 统计 · `+`/`−` 倍速 · `M` 切换镜头。右上角 ✕ 结束本局并结算。

## 道具系统（v0.2）

商店用**金币**购买，金币池与积分挂钩（服务端判定，客户端只做展示）。价格/升级价均在 `config/balance.json` 的 `items` 键里，支持 `"{Lv} * 50"` 这样的等级表达式。

| 道具 | 价格 | 等级上限 | 升级价 | 使用次数 | 效果 |
| --- | --- | --- | --- | --- | --- |
| 买通老师 `buyoff` | 200 | 10 | `{Lv} * 50` | 1 | 使老师有 `{Lv*10}%` 概率看到你 JC 却不阻止、不扣分（视野目击概率按等级线性削减） |
| 强密码 `password` | 50 | 5 | `{Lv} * 80` | ∞（不可重复购买） | 别人 JC 你时要先花 `{Lv}` 秒解锁才能操作电脑；解锁后放行一次 |
| 定格手枪 `freeze` | 150 | 10 | `{Lv} * 50` | 10 | 选屏幕上一人定格 `{Lv}` 秒；可重复购买，也可用 `{Lv*5}` 金币买「使用次数」（5 次一升级） |
| 时间沙漏 `hourglass` | 850 | 15 | `{Lv} * 240` | 10 | 除自己外全员定格 `{Lv}` 秒，每局最多 `ceil(Lv/2)` 次 |
| 黑客手册 `hackbook` | 1250 | 10 | `{Lv} * 500` | 5 | 查看/增改全员（含老师与自己）积分或工资；失败率 `{100-Lv*10}%`，被校长发现开除率 `{100-Lv*8}%`，**每局最多 1 次，风险极高** |

实现要点：

- 服务端 `server/systems/ItemSystem.js` 是唯一判定点，插入 `GameLoop` 的 pipeline 中（`move` 之后、`interaction` 之前）。
- 消息 `item.buy` / `item.upgrade` / `item.use` / `item.list`，事件 `item_bought` / `item_upgraded` / `item_used` / `item_failed` / `frozen` / `hack_result`。协议见 [WebSocket 协议](docs/protocol/websocket-protocol.md)。
- 冻结状态由 `MoveSystem` 跳过移动实现，客户端只负责画冻结遮罩与倒计时。

## 输入控制（v0.2）

按需求做了三层加固，命中时**静默吞掉**而不是弹窗打扰：

1. 捕获阶段的 `copy` / `cut` / `paste` 事件拦截（`client/js/util/ime.js` 的 `installInputGuards()`）。
2. `Ctrl/Cmd + A/C/V/X`、`Ctrl+Insert`、`Shift+Insert` 在 `InputManager` 里最先 `preventDefault()`。
3. 输入法强制英文：`ime-mode: disabled` + `forceEnglishInput()` 对所有 `input`/`textarea`/`contentEditable` 生效 + `MutationObserver` 跟踪新插入的输入框 + `compositionstart` 打断中文候选。

## 联机（TailScale Serve / Funnel）

1. 用 TailScale 把本机暴露出去：`tailscale serve --bg 5173`（仅同一 tailnet 内可访问）或 `tailscale funnel 5173`（公网可访问，需先在 TailScale 管理后台为这台机器开启 Funnel 能力），得到一个 `https://xxxxx.ts.net`。
2. 安装时（或手动 `jican-simulator.exe --setup --server-source`）把某台机器设为**服务器源**；它会监听 `0.0.0.0` 并对外提供房间服务。安装包已内置这一步，正常安装完就是服务器源。
3. 首页可切换**单机 / 联机**。本机是服务器源时自动使用本机；否则需要手填 **服务器源 URL**（`https://xxxxx.ts.net`）与 **256 位 Token**。
4. 创建房间返回房间号、Token、8 位邀请码；其他人用「房间号 + Token」加入，校验通过即入房，否则服务端返回 500。

**ID 密钥**：首次运行生成，存于 `data/id.key`（安装版位于 exe 资源段 / 安装目录），格式为
`[时区]*[MAC]*[OS]*[默认语言]*[安装?用户名:系统应用数量]*[256 位随机]`，
每段取摘要后异或融合，再用 SHA-256 多轮摘要补齐为 **256 位十六进制**。格式被篡改时服务端直接返回 500。同一台电脑上的多个账号共享同一个 ID 密钥。

**防滥用**：同一 ID 密钥同时开多个房间视为「人机攻击」，记一次违规并标记该密钥；连续 3 次 → 该服务器源在 24 小时内对该密钥返回 500（封禁）。

服务端实现：`server/net/IdKey.js`（密钥生成/校验）、`server/net/RoomManager.js`（建房/入房/违规计数/封禁）、`server/net/LobbyHttp.js`（`/api/net/info`、`/api/net/join`、`/api/local/id`）。

### 设置页里的「输入与联机」（v0.3）

游戏内右上角 ⚙ →「输入与联机」区块会实时读 `GET /api/net/online`：

- 未开启联机 → 显示「联机未开启：本机按单机模式运行」。
- 已开启 → 显示当前服务器地址与 Token 状态，并提供 **Serve（仅 tailnet）/ Funnel（公网）** 分段按钮；点击直接 `POST /api/net/online/mode`，真调 `tailscale serve|funnel`，失败会把原因（如「需要先在 TailScale 后台开启 Funnel」）显示在区块里，不会弹错误框。

### 命令行

| 命令 | 作用 |
| --- | --- |
| `jican-simulator.exe --setup` | 检测 TailScale，按已保存的设置开/关联机 |
| `jican-simulator.exe --setup --server-source` | 强制把本机设为服务器源并自动暴露 |
| `jican-simulator.exe --setup --client --no-tailscale` | 强制关闭联机（单机模式） |
| `jican-simulator.exe --setup --server-source --expose funnel` | 用 Funnel（公网）暴露 |

`--setup` 结束时会打印一行 `SETUP_RESULT={...}`（JSON），安装向导的 `[Code]` 段就读这一行判断是否已经可用。

## 存档、断线与配置

- 每 5 秒、暂停、结算、关闭服务时自动存档到 `data/saves/`（每局一个文件，保留最近 10 局）。大厅出现「继续上局」时可以接着玩，读档后默认暂停。
- 浏览器断线时游戏自动暂停；刷新页面或网络恢复后自动重连并继续。同一时刻只有一个窗口能控制游戏，其他窗口为观战。
- 所有数值都在 `config/`：`default.json`（端口、帧率、回合时长、目标积分）、`balance.json`（全部平衡参数 + 道具定义）、`llm.json`（模型）、`maps/default.json`（地图）。
- **热调参**：修改 `config/balance.json`，或新建 `data/override.json`（例如 `{"balance": {"ask": {"reward": 80}}}`），下一帧即生效，无需重启。非法数值会被拒绝并在终端提示。

## 可选：本地 LLM

```bash
ollama pull qwen2:0.5b
npm run check-llm
```

启动时自动检测 `http://localhost:11434`。可用时 AI 的台词与性格倾向由模型生成；超时（2 秒）、输出不合格或连续失败 3 次会熔断 60 秒并回落到模板台词。也支持 OpenAI 兼容服务（LM Studio、vLLM），在 `config/llm.json` 把 `provider` 改成 `openai-compat`，密钥通过环境变量 `JICAN_LLM_API_KEY` 传入。LLM 不参与任何数值、目击或移动判定。

## 开发

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 启动服务，`server/` `shared/` `config/` 变化时自动重启 |
| `npm test` | 单元 + 集成测试（128 项） |
| `npm run bench` | 35 角色满负载跑 3 局，输出单 tick 耗时与包体积 |
| `npm run lint` | 全部 JS 语法检查 + JSON 校验 |
| `npm run check-llm` | 本地模型连通性自检 |
| `npm run build:all` | 生成 Windows 两个发行版的单文件 exe |
| `npm run dist:win10` / `dist:win7` | 调用 Inno Setup 生成安装包 |
| `python packaging/icons/make-icon.py` | 重新生成应用图标（PNG 512×512 + 多尺寸 .ico） |

调试端点：`/debug/health`（tick 耗时、内存、LLM 状态）、`/debug/llm-status`、`/api/net/info`、`/api/local/id`。地址栏加 `?debug` 会在控制台暴露 `window.__jican`。

### 目录

| 位置 | 内容 |
| --- | --- |
| `shared/` | 前后端共享：协议常量、几何（视线、扇形、可见多边形、碰撞） |
| `server/core/` | 状态容器、固定步长主循环、快照/增量、可复现随机数、流程控制 |
| `server/systems/` | 移动、交互（JC/提问/讨好/检查）、**道具**、增益、视野目击、积分工资、结算 |
| `server/ai/` | 规则 AI：感知 → 黑板 → 效用评分（softmax）→ 行为库 → 意图指令 |
| `server/llm/` | LLM 网关（限流/超时/熔断/降级/Schema 校验）、Provider、提示词、模板台词 |
| `server/net/` | HTTP/WebSocket、协议校验、**ID 密钥、房间管理、联机大厅路由** |
| `server/persistence/` | 配置装载与热重载、原子存档、**安装设置（服务器源）** |
| `client/` | `index.html` + 原生 ES Module：渲染、输入、状态镜像、UI 组件（含 `ItemShop`/`ItemBar`/`HackPanel`/`NetPanel`）；`assets/` 自绘 SVG |
| `packaging/` | SEA 打包入口（`sea-entry.cjs`）、资源收集（`build.mjs`）、图标生成（`icons/make-icon.py`）、PE 资源注入（`win/IconRes.cs`）、**无黑框外壳（`win/Launch.cs` + `win/LaunchGen.cs` + `launcher.cjs`）**、Inno Setup 双脚本 |
| `tests/` | `unit/` 规则与工具；`integration/` 确定性回放、存档续局、真实 WS/HTTP、LLM 降级 |

更多文档：[实现说明 v0.2](docs/实现说明-v0.2.md) · [WebSocket 协议](docs/protocol/websocket-protocol.md) · [验收记录 v0.2](docs/验收记录-v0.2.md) · [实现说明 v0.1](docs/实现说明-v0.1.md)。

## v0.3 变更

- **安装即联机**：安装包装完自动跑 `--setup --server-source`，本机成为服务器源并通过 `tailscale serve` 暴露给 tailnet；检测不到 TailScale 时向导询问并引导下载。
- **设置页联机区块**：显示服务器地址 / Token 状态，可一键在 Serve（仅 tailnet）与 Funnel（公网）之间切换，失败原因就地展示。
- **发行物**：主程序改名 `jican-simulator.exe`（两个 flavor 同名），自绘图标（深蓝圆角方块 + 蓝色显示器 + 黄色感叹号）写入 exe；PE 版本信息为 `机惨模拟器 / jican-simulator.exe`。
- **数据目录迁移到用户目录**：安装到 `C:\Program Files` 后安装目录对普通用户只读（`BUILTIN\Users:(RX)`），旧的 `<exe目录>/data` 一落盘就 `EPERM`。现在资源（`server/client/config`）仍是安装时静态展开的 `<exe目录>/data/unpacked`（只读），**运行期可写数据统一在 `%LOCALAPPDATA%\JicanSimulator\`**（`config.json` / `settings.json` / `id.key` / `saves/` / `logs/`），可用环境变量 `JICAN_DATA_DIR` 覆盖（便携版、共享电脑、CI）。
- **无黑框启动（新增 `jican-simulator-launcher.exe`）**：Node SEA 产物必然是控制台程序，双击必弹黑框、关掉黑框服务就停。发行版因此拆成两层——`jican-simulator-launcher.exe` 是 GUI 子系统（`/target:winexe`）外壳，内嵌一份 node 运行时与启动脚本，首次运行释放到 `%LOCALAPPDATA%\JicanSimulator\runtime\rt-<指纹>\`，再用 `CREATE_NO_WINDOW` 拉起 `jican-simulator.exe --serve`。**快捷方式指向 launcher**；需要看日志时用开始菜单的「（调试窗口）」项（等价于 `launch -debug`，会保留黑窗口）。
- **修复**：单文件 exe 下 `--setup` 参数被静默忽略（`isMain` 判定在 SEA 里永不成立）；设置页点击 ⚙ 无法打开（`buildBody` 的 `this` 丢失导致 `Cannot read properties of undefined (reading 'net')`）。

## v0.4 变更：内嵌应用窗口 + 系统托盘

以前双击启动器会拉起服务、再拿系统浏览器打开网页——**宿主机器上没装浏览器就没法玩**，而且窗口关掉后进程还藏在后台、桌面上看不到任何痕迹。

- **内嵌应用窗口**：`jican-simulator-launcher.exe` 现在是 WinForms 宿主，用 **Edge WebView2** 在窗口客户区里直接渲染游戏页面（`http://127.0.0.1:<port>/`），效果等同 DeepSeekHarness 那种自带浏览器的桌面应用，但不需要背 340 MB 的 Chromium——WebView2 是 Windows 系统组件。
- **系统托盘**：宿主常驻托盘图标（右键：显示主界面 / 在浏览器中打开 / 查看服务日志 / 重启服务 / 退出；左键单击显示或隐藏）。窗口点 X 是**最小化到托盘**，服务继续在后台跑；只有托盘「退出」才真正关停服务。
- **三层兜底**：WebView2 可用 → 内嵌窗口；初始化失败且没装运行时 → 引导安装 Evergreen Runtime（`https://go.microsoft.com/fwlink/p/?LinkId=2124703`）；仍不行 → 退回系统默认浏览器，窗口与托盘保留（即 v0.3 行为）。
- **调试**：开始菜单「（调试窗口）」项 = `jican-simulator-launcher.exe --debug`，保留控制台黑窗、打开 DevTools 与右键菜单。
- **宿主链路**：`launch.exe` 直接用 `CreateProcess(CREATE_NO_WINDOW)` 拉起同目录的 `jican-simulator.exe --serve --data-dir <数据目录>`（标准句柄接到 NUL，避免子进程因句柄无效一启动就死）→ 轮询数据目录里的 `server.port` → 弹出内嵌窗口。**不再经过 `node-runtime.exe`**：它是 SEA 单文件，`argv[1]` 会被当成业务参数而不是脚本，`node-runtime.exe launcher.cjs` 实际不会执行那个脚本（进程活着、服务也起着，却什么都不写，排查时极具误导性）。
- **数据目录**：宿主与子进程统一用 `%LOCALAPPDATA%\JicanSimulator\`。优先级 `--data-dir` 参数 > 环境变量 `JICAN_DATA_DIR` > `<exe目录>/data`——宿主自己的 `CreateProcess` 传不了自定义环境块，所以数据目录只能走命令行参数。宿主启动诊断写 `<数据目录>/logs/host.log`（WebView2 初始化与导航结果都在里面）。
- **修复的三个真问题**：① 宿主 `CreateProcess` 时 `bInheritHandles=false`，子进程标准句柄无效、一启动就死（现在把 NUL 的句柄继承过去）；② `sea-entry.cjs` 以前只能靠环境变量拿数据目录，而宿主的 `CreateProcess` 传不了环境块，服务把 `server.port` 写到一边、宿主去 `%LOCALAPPDATA%` 读另一边，表现为「服务启动超时」而后台服务其实活着（现在改走 `--data-dir` 命令行参数）；③ WebView2 托管程序集（`Microsoft.Web.WebView2.*.dll`）与原生 `WebView2Loader.dll` 以前没随包分发，宿主一启动就 `FileNotFoundException: Microsoft.Web.WebView2.Core`。现在 `build.mjs` 会把它们拷到 `dist/<flavor>/`，Inno 脚本也会装到 `{app}` 与 `{app}\runtimes\win-x64\native\`。
- 设计说明见 [docs/设计-v0.4-内嵌窗口与托盘.md](docs/设计-v0.4-内嵌窗口与托盘.md)。

## v0.5 变更：设置页 = 联机控制台

双击应用窗口右上角 ⚙（或按设置键）打开**设置**，现在是一个带三个标签（**联机 / 画面 / 操作**）的联机控制台，所有数据都是打开面板那一刻向本机服务端实时问的，不是前端猜的。

| 区块 | 能看到什么 | 能做什么 |
| --- | --- | --- |
| **ID 密钥** | 掩码 `5361d110…`、`<数据目录>\id.key`、长度 256 字符（256 位十六进制） | 「显示完整」展开全文、「复制」（走按钮，游戏内已禁用 Ctrl+C） |
| **本机联机服务器** | 运行状态灯（已启动 / 未启动）、本页地址、监听地址、对外地址（`https://<节点>.<tailnet>.ts.net`）、数据目录、房间数（可展开列表）、监听端口 | 「开启联机」「重启服务器」，端口在 5173（默认）/ 当前端口 之间切 |
| **联机 Token** | 掩码 `928890e1…4d4f`、长度 | 「显示完整」（**二次确认**后才向服务端取一次全文）、「生成 / 重新生成」（旧 Token 立刻失效，已加入的房间要重新要口令）、「复制」 |
| **TailScale** | 版本、桌面服务、登录状态（BackendState）、节点名、MagicDNS 地址、Funnel 允许端口 | 三选一：**Serve（tailnet 内）/ Funnel（公网）/ 关闭**；切换中按钮禁用并显示「切换中…」，失败原样展示服务端原因 |
| **配置漂移** | 配置与实际状态的 13 类不一致（如「本机联机服务器已启动但 TailScale serve 没指向它」） | 每条「一键修复」直接切模式或改配置 |

- **数据来源**：`GET /api/net/admin`（回环限定，脱敏：**不含完整 Token、不含完整 ID 密钥**）、`GET /api/net/admin/token`（回环限定，取完整 Token）、`POST /api/net/token/regenerate`（回环限定，只回掩码）、`GET /api/net/online`（兜底）、`POST /api/net/online/mode`（回环限定）。非本机来源一律 403。
- **完整 ID 密钥**仍只在 `GET /api/net/info` 的 `idKey` 字段（联机加入必需），`/api/net/admin` 只给 `hint/length/file`。
- **Funnel 端口**：TailScale 的 Funnel 只允许 **443 / 8443 / 10000**。本机服务跑在 5173，对外靠 `tailscale serve` 把 `https://<节点>.ts.net:443` 反向代理到 `http://127.0.0.1:5173`；所以「对外地址」永远是 443 的 https 地址，改端口不会改变对外的 443 入口。
- **安全**：面板里展开的 Token / 密钥只存在内存，不写日志、不进地址栏、不进 `console`；页面 CSP 仍是 `default-src 'self'`，没有为这个面板放宽任何一条。
- 设计说明见 [docs/设计-v0.5-设置页联机控制台.md](docs/设计-v0.5-设置页联机控制台.md)。

