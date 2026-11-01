// 配置装载：config/default.json + balance.json + llm.json + maps/<id>.json，
// 再叠加运行期覆盖 data/override.json（只接受已有键、同类型、通过校验的值）。
// balance.json / override.json 支持热重载（下一 tick 生效）。

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, watchFile, unwatchFile, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './paths.js';

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

const ITEM_IDS = ['freeze', 'buyoff', 'password', 'hourglass', 'hackbook'];
const COST_KEYS = ['price', 'upLevelPrice', 'perUsePrice'];
/** 价格表达式：非负数字，或只含数字 / Lv / 运算符的字符串（由 ItemSystem.evalCost 求值）。 */
const costExpr = (v) => nonneg(v) || (typeof v === 'string' && v.trim() !== '' && /^[0-9A-Za-z+\-*/().\s{}]+$/.test(v) && /Lv|\d/.test(v));

export const APP_RULES = [
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
  // 联机（v0.3）：默认关闭；开启后本机作为服务器源，用 TailScale serve/funnel 对外暴露。
  ['online.enabled', (v) => typeof v === 'boolean'],
  ['online.mode', (v) => v === 'serve' || v === 'funnel'],
  ['online.port', int(1, 65535)],
];

export const BALANCE_RULES = [
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
  // 道具（v0.2）：价格用「正数」而不是整数——{Lv} 模板由 ItemSystem.evalCost 求值，配置里只保证形态合法
  ['items.freeze.price', pos],
  ['items.freeze.maxUses', int(1, 1e6)],
  ['items.freeze.maxLevel', int(1, 99)],
  ['items.freeze.freezeMsPerLevel', pos],
  ['items.buyoff.price', pos],
  ['items.buyoff.maxLevel', int(1, 99)],
  ['items.buyoff.seeThroughPctPerLevel', (v) => typeof v === 'number' && v >= 0 && v <= 100],
  ['items.password.price', pos],
  ['items.password.maxLevel', int(1, 99)],
  ['items.password.lockMsPerLevel', pos],
  ['items.hourglass.price', pos],
  ['items.hourglass.maxLevel', int(1, 99)],
  ['items.hourglass.freezeMsPerLevel', pos],
  ['items.hackbook.price', pos],
  ['items.hackbook.maxLevel', int(1, 99)],
  ['items.hackbook.failPctBase', (v) => typeof v === 'number' && v >= 0 && v <= 100],
  ['items.hackbook.failPctPerLevel', nonneg],
  ['items.hackbook.expelPctBase', (v) => typeof v === 'number' && v >= 0 && v <= 100],
  ['items.hackbook.expelPctPerLevel', nonneg],
  ['items.hackbook.maxPerRound', int(1, 99)],
];

export function validateConfig(obj, rules, label) {
  const errors = [];
  for (const [path, ok] of rules) if (!ok(get(obj, path))) errors.push(`${label}.${path} = ${JSON.stringify(get(obj, path))}`);
  if (label === 'balance') {
    const f = obj.flatter;
    if (f.successRateMin > f.successRateMax) errors.push('balance.flatter.successRateMin 不能大于 successRateMax');
    if (f.min > f.max) errors.push('balance.flatter.min 不能大于 max');
    if (f.failPenaltyMin > f.failPenaltyMax) errors.push('balance.flatter.failPenaltyMin 不能大于 failPenaltyMax');
    // 道具：升级价的 {Lv} 模板必须是可求值的字符串/数字，否则 ItemSystem 会把价格算成 0（等于白送）
    for (const id of ITEM_IDS) {
      const cfg = obj.items?.[id];
      if (!cfg) {
        if (id === 'freeze') errors.push('balance.items 缺少道具配置');
        continue;
      }
      for (const key of COST_KEYS) {
        if (cfg[key] !== undefined && !costExpr(cfg[key])) errors.push(`balance.items.${id}.${key} 不是合法的价格表达式`);
      }
    }
  }
  return errors;
}

/**
 * 读运行期覆盖文件。设置页会直接写它，所以这里必须「坏文件不许变成空对象」：
 * 解析失败时返回 { __error }，调用方（buildBalance/loadConfig）只记 warn 不覆盖，
 * 否则一次写坏的文件会让整份配置悄悄回落到默认值。
 */
export function readOverride(rootDir) {
  const file = join(dataDir(), 'override.json');
  if (!existsSync(file)) return {};
  try {
    const raw = readJson(file);
    return isPlainObject(raw) ? raw : { __error: 'override.json 顶层必须是对象' };
  } catch (err) {
    return { __error: err.message };
  }
}

