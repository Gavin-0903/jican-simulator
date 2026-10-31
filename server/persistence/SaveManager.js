// 存档：每局一个文件 data/saves/round-<开局时间>-<种子>.json，原子写入（写临时文件后 rename），
// 只保留最近 keepRounds 局。存档包含完整 GameState（含随机流、AI 黑板），可精确续局。

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PHASE } from '../../shared/constants.js';
import { SCHEMA_VERSION } from '../core/GameState.js';

export class SaveManager {
  constructor({ dir, keepRounds = 10, logger = console }) {
    this.dir = dir;
    this.keepRounds = keepRounds;
    this.log = logger;
    this.chain = Promise.resolve();
    this.lastSavedAt = 0;
  }

  fileFor(state) {
    return join(this.dir, `round-${state.startedAt ?? 0}-${state.seed}.json`);
  }

  /** 串行化写入，避免并发写同一个临时文件。 */
  save(state, reason = 'auto') {
    const data = JSON.stringify({
      savedAt: Date.now(),
      reason,
      meta: {
        schemaVersion: state.schemaVersion,
        configHash: state.configHash,
        phase: state.phase,
        tick: state.tick,
        elapsedMs: state.elapsedMs,
        roundMs: state.roundMs,
        seed: state.seed,
        playerCharId: state.playerCharId,
        startedAt: state.startedAt,
      },
      state,
    });
    const file = this.fileFor(state);
    this.chain = this.chain
      .then(async () => {
        await mkdir(this.dir, { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await writeFile(tmp, data);
        await rename(tmp, file);
        this.lastSavedAt = Date.now();
        await this.prune();
      })
      .catch((err) => this.log.error?.(`[save] 写入存档失败：${err.message}`));
    return this.chain;
  }

  async prune() {
    const files = (await readdir(this.dir)).filter((f) => /^round-.*\.json$/.test(f));
    if (files.length <= this.keepRounds) return;
    const withTime = await Promise.all(files.map(async (f) => ({ f, t: (await stat(join(this.dir, f))).mtimeMs })));
    withTime.sort((a, b) => b.t - a.t);
    for (const { f } of withTime.slice(this.keepRounds)) await rm(join(this.dir, f), { force: true });
  }

  /** 最近一份可以继续的存档（进行中/暂停，且结构与当前配置兼容）。 */
  latestResumable(configHash) {
    if (!existsSync(this.dir)) return null;
    let best = null;
    for (const f of readdirSync(this.dir)) {
      if (!/^round-.*\.json$/.test(f)) continue;
      try {
        const { savedAt, meta } = JSON.parse(readFileSync(join(this.dir, f), 'utf8'));
        if (meta.schemaVersion !== SCHEMA_VERSION || meta.configHash !== configHash) continue;
        if (meta.phase !== PHASE.PLAYING && meta.phase !== PHASE.PAUSED) continue;
        if (!best || savedAt > best.savedAt) best = { file: join(this.dir, f), savedAt, meta };
      } catch {
        // 损坏的存档直接忽略
      }
    }
    return best;
  }

  async load(file) {
    const data = JSON.parse(await readFile(file, 'utf8'));
    return data.state;
  }

  flush() {
    return this.chain;
  }
}
