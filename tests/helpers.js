// 测试辅助：装载真实配置与地图，构造确定性的对局与主循环。

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/persistence/ConfigLoader.js';
import { GameMap } from '../server/world/GameMap.js';
import { createGameState, getChar, getPc } from '../server/core/GameState.js';
import { GameLoop } from '../server/core/GameLoop.js';
import { CONTROL, PHASE } from '../shared/constants.js';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const quiet = { info() {}, warn() {}, error() {} };

let cached = null;
export function setup() {
  if (!cached) {
    const config = loadConfig(ROOT, { logger: quiet });
    const map = new GameMap(config.mapData, { radius: config.balance.move.radius, gridSize: config.balance.nav.gridSize, lowCoverDepth: config.balance.vision.lowCoverDepth });
    cached = { config, map };
  }
  return { config: structuredClone(cached.config), map: cached.map };
}

/**
 * 创建一局：默认 AI 全部「冻结」（ai: false），便于精确测试规则；需要 AI 时传 ai: true。
 */
export function makeGame({ seed = 42, player = null, ai = false, balance = null } = {}) {
  const { config, map } = setup();
  const bal = balance ? { ...config.balance, ...balance } : config.balance;
  const state = createGameState({ app: config.app, balance: bal, map, seed });
  state.phase = PHASE.PLAYING;
  // 默认调高目标分：单元测试关注规则本身，不想因为玩家先攒到 2000 分就把对局结算掉
  // （道具/交互类用例常需要先给玩家人为加钱或加分数次）。需要真实结算的用例自己改回来。
  state.targetScore = 0;
  if (player) {
    getChar(state, player).control = CONTROL.HUMAN;
    state.playerCharId = player;
  }
  const loop = new GameLoop({ map, app: config.app, balance: bal, logger: quiet, strict: true, ai: ai ? undefined : { update() {} } });
  loop.setState(state);
  const out = { events: [], dialogs: [], errors: [] };
  const step = (n = 1) => {
    for (let i = 0; i < n; i++) {
      loop.step();
      const o = loop.drain();
      out.events.push(...o.events);
      out.dialogs.push(...o.dialogs);
      out.errors.push(...o.errors);
    }
  };
  const act = (charId, kind, extra = {}) => state.inputQueue.push({ charId, type: 'action', payload: { kind, ...extra } });
  const commit = (charId, selfUsername, amount) => state.inputQueue.push({ charId, type: 'jc.commit', payload: { selfUsername, amount } });
  const move = (charId, dir, face) => state.inputQueue.push({ charId, type: 'move', payload: face === undefined ? { dir } : { dir, face } });
  // 道具消息走的是带点的 type（与 MessageRouter 入队方式一致），payload 就是 Protocol 校验后的对象
  const item = (charId, type, payload = {}) => state.inputQueue.push({ charId, type, payload });
  const ch = (id) => getChar(state, id);
  const pc = (id) => getPc(state, id);
  /** 把角色瞬移到某处（测试用）。 */
  const place = (id, pos, facing) => {
    const c = ch(id);
    c.pos = { x: pos.x, y: pos.y };
    c.vel = { x: 0, y: 0 };
    if (facing !== undefined) c.facing = facing;
  };
  /** 把所有老师移到远处角落，避免干扰。 */
  const parkTeachers = () => {
    for (const c of state.characters) if (c.role === 'teacher') place(c.id, { x: 960, y: 170 }, -Math.PI / 2);
  };
  return { state, loop, map, config, balance: bal, out, step, act, commit, move, item, ch, pc, place, parkTeachers };
}
