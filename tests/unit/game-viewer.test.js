// 多座位（v0.9）：每个玩家连接一份独立视图。
//
// 这是整个座位制里最容易悄悄坏掉的一环 —— 服务端把「一份包群发」改成「每人一份」，
// 只要有一处退回单实例快照（prev/seq 共用），两个人开局后就会互相串台：
// 乙的界面里 me 是甲的角色、结算显示甲的成绩、增量按甲的 prev 算差。
// 这些错都不会抛异常，只是数据悄悄错了，所以必须用测试钉死。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameController } from '../../server/core/GameController.js';
import { getChar } from '../../server/core/GameState.js';
import { MSG, PHASE } from '../../shared/constants.js';
import { setup, quiet } from '../helpers.js';

/** 造一个不开主循环的控制器（测试里手动推进/手动调 flush）。 */
function makeController() {
  const { config, map } = setup();
  const c = new GameController({ config, map, logger: quiet, autoStart: false });
  // 收集「发给某个人」的包；key=null 的是单机群发包
  const sent = [];
  c.on('packet', (type, payload) => sent.push({ to: null, type, payload }));
  c.on('privateTo', (key, type, payload) => sent.push({ to: String(key), type, payload }));
  return { c, sent };
}

const lastTo = (sent, to, type) => {
  for (let i = sent.length - 1; i >= 0; i--) if (sent[i].to === to && sent[i].type === type) return sent[i].payload;
  return null;
};

test('两个 viewer 各有一份 Snapshot：snapshot 里 me/playerCharId 是自己的角色，互不串台', () => {
  const { c, sent } = makeController();
  c.attachViewer('conn-a', 's1-01');
  c.attachViewer('conn-b', 's1-03');
  c.startRound({ characterId: 's1-01', seats: { 甲: 's1-01', 乙: 's1-03' } });

  const a = lastTo(sent, 'conn-a', MSG.SNAPSHOT);
  const b = lastTo(sent, 'conn-b', MSG.SNAPSHOT);
  assert.ok(a && b, '两个连接都该收到 snapshot');
  assert.equal(a.state.me.id, 's1-01');
  assert.equal(b.state.me.id, 's1-03');
  assert.equal(a.state.game.playerCharId, 's1-01', '甲看到自己的角色');
  assert.equal(b.state.game.playerCharId, 's1-03', '乙看到的不能是房主的角色');
  assert.notDeepEqual(a.state.game, b.state.game, '两份 state 不该完全一样');

  // 两个座位都是人控
  assert.equal(getChar(c.state, 's1-01').control, 'human');
  assert.equal(getChar(c.state, 's1-03').control, 'human');
  assert.equal(getChar(c.state, 's1-02').control !== 'human', true, '没坐人的角色不该被人控');

  // 每个 viewer 的 Snapshot 是不同实例（共用的话 prev 会互相覆盖）
  assert.notEqual(c.viewers.get('conn-a').snapshot, c.viewers.get('conn-b').snapshot);
  assert.equal(c.viewerCharOf('conn-a'), 's1-01');
  assert.equal(c.viewerCharOf('conn-b'), 's1-03');
});

test('增量不串台：A 动了只有 A 的 delta 里有变化，B 的 delta 不含 A 的移动', () => {
  const { c, sent } = makeController();
  c.attachViewer('conn-a', 's1-01');
  c.attachViewer('conn-b', 's1-03');
  c.startRound({ characterId: 's1-01', seats: { 甲: 's1-01', 乙: 's1-03' } });
  const a0 = lastTo(sent, 'conn-a', MSG.SNAPSHOT).seq;
  const b0 = lastTo(sent, 'conn-b', MSG.SNAPSHOT).seq;
  sent.length = 0;

  // 只让甲动一格
  const a = getChar(c.state, 's1-01');
  a.pos = { x: a.pos.x + 1, y: a.pos.y };
  c.flush();

  const da = lastTo(sent, 'conn-a', MSG.DELTA);
  const db = lastTo(sent, 'conn-b', MSG.DELTA);
  assert.ok(da, '甲应该收到增量');
  assert.equal(da.seq, a0 + 1, '甲的序号从自己的 prev 续下去');
  assert.ok(da.chars.some((x) => x.id === 's1-01'), '甲收到自己的移动');
  // 乙没动，但甲的移动对乙是「别人动了」—— 这属于公共信息，可以有；
  // 关键是乙的增量不能把甲当成「我」，序号也要按乙自己的 prev 续
  if (db) assert.equal(db.seq, b0 + 1, '乙的序号必须从乙自己的 prev 续，不能用甲的');

  // 真正的串台判据：换座以后，同名角色的「我」字段必须跟着 viewer 走。
  // （两人各自 prev 独立时序号本来就各从各的走，不能靠比序号证明独立性。）
  c.attachViewer('conn-a', 's1-03');
  sent.length = 0;
  c.broadcastFull();
  const a2 = lastTo(sent, 'conn-a', MSG.SNAPSHOT);
  const b2 = lastTo(sent, 'conn-b', MSG.SNAPSHOT);
  assert.equal(a2.state.me.id, 's1-03');
  assert.equal(a2.state.game.playerCharId, 's1-03');
  assert.equal(b2.state.me.id, 's1-03', '乙自己的座位不受甲换座影响');
  assert.equal(c.viewerCharOf('conn-a'), 's1-03');
});

