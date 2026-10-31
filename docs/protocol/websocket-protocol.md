# WebSocket 协议速查（v1，含 v0.2 道具扩展）

连接地址：`ws://<host>:<port>/ws`（与页面同端口）。浏览器连接时 `Origin` 必须是本机回环地址且端口一致，否则握手返回 403。

## 消息信封

```jsonc
{ "v": 1, "type": "input.action", "seq": 128, "ts": 1750000000000, "payload": { } }
```

- `v` 协议版本，不符返回 `E_PROTO`。
- `seq` 客户端上行序号（服务端下行信封序号独立计数）；错误回执用 `refSeq` 指回出错的上行消息。
- 单条消息 ≤ 4096 字节；每连接每秒 ≤ 60 条，超出丢弃并提示一次 `E_RATE`。
- payload 采用白名单：未声明的字段、类型不符一律 `E_BADMSG`。

## 连接生命周期

| 阶段 | 行为 |
| --- | --- |
| 握手 | 连接后 5 秒内必须发 `hello`，否则断开；服务端回 `welcome`，随后补发 `phase` + `snapshot`（或增量） |
| 控制权 | 同一时刻只有一个「控制连接」。带上次 `sessionId` 的 `hello` 接管控制；没有控制连接时新连接成为控制者；其余为观战（发游戏指令返回 `E_SPECTATOR`） |
| 心跳 | 客户端每 5 秒 `ping`，服务端回 `pong`；15 秒无任何消息即断开 |
| 断线 | 控制连接断开时对局自动暂停（`pausedReason: "disconnect"`），同会话重连后自动继续 |
| 重连补发 | `hello` 带 `lastSeq`：若服务端历史（最近 50 包）连续，则只补发之后的 `delta`/`snapshot`；否则下发全量 |
| 缺包 | 客户端发现 `delta.seq` 不连续时发 `resync`，服务端回全量 |

## C → S

| type | payload | 说明 |
| --- | --- | --- |
| `hello` | `{clientVersion?, sessionId?, lastSeq?}` | 握手 / 重连 |
| `join` | `{characterId, role?, seed?}` 或 `{resume: true}` | 大厅或结算后开始新局 / 继续存档 |
| `leave` | `{}` | 结束本局并结算 |
| `lobby` | `{}` | 结算后回到大厅 |
| `input.move` | `{dir:{x,y}, face?}` | 方向向量（长度 ≤ 1）；`face` 为站立时的朝向弧度（老师用鼠标控制视野方向） |
| `input.action` | `{kind, pcId?, targetId?}` | `kind ∈ enterPc, leavePc, askQuestion, cancelAsk, flatter, viewScore, jc.open, inspectPc` |
| `jc.commit` | `{selfUsername, amount}` | 提交 JC：自己的用户名 + 正整数数量 |
| `item.buy` | `{itemId, amount?, buyType?}` | 购买道具。`amount` 默认 1（1–1000）；`buyType: "uses"` 表示给已持有的**定格手枪**补弹份数。服务端先扣 `score` 再改 `items` 与 `itemStats`，只扣一次 |
| `item.upgrade` | `{itemId}` | 升级道具一级；价格按「当前等级」求值（`upLevelPrice` 模板），已满级或未持有则 `E_ITEM` |
| `item.use` | `{itemId, targetId?, charId?, amount?, action?}` | 使用道具。定格手枪要 `targetId`；黑客手册先不带其它字段**只要全员列表**（不消耗次数），选定后带 `charId + action("set"|"add") + amount` 提交；买通/强密码/沙漏只用 `itemId` |
| `item.list` | `{}` | 请求道具清单（预留；当前道具状态随 `snapshot`/`delta` 的 `me` 下发，客户端 `item.list` 为空操作） |
| `set.speed` | `{mult}` | 0.5 / 1 / 2 |
| `pause` | `{on}` | 暂停 / 继续 |
| `ping` | `{t?}` | 心跳（`t` 原样回传，用于测延迟） |
| `resync` | `{}` | 请求全量快照 |

## S → C

