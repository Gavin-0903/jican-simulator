// 效用评分与加权选择。
// Utility = w_gain·Gain − w_cost·Cost − w_risk·Risk + w_persona·Persona − w_cooldown·CooldownPenalty

import { clamp } from '../../shared/math.js';

/** 把原始量按参考量纲归一到 [0,1]。 */
export const norm = (value, ref) => clamp(value / ref, 0, 1);

export function scoreUtility(terms, w) {
  return (
    w.gain * (terms.gain ?? 0) -
    w.cost * (terms.cost ?? 0) -
    w.risk * (terms.risk ?? 0) +
    w.persona * (terms.persona ?? 0) -
    w.cooldown * (terms.cooldown ?? 0)
  );
}

/**
 * softmax(U/τ) 采样。τ 越大越随机（性格随机度），τ→0 退化为贪心。
 * @param {{utility:number}[]} candidates
 */
export function softmaxSelect(candidates, tau, rng) {
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];
  const t = Math.max(tau, 1e-3);
  const max = Math.max(...candidates.map((c) => c.utility));
  const weights = candidates.map((c) => Math.exp((c.utility - max) / t));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng.next() * total;
  for (let i = 0; i < candidates.length; i++) {
    r -= weights[i];
    if (r <= 0) return candidates[i];
  }
  return candidates[candidates.length - 1];
}
