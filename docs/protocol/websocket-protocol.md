# WebSocket 协议速查（v1）

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
| `dialog` | `{kind, ...}` | 服务端驱动的界面：`pc`、`score_view`、`jc.open`、`jc_blocked`、`jc.result`、`close`、`summary` |
| `error` | `{code, message, refSeq, kind?}` | 见错误码 |
| `gameover` | `{reason, reasonText, winnerId, ranking, stats, summary, seed, durationMs}` | 结算 |
| `pong` | `{t, serverTime}` | 心跳应答 |

### 视图字段

- `game`：`phase, pausedReason, tick, elapsedMs, roundMs, targetScore, speedMult, playerCharId, seed, llm{mode, reason}`
- `chars[]`：`id, x, y, f(朝向), st(状态), ctl(human/ai), op(ask/operate/null), pc(正在使用的电脑), sp(台词), tl(厕所层数), ch(聊天室加成 %)`。**不含积分**——学生积分只能在电脑上查看。
- `pcs[]`：`id, op(操作者 id)`
- `me`（只发给控制者本人）：`salary`（老师）、`lastViewedScore / lastViewedTick / knownDelta`（学生上次查看的积分及之后自己知道的变化）、`cooldowns`（毫秒）、`asking`、`toiletMs / toiletLevel`、`attrMul`、`operatingPcId`、`stats` 等。
- `events[]`：`{type, tick, actorId, targetId, amount, pos, text, reason, ...}`，已按玩家视角过滤（本人、目标、或视线可见事件坐标）。类型：`jc_success, jc_victim, teacher_catch, score_changed, salary_changed, eliminated, failed, buff_gained, ask_started, ask_cancelled, inspect_clear, pc_kicked, round_start, round_end`。

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
