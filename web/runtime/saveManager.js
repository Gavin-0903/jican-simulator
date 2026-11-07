// 浏览器存档：把服务端 SaveManager 的「每局一份 JSON + 最近 N 局」搬到 localStorage。
// 文件名（localStorage 键）沿用 round-<开局时间>-<种子>，元数据格式与 server/persistence/SaveManager.js 一致。
import { SCHEMA_VERSION } from '../../server/core/GameState.js';
import { PHASE } from '../../shared/constants.js';

const PREFIX = 'jican.web.save:';
const INDEX_KEY = 'jican.web.save.index';

function safeParse(raw) {
  try { return JSON.parse(raw); } catch (err) { return null; }
}

export class BrowserSaveManager {
  constructor({ keepRounds = 10, logger = console } = {}) {
    this.keepRounds = Math.max(1, Number(keepRounds) || 10);
    this.log = logger;
    this.chain = Promise.resolve();
    this.lastSavedAt = 0;
  }

  fileFor(state) {
    return PREFIX + 'round-' + (state.startedAt == null ? 0 : state.startedAt) + '-' + state.seed;
  }

  _readIndex() {
    const listed = safeParse(localStorage.getItem(INDEX_KEY));
    if (Array.isArray(listed)) {
      return listed.filter((x) => x && typeof x.file === 'string' && typeof x.savedAt === 'number')
        .sort((a, b) => b.savedAt - a.savedAt);
    }
    // 索引丢了（用户手动清过 localStorage 的一部分）：扫一遍存档键重建，尽量别让玩家丢档
    const out = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || key.indexOf(PREFIX) !== 0) continue;
      const data = safeParse(localStorage.getItem(key));
      if (data && typeof data.savedAt === 'number') out.push({ file: key, savedAt: data.savedAt });
    }
    out.sort((a, b) => b.savedAt - a.savedAt);
    return out;
  }

  _writeIndex(list) {
    try { localStorage.setItem(INDEX_KEY, JSON.stringify(list)); } catch (err) { /* 索引写不进去不影响存档本身 */ }
  }

  _remove(file) {
    try { localStorage.removeItem(file); } catch (err) { /* 忽略 */ }
  }

  _dropOldest(keep) {
    const list = this._readIndex();
    if (list.length <= keep) return;
    for (const item of list.slice(keep)) this._remove(item.file);
    list.length = keep;
    this._writeIndex(list);
  }

  _writeSave(file, text) {
    try {
      localStorage.setItem(file, text);
      return;
    } catch (err) {
      // 浏览器的 5MB 配额：先砍掉最旧的一半再重试一次，实在放不下就放弃这一帧（游戏继续）
      this._dropOldest(Math.max(1, Math.floor(this.keepRounds / 2)));
      try {
        localStorage.setItem(file, text);
        return;
      } catch (err2) {
        throw new Error('localStorage 空间不足，写不进存档（可在设置里清理旧存档或减少保存局数）');
      }
    }
  }

  /** 串行化写入，避免同一帧并发写同一份存档。 */
  save(state, reason = 'auto') {
    const savedAt = Date.now();
    const data = JSON.stringify({
      savedAt: savedAt,
      reason: reason,
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
      state: state,
    });
    const file = this.fileFor(state);
    this.chain = this.chain
      .then(() => {
        this._writeSave(file, data);
        this.lastSavedAt = Date.now();
        const index = this._readIndex().filter((x) => x.file !== file);
        index.unshift({ file: file, savedAt: savedAt });
        index.sort((a, b) => b.savedAt - a.savedAt);
        if (index.length > this.keepRounds) {
          for (const item of index.slice(this.keepRounds)) this._remove(item.file);
          index.length = this.keepRounds;
        }
        this._writeIndex(index);
      })
      .catch((err) => this.log.error?.('[save] 浏览器存档写入失败：' + (err && err.message ? err.message : err)));
    return this.chain;
  }

  prune() {
    const list = this._readIndex();
    if (list.length <= this.keepRounds) return;
    for (const item of list.slice(this.keepRounds)) this._remove(item.file);
    list.length = this.keepRounds;
    this._writeIndex(list);
  }

  /** 最近一份可继续的存档：同步实现，GameController.lobbyInfo()/resumeSave() 都按同步结果用。 */
  latestResumable(configHash) {
    const list = this._readIndex();
    for (const item of list) {
      const data = safeParse(localStorage.getItem(item.file));
      if (!data) { this._remove(item.file); continue; }
      const meta = data.meta || {};
      if (meta.schemaVersion !== SCHEMA_VERSION || meta.configHash !== configHash) continue;
      if (meta.phase !== PHASE.PLAYING && meta.phase !== PHASE.PAUSED) continue;
      return { file: item.file, savedAt: data.savedAt || item.savedAt, meta: meta };
    }
    return null;
  }

  async load(file) {
    const data = safeParse(localStorage.getItem(file));
    if (!data || !data.state) throw new Error('存档已损坏或已被清理');
    return data.state;
  }

  flush() {
    return this.chain;
  }
}