/** 不可枚举的读法：供设置页读「原始覆盖文件」（含 __error 时不掩盖）。 */
export function readOverrideFile(rootDir) {
  return readOverride(rootDir);
}

/**
 * 原子写 override.json：先写 .tmp 再 rename。
 * 为什么不用 writeFileSync 直写：进程在写到一半时被杀（安装器、任务管理器）会留下半截 JSON，
 * 下次启动就被当成「覆盖全部非法」而回退默认值，用户改的设置全丢。rename 在同一分区上是原子的。
 */
export function writeOverride(rootDir, next) {
  const dir = dataDir();
  const file = join(dir, 'override.json');
  mkdirSync(dir, { recursive: true });
  const body = JSON.stringify(isPlainObject(next) ? next : {}, null, 2) + '\n';
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, body, 'utf8');
    renameSync(tmp, file);
  } catch (err) {
    // 失败要把半成品清掉，否则下次写会不断堆 .tmp
    try { rmSync(tmp, { force: true }); } catch { /* 忽略 */ }
    throw err;
  }
  return { file, bytes: Buffer.byteLength(body) };
}

/** 把点路径设进一个对象（中间层不存在就建）。 */
function setPath(obj, path, value) {
  const keys = String(path).split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (!isPlainObject(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
  return obj;
}

/** 删掉点路径上的键，并自下而上清掉变空的父对象（避免 override 里堆 {"flatter":{}} 这种空壳）。 */
function deletePath(obj, path) {
  const keys = String(path).split('.');
  const stack = [];
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (!isPlainObject(cur[k])) return obj;
    stack.push([cur, k]);
    cur = cur[k];
  }
  delete cur[keys[keys.length - 1]];
  for (let i = stack.length - 1; i >= 0; i--) {
    const [parent, k] = stack[i];
    if (isPlainObject(parent[k]) && Object.keys(parent[k]).length === 0) delete parent[k];
    else break;
  }
  return obj;
}

/**
 * 打补丁：{ section, path, value } 或 { section, patch:{点路径:值} }。
 * value === null 表示「删除该键，恢复继承默认值」（JSON 没有 undefined，null 就是删除语义）。
 * 只做写入，不做校验——校验是 ConfigAdmin.validateAll 的职责，两者分开才能各自单测。
 */
export function patchOverride(rootDir, { section, path, value, patch } = {}) {
  if (!section) throw new Error('patchOverride 需要 section');
  const cur = readOverride(rootDir);
  if (cur.__error) throw new Error(`override.json 已损坏，拒绝在其上打补丁：${cur.__error}`);
  const next = structuredClone(cur);
  if (!isPlainObject(next[section])) next[section] = {};
  const pairs = patch && isPlainObject(patch) ? Object.entries(patch) : [[path, value]];
  for (const [p, v] of pairs) {
    if (!p) throw new Error('patchOverride 需要 path');
    if (v === null) {
      deletePath(next[section], p);
      if (Object.keys(next[section]).length === 0) delete next[section];
    } else {
      setPath(next[section], p, v);
    }
  }
  writeOverride(rootDir, next);
  return next;
}

/** 清空 override：给了 section 只清那一段，否则整个文件重置（写 {} 而不是删文件，方便排错时看现场）。 */
export function clearOverride(rootDir, section = null) {
  if (!section) {
    writeOverride(rootDir, {});
    return {};
  }
  const cur = readOverride(rootDir);
  const next = cur.__error ? {} : structuredClone(cur);
  delete next[section];
  writeOverride(rootDir, next);
  return next;
}

/**
 * 某段「当前生效的完整值」= config 里的默认值深合并 override。
 * 为什么自己读文件而不复用 loadConfig：设置页要能只改 app 段就立刻预览，不该被 balance/map 的错误挡住；
 * 返回值直接是值本体（调用方最常用），被拒绝的覆盖路径挂在不可枚举属性上，不干扰 JSON 序列化。
 */
export function readSection(rootDir, section) {
  const baseFile = section === 'balance' ? join(rootDir, 'config', 'balance.json') : section === 'llm' ? join(rootDir, 'config', 'llm.json') : join(rootDir, 'config', 'default.json');
  const base = readJson(baseFile);
  const ov = readOverride(rootDir);
  if (ov.__error) throw new Error(`override.json 解析失败：${ov.__error}`);
  const [merged, rejected] = mergeOverride(base, ov[section] ?? {}, section);
  Object.defineProperty(merged, '__rejected', { value: rejected, enumerable: false });
  return merged;
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
  const files = [join(rootDir, 'config', 'balance.json'), join(dataDir(), 'override.json')];
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
