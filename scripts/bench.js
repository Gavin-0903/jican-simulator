#!/usr/bin/env node
// 性能压测：35 角色满负载跑完整对局，统计单 tick 耗时、快照/增量包体积与内存。

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { loadConfig } from '../server/persistence/ConfigLoader.js';
import { GameMap } from '../server/world/GameMap.js';
import { createGameState, getChar } from '../server/core/GameState.js';
import { GameLoop } from '../server/core/GameLoop.js';
import { Snapshot } from '../server/core/Snapshot.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = loadConfig(root, { logger: { warn: () => {} } });
const map = new GameMap(cfg.mapData, { radius: cfg.balance.move.radius, gridSize: cfg.balance.nav.gridSize, lowCoverDepth: cfg.balance.vision.lowCoverDepth });
const quiet = { info() {}, warn() {}, error() {} };
const rows = [];
for (const [seed, player] of [[1, 's1-01'], [2, 't1'], [3, 's2-05']]) {
  const state = createGameState({ app: cfg.app, balance: cfg.balance, map, seed });
  state.phase = 'PLAYING';
  getChar(state, player).control = 'human';
  state.playerCharId = player;
  const loop = new GameLoop({ map, app: cfg.app, balance: cfg.balance, logger: quiet });
  loop.setState(state);
  const snap = new Snapshot({ map, balance: cfg.balance, stepMs: loop.stepMs });
  const full = JSON.stringify(snap.full(state, player)).length;
  const times = [];
  let maxDelta = 0;
  let sumDelta = 0;
  while (state.phase === 'PLAYING') {
    const t0 = performance.now();
    loop.step();
    times.push(performance.now() - t0);
    const d = snap.delta(state, player, loop.drain().events);
    const len = d ? JSON.stringify(d).length : 0;
    sumDelta += len;
    if (len > maxDelta) maxDelta = len;
  }
  times.sort((a, b) => a - b);
  const q = (p) => times[Math.min(times.length - 1, Math.floor(p * times.length))].toFixed(3);
  rows.push({
    玩家: player,
    tick数: times.length,
    平均ms: (times.reduce((a, b) => a + b, 0) / times.length).toFixed(3),
    P95ms: q(0.95),
    P99ms: q(0.99),
    最大ms: times.at(-1).toFixed(3),
    全量快照B: full,
    平均增量B: Math.round(sumDelta / times.length),
    最大增量B: maxDelta,
    JC: state.stats.jc,
    抓获: state.stats.catches,
  });
}
console.table(rows);
console.log(`进程 RSS：${(process.memoryUsage().rss / 1048576).toFixed(1)} MB（含 3 局累计）`);
