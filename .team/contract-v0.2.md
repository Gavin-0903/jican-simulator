
【共享契约 v0.2 —— 已由 Lead 写入 config/balance.json、shared/constants.js、server/net/Protocol.js。凡与本契约冲突，以本消息为准。】

## 1) 道具定义（config/balance.json 顶层新增 "items" 键）
```json
"items": {
  "freeze": { "price": 150, "maxUses": 10, "maxLevel": 10, "upLevelPrice": "{Lv} * 50", "perUsePrice": "{Lv} * 5", "freezeMsPerLevel": 1000, "repeatable": true },
  "buyoff": { "price": 200, "maxUses": 1, "maxLevel": 10, "upLevelPrice": "{Lv} * 50", "seeThroughPctPerLevel": 10, "repeatable": true, "oncePerRound": false },
  "password": { "price": 50, "maxUses": 1000000000000, "maxLevel": 5, "upLevelPrice": "{Lv} * 80", "lockMsPerLevel": 1000, "repeatable": false },
  "hourglass": { "price": 850, "maxUses": 10, "maxLevel": 15, "upLevelPrice": "{Lv} * 240", "freezeMsPerLevel": 1000, "maxPerRoundByLevel": "ceil(Lv/2)", "repeatable": true },
  "hackbook": { "price": 1250, "maxUses": 5, "maxLevel": 10, "upLevelPrice": "{Lv} * 500", "failPctBase": 100, "failPctPerLevel": 10, "expelPctBase": 100, "expelPctPerLevel": 8, "maxPerRound": 1, "repeatable": true, "risk": "extreme" }
}
```
数值含义（权威解释）：
- 定格手枪 freeze：射出后使**指定角色**定格 `Lv` 秒（freezeMsPerLevel=1000）。可重复购买（叠加次数）。也支持「购买使用次数」：每次消耗 `Lv*5` 金币买 `Lv` 次使用次数（perUsePrice 模板）。
- 买通老师 buyoff：持有后，老师看到你的 JC **只有 `Lv*10`% 概率真正看见**（即 1 - Lv*10% 概率被无视：看见但不阻止、不扣分）。实现方式：VisionSystem 对 actor 有 buyoff 时用 `1 - Lv*0.10` 作为「目击无效」概率，即最终命中概率 p *= (1 - Lv*0.10)... 注意：**必须是「看不见」而不是「看见但不处罚」**——若老师仍获得 catchReward 但学生不扣分，也接受（等价于"看见了也不管"）。**采用：p_effective = p * (1 - Lv*0.10)**，若判定未命中则该老师的目击作废（不阻止、不扣分、不得奖励）。Lv>=10 时 p_effective=0。
- 强密码 password：**不可重复购买**（repeatable=false，买一次即永久持有，等级可升）。当别人（其他学生）对你发起 JC 时，对方需先「解锁」`Lv` 秒才能操作电脑（解锁期间 JC 表单被锁定并倒计时，期间不能提交）。解锁状态按 (攻击者, 受害者) 记忆，每次触发重新计时。
- 时间沙漏 hourglass：全屏除自己外**所有角色**（学生+老师+AI）定格 `Lv` 秒；每局最多使用 `ceil(Lv/2)` 次（由 maxPerRoundByLevel 计算）。
- 黑客手册 hackbook：打开全员列表（含老师与自己），可 增/改/查 任意角色的 积分（学生）/工资（老师）。操作失败概率 `max(0, 100 - Lv*10)`%（失败 → 自己扣 100 分且不生效）；被校长发现开除概率 `max(0, 100 - Lv*8)`%（触发 → 自己立即 STATUS.ELIMINATED）。每局最多使用 1 次。