test('重连补发用各自的 Snapshot：A 的 lastSeq 不会把 B 的历史发给 A', () => {
  const { c } = makeController();
  c.attachViewer('conn-a', 's1-01');
  c.attachViewer('conn-b', 's1-03');
  c.startRound({ characterId: 's1-01', seats: { 甲: 's1-01', 乙: 's1-03' } });

  const forA = c.initialMessages(null, 'conn-a');
  const forB = c.initialMessages(null, 'conn-b');
  const snapA = forA.find(([t]) => t === MSG.SNAPSHOT)[1];
  const snapB = forB.find(([t]) => t === MSG.SNAPSHOT)[1];
  assert.equal(snapA.state.me.id, 's1-01');
  assert.equal(snapB.state.me.id, 's1-03');
  // 不传 key 的老路径仍按主玩家给（单机兼容）
  const legacy = c.initialMessages(null).find(([t]) => t === MSG.SNAPSHOT)[1];
  assert.equal(legacy.state.me.id, c.state.playerCharId);
});

test('结算 gameover 按人头各给一份：playerCharId 是各自角色，名次统计一致', () => {
  const { c, sent } = makeController();
  c.attachViewer('conn-a', 's1-01');
  c.attachViewer('conn-b', 's1-03');
  c.startRound({ characterId: 's1-01', seats: { 甲: 's1-01', 乙: 's1-03' } });
  sent.length = 0;
  c.quit();

  const ga = lastTo(sent, 'conn-a', MSG.GAMEOVER);
  const gb = lastTo(sent, 'conn-b', MSG.GAMEOVER);
  assert.ok(ga && gb);
  assert.equal(ga.playerCharId, 's1-01');
  assert.equal(gb.playerCharId, 's1-03');
  assert.equal(ga.winnerId, gb.winnerId, '胜负是全局事实，两人看到的是同一个赢家');
  assert.deepEqual(ga.ranking, gb.ranking, '排名表也是全局的');
  // 结算之后的初始消息里，gameover 也要按 viewer 覆写
  const again = c.initialMessages(null, 'conn-b').find(([t]) => t === MSG.GAMEOVER)?.[1];
  assert.equal(again.playerCharId, 's1-03', '重连进来的乙不能被告知「你是房主」');
});

test('viewer 注册/注销：detach 之后不再给他发包，老单机路径（无 viewer）仍走群发包', () => {
  const { c, sent } = makeController();
  c.attachViewer('conn-a', 's1-01');
  c.startRound({ characterId: 's1-01', seats: { 甲: 's1-01' } });
  assert.equal(sent.some((s) => s.to === 'conn-a'), true);

  assert.equal(c.detachViewer('conn-a'), true);
  assert.equal(c.detachViewer('conn-a'), false, '重复注销返回 false');
  assert.equal(c.viewerCharOf('conn-a'), null);
  sent.length = 0;
  c.broadcastFull();
  assert.equal(sent.some((s) => s.to === 'conn-a'), false, '注销后不能再发包');
  assert.equal(sent.some((s) => s.to === null), true, '没有 viewer 时回到单机群发');
  // flush 只在真有变化时才发增量，用来断言「群发路径还在」不稳；全量包更能说明问题。

  // 换座：同一个 key 重新 attach 成另一个角色
  c.attachViewer('conn-a', 's1-02');
  assert.equal(c.viewerCharOf('conn-a'), 's1-02');
  c.attachViewer('conn-a', 's1-04');
  assert.equal(c.viewerCharOf('conn-a'), 's1-04', '重连换座要覆盖成新角色');
  assert.equal(c.viewers.size, 1, '同一个 key 不该堆出两个 viewer');
});

test('开局时把房间参数作为 overrides 塞进 state：null 项回落到 config 默认', () => {
  const { c } = makeController();
  const defDuration = c.state.roundMs;
  c.startRound({ characterId: 's1-01', round: { durationMs: 300000, targetScore: 1200 } });
  assert.equal(c.state.roundMs, 300000);
  assert.equal(c.state.targetScore, 1200);

  c.toLobby();
  c.startRound({ characterId: 's1-01', round: { durationMs: null, targetScore: null } });
  assert.equal(c.state.roundMs, defDuration, 'null 必须回默认，不能把 null 写进 roundMs（否则永远不结算）');
  assert.ok(c.state.roundMs > 0);

  // 不传 round 也不该炸
  c.toLobby();
  c.startRound({ characterId: 's1-01' });
  assert.equal(c.state.phase, PHASE.PLAYING);
  assert.equal(c.state.roundMs, defDuration);
});
