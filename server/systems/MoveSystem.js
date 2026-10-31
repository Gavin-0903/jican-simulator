// 移动系统：输入方向 → 期望速度 → 加速度平滑 → 子步碰撞（圆 vs AABB 滑动）→ 位置与朝向。

import { STATUS } from '../../shared/constants.js';
import { len, resolveCircleRects, rotateToward, clamp } from '../../shared/math.js';

export class MoveSystem {
  update(state, ctx) {
    const { balance, map } = ctx;
    const dt = ctx.stepMs / 1000;
    const { accel, radius, subStepPx, turnRate } = balance.move;
    for (const c of state.characters) {
      if (c.status !== STATUS.ACTIVE || c.operatingPcId) {
        c.vel.x = 0;
        c.vel.y = 0;
        continue;
      }
      const speed = c.baseSpeed * c.speedMul * c.attrMul.speed;
      const dir = c.inputDir;
      const tx = dir.x * speed;
      const ty = dir.y * speed;
      // 加速度平滑：速度向目标速度逼近，单步变化量不超过 accel·dt
      const dvx = tx - c.vel.x;
      const dvy = ty - c.vel.y;
      const dv = Math.hypot(dvx, dvy);
      const maxDv = accel * dt;
      if (dv <= maxDv) {
        c.vel.x = tx;
        c.vel.y = ty;
      } else {
        c.vel.x += (dvx / dv) * maxDv;
        c.vel.y += (dvy / dv) * maxDv;
      }
      const stepLen = len(c.vel) * dt;
      if (stepLen > 1e-4) {
        // 子步推进，防止高速穿墙
        const n = Math.max(1, Math.ceil(stepLen / subStepPx));
        const sx = (c.vel.x * dt) / n;
        const sy = (c.vel.y * dt) / n;
        const before = { x: c.pos.x, y: c.pos.y };
        for (let i = 0; i < n; i++) {
          c.pos.x += sx;
          c.pos.y += sy;
          resolveCircleRects(c.pos, radius, map.solids);
        }
        c.pos.x = clamp(c.pos.x, radius, map.width - radius);
        c.pos.y = clamp(c.pos.y, radius, map.height - radius);
        // 撞墙后把速度投影回实际位移，避免「贴墙蓄力」
        const realX = (c.pos.x - before.x) / dt;
        const realY = (c.pos.y - before.y) / dt;
        if (Math.hypot(realX, realY) < Math.hypot(c.vel.x, c.vel.y) - 1) {
          c.vel.x = realX;
          c.vel.y = realY;
        }
      }
      if (Math.hypot(dir.x, dir.y) > 0.1) {
        c.facing = rotateToward(c.facing, Math.atan2(dir.y, dir.x), turnRate * dt * 2);
      } else if (typeof c.faceTarget === 'number') {
        c.facing = rotateToward(c.facing, c.faceTarget, turnRate * dt);
      }
    }
  }
}
