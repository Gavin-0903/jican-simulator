// 增益系统：厕所（停留叠层加速，离场指数衰减）与聊天室（全属性按秒累积，离场保留，设上限）。

import { AUDIENCE, EVENT, STATUS } from '../../shared/constants.js';

const ATTRS = ['speed', 'vision', 'interact', 'scoreGain'];

export class BuffSystem {
  update(state, ctx) {
    const { toilet, chatroom } = ctx.balance;
    const dt = ctx.stepMs;
    const chatFactor = Math.pow(1 + chatroom.perSecondPct / 100, dt / 1000);
    for (const c of state.characters) {
      if (c.status !== STATUS.ACTIVE) continue;
      const zone = ctx.map.roomAt(c.pos)?.buffZone?.kind ?? null;

      if (zone === 'toilet') {
        c.dwell.toiletMs += dt;
        while (c.dwell.toiletMs >= toilet.dwellMs) {
          c.dwell.toiletMs -= toilet.dwellMs; // 余量保留
          if (c.toiletLevel < toilet.maxStack - 1e-6) {
            c.toiletLevel = Math.min(toilet.maxStack, c.toiletLevel + 1);
            c.stats.buffs += 1;
            state.stats.buffs += 1;
            const stacks = Math.ceil(c.toiletLevel - 1e-6);
            ctx.emit({
              type: EVENT.BUFF_GAINED, actorId: c.id, amount: stacks, reason: 'toilet_speed', pos: { ...c.pos },
              text: `速度 +${Math.round(c.toiletLevel * toilet.stepPct)}%（${stacks}/${toilet.maxStack} 层）`,
              audience: [AUDIENCE.ACTOR],
            });
          }
        }
      } else {
        c.dwell.toiletMs = 0;
        if (c.toiletLevel > 0) {
          c.toiletLevel *= Math.pow(0.5, dt / toilet.decayHalfLifeMs);
          if (c.toiletLevel < 0.01) c.toiletLevel = 0;
        }
      }

      if (zone === 'chatroom') {
        for (const k of ATTRS) c.attrMul[k] = Math.min(chatroom.maxMul, c.attrMul[k] * chatFactor);
      }

      c.speedMul = 1 + (toilet.stepPct / 100) * c.toiletLevel;
      this.syncBuffList(c, toilet);
    }
  }

  syncBuffList(c, toilet) {
    const list = [];
    if (c.toiletLevel > 0.005) {
      list.push({ kind: 'toilet_speed', stacks: Math.ceil(c.toiletLevel - 1e-6), value: Math.round(c.toiletLevel * toilet.stepPct * 10) / 10, expireTick: null });
    }
    const chat = c.attrMul.speed - 1;
    if (chat > 1e-6) list.push({ kind: 'chatroom_all', stacks: 1, value: Math.round(chat * 100 * 1000) / 1000, expireTick: null });
    c.buffs = list;
  }
}