## 2) shared/constants.js 新增（已写入）
```js
MSG.ITEM_BUY = 'item.buy'        // {itemId, amount?}  amount: 购买份数（default 1）
MSG.ITEM_UPGRADE = 'item.upgrade' // {itemId}
MSG.ITEM_USE = 'item.use'        // {itemId, targetId?, amount?, action?, charId?, field?}
MSG.ITEM_LIST = 'item.list'      // C→S 请求当前背包（也可用快照 me.items）

ACTION.BUY_ITEM = 'buyItem'
ACTION.UPGRADE_ITEM = 'upgradeItem'
ACTION.USE_ITEM = 'useItem'

EVENT.ITEM_BOUGHT = 'item_bought'
EVENT.ITEM_UPGRADED = 'item_upgraded'
EVENT.ITEM_USED = 'item_used'
EVENT.ITEM_FAILED = 'item_failed'
EVENT.FROZEN = 'frozen'
EVENT.HACK_RESULT = 'hack_result'

ERR.ITEM = 'E_ITEM'
ERR.FROZEN = 'E_FROZEN'

ITEM_ID = Object.freeze({ FREEZE:'freeze', BUYOFF:'buyoff', PASSWORD:'password', HOURGLASS:'hourglass', HACKBOOK:'hackbook' })
```
协议校验（server/net/Protocol.js SCHEMAS）：ITEM_BUY {itemId: str<=24, amount?: int(1,1000)}；ITEM_UPGRADE {itemId}；ITEM_USE {itemId: str<=24, targetId?: str<=16, amount?: int(-100000,100000), action?: 'add'|'set', charId?: str<=16}。

## 3) 角色状态新增字段（server/core/GameState.js createCharacter 内）
```js
items: { freeze:{lv:0,uses:0}, buyoff:{lv:0,uses:0}, password:{lv:0,uses:0}, hourglass:{lv:0,uses:0}, hackbook:{lv:0,uses:0} },
frozenUntil: 0,          // tick；>state.tick 时该角色完全无法移动/行动（学生在电脑前也停住）
itemRoundCount: {},      // 本局各道具已用次数（hourglass 上限、hackbook 每局 1 次）
itemBuyoffSeen: 0,       // 本局买通生效次数（统计用）
unlock: {},              // { [victimId]: { until: tick } } 强密码解锁计时（攻击者视角，键为受害者 id）
itemStats: { bought:0, upgraded:0, used:0, goldSpent:0, hackSuccess:0, hackFail:0, frozenTimes:0 },
```
金币（学生「积分」与老师「工资」都作为购买货币，直接扣 score）。购买会扣 score，并写入 c.lastResult。

## 4) 冻结语义（ItemSystem + MoveSystem + InteractionSystem 共同遵守）
- `state.tick < c.frozenUntil` ⇒ 该角色本 tick **不能移动**（MoveSystem 需跳过或清零输入）、**不能执行任何 action**（InteractionSystem 需在 handle 前拦下并 ctx.fail(c, kind, ERR.FROZEN, '你被定格了')）、**不能提问进度推进**（updateAsking 跳过）、不能操作电脑（若已在操作，保持不动即可，不强制退出）。
- 快照 charView 新增 `fz: Math.max(0, Math.round((c.frozenUntil - state.tick) * stepMs / 100))`（剩余定格毫秒）。
- 定格对 AI 同样生效（AI 决策也会被 Move/Interaction 拦住）。

## 5) 快照私有字段（server/core/Snapshot.js meView 新增）
```js
items: { freeze:{lv,uses}, buyoff:{lv,uses}, password:{lv,uses}, hourglass:{lv,uses}, hackbook:{lv,uses} },   // 深拷贝
itemRoundCount: { ...c.itemRoundCount },
frozenMs: Math.max(0, Math.round((c.frozenUntil - state.tick) * this.stepMs / 100)),
unlockRemainMs: 0,   // 只有学生的「被密码锁」视角有意义：由 InteractionSystem 在 JC 时写入 c.unlock 后计算
itemPrices: { ... },  // 可选：不下发，客户端从 lobby.rules.items 读
```
同时 `lobbyInfo().rules.items` 需下发完整 items 配置（controller.lobbyInfo 增加 items: this.balance.items）。

## 6) 归属边界
- ItemSystem（新文件 server/systems/ItemSystem.js）+ balance.json items + ConfigLoader 校验 + constants + Protocol + GameState/Snapshot/GameController/InteractionSystem/VisionSystem/MoveSystem 的道具钩子 —— **由服务端负责人独占修改**。
- 客户端道具 UI（商店/背包/目标选择/黑客面板/HUD 定格提示）—— **由客户端负责人独占修改**。
- 两边的唯一接口就是本契约 + 上述消息/快照字段。如需扩字段，先发消息给对方与 Lead。
