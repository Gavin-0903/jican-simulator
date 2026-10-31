// 可复现伪随机：mulberry32。
// 状态保存在一个可序列化的 cell（{ s: uint32 }）里，因此可以随 GameState 一起存档/恢复。
// 每个角色持有独立子流（seed ^ hash(charId)），避免某个角色多抽一次导致全局序列漂移。

export function hashString(str) {
  // FNV-1a 32 位
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export const createCell = (seed) => ({ s: seed >>> 0 });

export const childCell = (baseSeed, key) => createCell((baseSeed ^ hashString(String(key))) >>> 0);

export class Rng {
  /** @param {{s:number}} cell 可序列化的状态单元，会被就地推进 */
  constructor(cell) {
    this.cell = cell;
  }

  static fromSeed(seed) {
    return new Rng(createCell(seed));
  }

  next() {
    let t = (this.cell.s = (this.cell.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** [min, max) 浮点 */
  range(min, max) {
    return min + (max - min) * this.next();
  }

  /** [min, max] 整数 */
  int(min, max) {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(p) {
    return this.next() < p;
  }

  pick(arr) {
    return arr.length ? arr[Math.floor(this.next() * arr.length)] : undefined;
  }
}

/** 生成一个新的随机种子（仅用于开局，不参与模拟）。 */
export function randomSeed() {
  return (Math.floor(Math.random() * 0xffffffff) ^ Date.now()) >>> 0;
}