| type | payload | 说明 |
| --- | --- | --- |
| `welcome` | `{protocolVersion, serverVersion, tickRate, mapId, serverTime, sessionId, role, resumed, lobby}` | `lobby` 含名单、规则数值、可继续的存档、LLM 状态 |
| `phase` | `{phase, roundMs, reason}` | `LOBBY / PLAYING / PAUSED / ENDED`；`reason` 为暂停原因 |
| `snapshot` | `{tick, seq, state:{game, chars, pcs, me, roster}, events}` | 全量：加入、重连时以及每 2 秒兜底 |
| `delta` | `{tick, seq, game?, chars?, pcs?, me?, events?}` | 每 tick 只发变化字段；`chars`/`pcs` 为 `[{id, ...变化字段}]` |
| `dialog` | `{kind, ...}` | 服务端驱动的界面：`pc`、`score_view`、`jc.open`、`jc_blocked`、`jc.result`、**`jc_locked`**、**`item_bought`**、**`item_upgraded`**、**`item_used`**、**`hack.targets`**、**`hack_result`**、`close`、`summary`（道具详见「道具对话框」） |
| `error` | `{code, message, refSeq, kind?}` | 见错误码 |
| `gameover` | `{reason, reasonText, winnerId, ranking, stats, summary, seed, durationMs}` | 结算 |
| `pong` | `{t, serverTime}` | 心跳应答 |

### 视图字段

- `game`：`phase, pausedReason, tick, elapsedMs, roundMs, targetScore, speedMult, playerCharId, seed, llm{mode, reason}`
- `chars[]`：`id, x, y, f(朝向), st(状态), ctl(human/ai), op(ask/operate/null), pc(正在使用的电脑), sp(台词), tl(厕所层数), ch(聊天室加成 %), fz(剩余定格毫秒)`。**不含积分**——学生积分只能在电脑上查看。`fz > 0` 表示被定格，客户端据此显示冻结遮罩与倒计时；定格是全员可见的公开效果，不做可见性裁剪。
- `pcs[]`：`id, op(操作者 id)`
- `me`（只发给控制者本人）：`salary`（老师）、`lastViewedScore / lastViewedTick / knownDelta`（学生上次查看的积分及之后自己知道的变化）、`cooldowns`（毫秒）、`asking`、`toiletMs / toiletLevel`、`attrMul`、`operatingPcId`、`stats` 等。
- `me` 的道具字段：`items{freeze|buyoff|password|hourglass|hackbook: {lv, uses}}`（深拷贝）、`itemPrices{ [id]: {price, upLevel|null, perUse|null} }`（当前等级下的买入价 / 下一级升级价 / 补弹单价，客户端不必重算模板）、`itemRoundCount`（本局各道具已用次数，沙漏与黑客手册据此显示剩余）、`itemStats{bought, upgraded, used, goldSpent, hackSuccess, hackFail, frozenTimes}`、`frozenMs`（自己剩余定格毫秒）、`unlockRemainMs`（自己在别人电脑上触发的强密码解锁剩余毫秒，> 0 时 JC 表单必须锁定）。
- `events[]`：`{type, tick, actorId, targetId, amount, pos, text, reason, ...}`，已按玩家视角过滤（本人、目标、或视线可见事件坐标）。类型：`jc_success, jc_victim, teacher_catch, score_changed, salary_changed, eliminated, failed, buff_gained, ask_started, ask_cancelled, inspect_clear, pc_kicked, round_start, round_end`，以及道具相关的 **`item_bought`**（`amount` 为花费金币）、**`item_upgraded`**、**`item_used`**、**`frozen`**（`amount` 为定格毫秒，`targetId` 为被定格者）、**`item_failed`**（黑客手册失败，`amount = -100`）、**`hack_result`**（`ok` 表示成败，`amount` 为积分变化量）。

## 错误码

| code | 含义 |
| --- | --- |
| `E_PROTO` | 协议版本不符 / 未先发 hello |
| `E_BADMSG` | 消息结构非法 |
| `E_NOTJOINED` | 未加入即发指令 |
| `E_OUTOFRANGE` | 交互超出范围 |
| `E_IMMUNE` | 目标处于免疫状态（主人正在用自己的电脑） |
| `E_BUSY` | 电脑正被他人占用 |
| `E_USERNAME` | JC 用户名不匹配 |
| `E_AMOUNT` | JC 数量非法或超限 |
| `E_COOLDOWN` | 冷却中 |
| `E_ELIMINATED` | 角色已淘汰 |
| `E_FORBIDDEN` | 身份不允许（如老师进入学生电脑、学生检查电脑） |
| `E_STATE` | 当前阶段不允许该操作 |
| `E_RATE` | 消息过于频繁 |
| `E_SPECTATOR` | 观战连接不能操作 |
| `E_ITEM` | 道具相关失败：金币不足 / 已拥有 / 已满级 / 次数用完 / 本局次数上限 / 参数非法 / 强密码锁定中。细节看 `lastResult.reason`，取值 `gold / owned / maxLevel / uses / round_limit / buyType / target / action / amount / locked / teacher_frozen` |
| `E_FROZEN` | 被定格期间不能移动、不能行动、提问进度暂停 |

