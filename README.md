# 机惨模拟器 · jican-simulator

按《[技术方案 v0.0](docs/技术方案-v0.0.md)》实现的校园模拟器：30 名学生 + 5 名老师，你扮演其中一人，其余 34 人由规则 AI 驱动，围绕「积分获取」与「积分劫持（JC）」博弈。

**v0.2 新增**：5 件道具的系统、输入控制加固（禁用剪贴板 + 输入法强制英文）、TailScale Funnel 联机（房间 / ID 密钥 / 违规封禁）、Windows 双安装包发行版。

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
- 首次安装会在 `[Run]` 阶段以 `--setup` 静默调用一次主程序，询问**「是否把本机设为服务器源」**；回答结果写入 `data/settings.json`。
- 静默安装：`"机惨模拟器-Win10满血-v0.2beta-setup-1031.exe" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART`。

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

## 联机（TailScale Funnel P2P）

1. 用 TailScale 把本机对公网暴露：`tailscale funnel 5173`，得到一个 `https://xxxxx.ts.net`。
2. 安装时（或手动 `--server-source`）把某台机器设为**服务器源**；它会监听 `0.0.0.0` 并对外提供房间服务。
3. 首页可切换**单机 / 联机**。本机是服务器源时自动使用本机；否则需要手填 **服务器源 URL**（`https://xxxxx.ts.net`）与 **256 位 Token**。
4. 创建房间返回房间号、Token、8 位邀请码；其他人用「房间号 + Token」加入，校验通过即入房，否则服务端返回 500。

**ID 密钥**：首次运行生成，存于 `data/id.key`（安装版位于 exe 资源段 / 安装目录），格式为
`[时区]*[MAC]*[OS]*[默认语言]*[安装?用户名:系统应用数量]*[256 位随机]`，
每段取摘要后异或融合，再用 SHA-256 多轮摘要补齐为 **256 位十六进制**。格式被篡改时服务端直接返回 500。同一台电脑上的多个账号共享同一个 ID 密钥。

**防滥用**：同一 ID 密钥同时开多个房间视为「人机攻击」，记一次违规并标记该密钥；连续 3 次 → 该服务器源在 24 小时内对该密钥返回 500（封禁）。

服务端实现：`server/net/IdKey.js`（密钥生成/校验）、`server/net/RoomManager.js`（建房/入房/违规计数/封禁）、`server/net/LobbyHttp.js`（`/api/net/info`、`/api/net/join`、`/api/local/id`）。

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
| `npm test` | 单元 + 集成测试（99 项） |
| `npm run bench` | 35 角色满负载跑 3 局，输出单 tick 耗时与包体积 |
| `npm run lint` | 全部 JS 语法检查 + JSON 校验 |
| `npm run check-llm` | 本地模型连通性自检 |
| `npm run build:all` | 生成 Windows 两个发行版的单文件 exe |
| `npm run dist:win10` / `dist:win7` | 调用 Inno Setup 生成安装包 |

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
| `packaging/` | SEA 打包入口、资源收集脚本、Inno Setup 双脚本 |
| `tests/` | `unit/` 规则与工具；`integration/` 确定性回放、存档续局、真实 WS/HTTP、LLM 降级 |

更多文档：[实现说明 v0.2](docs/实现说明-v0.2.md) · [WebSocket 协议](docs/protocol/websocket-protocol.md) · [验收记录 v0.2](docs/验收记录-v0.2.md) · [实现说明 v0.1](docs/实现说明-v0.1.md)。
