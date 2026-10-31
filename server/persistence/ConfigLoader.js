// 配置装载：config/default.json + balance.json + llm.json + maps/<id>.json，
// 再叠加运行期覆盖 data/override.json（只接受已有键、同类型、通过校验的值）。
// balance.json / override.json 支持热重载（下一 tick 生效）。

import { existsSync, readFileSync, watchFile, unwatchFile } from 'node:fs';
import { join } from 'node:path';

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 深合并：只覆盖 base 中已存在且类型一致的键。返回 [合并结果, 被拒绝的路径]。 */
export function mergeOverride(base, override, path = '', rejected = []) {
  if (!isPlainObject(override)) return [base, rejected];
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(override)) {
    const p = path ? `${path}.${k}` : k;
    if (!(k in out)) {
      rejected.push(`${p}（未知键）`);
      continue;
    }
    const cur = out[k];
    if (isPlainObject(cur)) {
      const [merged] = mergeOverride(cur, v, p, rejected);
      out[k] = merged;
    } else if (cur === null || typeof cur === typeof v || (Array.isArray(cur) && Array.isArray(v))) {
      out[k] = v;
    } else {
      rejected.push(`${p}（类型应为 ${typeof cur}）`);
    }
  }
  return [out, rejected];
}

const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const pos = (v) => typeof v === 'number' && v > 0;
const nonneg = (v) => typeof v === 'number' && v >= 0;
const unit = (v) => typeof v === 'number' && v >= 0 && v <= 1;
const int = (lo, hi) => (v) => Number.isInteger(v) && v >= lo && v <= hi;

const APP_RULES = [
  ['server.port', int(1, 65535)],
  ['tickRate', int(1, 60)],
  ['round.durationMs', pos],
  ['round.targetScore', nonneg],
  ['roster.classes', int(1, 20)],
  ['roster.studentsPerClass', int(1, 60)],
  ['roster.subjectTeachers', int(0, 20)],
  ['roster.residentTeachers', int(0, 20)],
  ['net.maxMessageBytes', int(256, 1 << 20)],
  ['net.rateLimitPerSec', pos],
  ['save.everyMs', pos],
];

const BALANCE_RULES = [
  ['move.baseSpeed', pos],
  ['move.accel', pos],
  ['move.radius', pos],
  ['nav.gridSize', int(4, 64)],
  ['interact.radius', pos],
  ['student.failScore', (v) => typeof v === 'number'],
  ['teacher.catchReward', nonneg],
  ['teacher.classLosePenalty', nonneg],
  ['teacher.visionRadius', pos],
  ['teacher.visionHalfAngleDeg', (v) => typeof v === 'number' && v > 0 && v <= 180],
  ['vision.viewRadius', pos],
  ['jc.cooldownMs', nonneg],
  ['ask.dwellMs', pos],
  ['ask.limit', int(0, 1000)],
  ['flatter.successRateMin', unit],
  ['flatter.successRateMax', unit],
  ['flatter.favorInit', unit],
  ['toilet.dwellMs', pos],
  ['toilet.maxStack', int(1, 100)],
  ['toilet.decayHalfLifeMs', pos],
  ['chatroom.perSecondPct', nonneg],
  ['chatroom.maxMul', (v) => typeof v === 'number' && v >= 1],
];

export function validateConfig(obj, rules, label) {
  const errors = [];
  for (const [path, ok] of rules) if (!ok(get(obj, path))) errors.push(`${label}.${path} = ${JSON.stringify(get(obj, path))}`);
  if (label === 'balance') {
    const f = obj.flatter;
    if (f.successRateMin > f.successRateMax) errors.push('balance.flatter.successRateMin 不能大于 successRateMax');
    if (f.min > f.max) errors.push('balance.flatter.min 不能大于 max');
    if (f.failPenaltyMin > f.failPenaltyMax) errors.push('balance.flatter.failPenaltyMin 不能大于 failPenaltyMax');
  }
  return errors;
}

function readOverride(rootDir) {
  const file = join(rootDir, 'data', 'override.json');
  if (!existsSync(file)) return {};
  try {
    return readJson(file);
  } catch (err) {
    return { __error: err.message };
  }
}

function buildBalance(rootDir, logger) {
  const base = readJson(join(rootDir, 'config', 'balance.json'));
  const baseErrors = validateConfig(base, BALANCE_RULES, 'balance');
  if (baseErrors.length) throw new Error(`config/balance.json 数值非法：\n  ${baseErrors.join('\n  ')}`);
  const ov = readOverride(rootDir);
  if (ov.__error) logger.warn?.(`[config] data/override.json 解析失败，已忽略：${ov.__error}`);
  const [merged, rejected] = mergeOverride(base, ov.balance ?? {}, 'balance');
  if (rejected.length) logger.warn?.(`[config] 覆盖项被拒绝：${rejected.join('，')}`);
  const errors = validateConfig(merged, BALANCE_RULES, 'balance');
  if (errors.length) {
    logger.warn?.(`[config] 覆盖后数值非法，回退 balance.json：${errors.join('，')}`);
    return base;
  }
  return merged;
}

export function loadConfig(rootDir, { logger = console } = {}) {
  const ov = readOverride(rootDir);
  const [app, rejectedApp] = mergeOverride(readJson(join(rootDir, 'config', 'default.json')), ov.app ?? {}, 'app');
  const [llm, rejectedLlm] = mergeOverride(readJson(join(rootDir, 'config', 'llm.json')), ov.llm ?? {}, 'llm');
  if (rejectedApp.length || rejectedLlm.length) logger.warn?.(`[config] 覆盖项被拒绝：${[...rejectedApp, ...rejectedLlm].join('，')}`);
  const appErrors = validateConfig(app, APP_RULES, 'app');
  if (appErrors.length) throw new Error(`config/default.json 数值非法：\n  ${appErrors.join('\n  ')}`);
  const balance = buildBalance(rootDir, logger);
  const mapFile = join(rootDir, 'config', 'maps', `${app.mapId}.json`);
  if (!existsSync(mapFile)) throw new Error(`找不到地图文件 ${mapFile}`);
  const mapData = readJson(mapFile);
  return { app, balance, llm, mapData, rootDir };
}

/** 监听 balance.json 与 data/override.json，变化时重新装载并回调（非法则保留旧值）。 */
export function watchBalance(rootDir, onChange, { logger = console, intervalMs = 1000 } = {}) {
  const files = [join(rootDir, 'config', 'balance.json'), join(rootDir, 'data', 'override.json')];
  const handler = (cur, prev) => {
    if (cur.mtimeMs === prev.mtimeMs) return;
    try {
      const balance = buildBalance(rootDir, logger);
      onChange(balance);
      logger.info?.('[config] 平衡参数已热重载');
    } catch (err) {
      logger.warn?.(`[config] 热重载失败，保留当前参数：${err.message}`);
    }
  };
  for (const f of files) watchFile(f, { interval: intervalMs }, handler);
  return () => files.forEach((f) => unwatchFile(f, handler));
}