## 道具对话框（`dialog.kind`）

| kind | 字段 | 时机 |
| --- | --- | --- |
| `item_bought` | `itemId, lv, uses, score` | 购买成功（`score` 为扣款后的余额） |
| `item_upgraded` | `itemId, lv, score` | 升级成功 |
| `item_used` | 定格：`itemId:"freeze", targetId, ms, uses`；买通：`itemId:"buyoff", seeThroughPct, lv`；强密码：`itemId:"password", lockMs, lv`；沙漏：`itemId:"hourglass", ms, affected, limit, used` | 使用成功 |
| `hack.targets` | `list:[{id, name, role, score, me}], failPct, expelPct` | 黑客手册第一步：只有列表，**不消耗次数**。老师排在前面，含自己 |
| `hack_result` | 成功 `{ok:true, targetId, delta, score, expelled, failPct, expelPct}`；失败 `{ok:false, targetId, penalty:100, expelled, failPct, expelPct}` | 黑客手册结算。`expelled` 为真时紧跟着再发 `dialog{kind:"close", reason:"eliminated"}` |
| `jc_locked` | `victimId, remainMs, lockMs` | JC 撞上对方的强密码：表单进入「破解中」，`remainMs` 归零前不能提交（重复提交只刷新剩余时间，不重置计时）。同时回 `error{code:"E_ITEM"}` |

## 示例：购买并使用定格手枪

```text
C→S  item.buy     {itemId:"freeze", amount:1}
S→C  dialog       {kind:"item_bought", itemId:"freeze", lv:1, uses:10, score:9850}
S→C  delta        {me:{items:{freeze:{lv:1,uses:10}}, itemPrices:{freeze:{price:150, upLevel:50, perUse:5}}}, events:[{type:"item_bought", actorId:"s1-07", amount:150}]}
C→S  item.use     {itemId:"freeze", targetId:"s1-04"}
S→C  delta        {chars:[{id:"s1-04", fz:1000}], events:[{type:"frozen", actorId:"s1-07", targetId:"s1-04", amount:1000}]}
S→C  dialog       {kind:"item_used", itemId:"freeze", targetId:"s1-04", ms:1000, uses:9}
```

## 示例：JC 撞上强密码

```text
C→S  jc.commit    {selfUsername:"s1-07", amount:120}
S→C  error        {code:"E_ITEM", message:"这台电脑上了强密码，需要先解锁", reason:"locked", remainMs:3000}
S→C  dialog       {kind:"jc_locked", victimId:"s1-04", remainMs:3000, lockMs:3000}
…3 秒后（me.unlockRemainMs 归零）…
C→S  jc.commit    {selfUsername:"s1-07", amount:120}
S→C  dialog       {kind:"jc.result", amount:120, caught:false}
```

## 示例：JC 成功

```text
C→S  join          {characterId:"s1-07", role:"student"}
S→C  phase         {phase:"PLAYING"}
S→C  snapshot      {tick:0, seq:12, state:{…}}
C→S  input.move    {dir:{x:0,y:1}}
C→S  input.action  {kind:"enterPc", pcId:"pc-c1-04"}
S→C  dialog        {kind:"pc", pcId:"pc-c1-04", own:false, ownerName:"许知秋", ownerScore:200, canJc:true}
C→S  input.action  {kind:"jc.open", pcId:"pc-c1-04"}
S→C  dialog        {kind:"jc.open", pcId:"pc-c1-04", ownerScore:200}
C→S  jc.commit     {selfUsername:"s1-07", amount:120}
S→C  delta         {seq:87, chars:[…], me:{knownDelta:120}, events:[{type:"jc_success", actorId:"s1-07", targetId:"s1-04", amount:120}]}
S→C  dialog        {kind:"jc.result", amount:120, caught:false}
```
