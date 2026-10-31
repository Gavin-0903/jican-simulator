// 前端的地图查询：房间归属、可交互目标（仅用于提示与按键映射，结果仍由服务端判定）。

import { dist } from '/shared/math.js';

export function roomAt(map, p) {
  if (!map || !p) return null;
  let corridor = null;
  for (const r of map.rooms) {
    const { x, y, w, h } = r.rect;
    if (p.x <= x || p.x >= x + w || p.y <= y || p.y >= y + h) continue;
    if (!r.walls) corridor ??= r;
    else return r;
  }
  return corridor;
}

/**
 * 找到玩家身边最近的可交互目标。
 * @returns {{kind:'pc'|'teacher'|'inspect', id:string, x:number, y:number, label:string, d:number, own?:boolean}|null}
 */
export function findInteractable(store, pos) {
  const me = store.myChar();
  const mine = store.me;
  const rules = store.lobby?.rules;
  if (!me || !mine || !rules || me.st !== 'active' || me.pc || !pos) return null;
  const R = rules.interactRadius;
  const inspectR = rules.inspectRadius ?? 70;
  const meEntry = store.rosterEntry(me.id);
  let best = null;
  const consider = (cand) => {
    if (!best || cand.d < best.d) best = cand;
  };
  for (const pc of store.map.pcs) {
    const d = dist(pos, pc.seat);
    const state = store.pcs.get(pc.id);
    const own = pc.id === meEntry?.homePcId;
    const owner = store.pcOwner.get(pc.id);
    if (mine.role === 'student') {
      if (pc.owner.role !== 'student' || d > R) continue;
      const busy = state?.op && state.op !== me.id;
      consider({
        kind: 'pc', id: pc.id, x: pc.seat.x, y: pc.seat.y, d, own,
        label: own ? '使用自己的电脑' : `进入 ${owner?.name ?? '他人'} 的电脑${busy ? '（有人在用）' : ''}`,
      });
    } else if (own && d <= R) {
      consider({ kind: 'pc', id: pc.id, x: pc.seat.x, y: pc.seat.y, d, own: true, label: '使用自己的电脑' });
    } else if (state?.op && pc.owner.role === 'student' && d <= inspectR) {
      const op = store.rosterEntry(state.op);
      const suspicious = state.op !== owner?.id;
      consider({ kind: 'inspect', id: pc.id, x: pc.seat.x, y: pc.seat.y, d: d - 1, label: suspicious ? `检查：${op?.name ?? '有人'} 在用 ${owner?.name ?? '别人'} 的电脑！` : `检查 ${owner?.name ?? ''} 的电脑` });
    }
  }
  if (mine.role === 'student') {
    for (const [id, entry] of store.chars) {
      const r = store.rosterEntry(id);
      if (r?.role !== 'teacher' || entry.data.st !== 'active') continue;
      const d = dist(pos, entry.data);
      if (d <= R) consider({ kind: 'teacher', id, x: entry.data.x, y: entry.data.y, d: d - 2, label: `与${r.name}互动` });
    }
  }
  return best;
}
