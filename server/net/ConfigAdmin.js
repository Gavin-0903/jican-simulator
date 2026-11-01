// 服务端配置的后台能力（纯函数 + 一层很薄的 IO）：给设置页「服务端配置」做读写。
//
// 设计取舍：
//   1) 这里不 import 本机环境（tailscale / 进程 / 端口），只吃 rootDir，所以能直接单测；
//   2) 读到的敏感值一律打码后再下发——设置页只需要知道「有没有配」，不需要看真 key；
//   3) 「哪些改动要重启才生效」集中在这一张表里，避免前端各自猜（猜错就是改了没反应）。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clearOverride, loadConfig, mergeOverride, patchOverride, readOverrideFile, readSection, validateConfig, APP_RULES, BALANCE_RULES } from '../persistence/ConfigLoader.js';


/** 要落盘/生效的三个配置段。 */
export const SECTIONS = ['app', 'llm', 'balance'];

/** 这些键读的是「进程启动时的进程状态」，改了必须重启服务，热改只会造成状态与配置不一致。 */
export const RESTART_KEYS = [
  // 监听地址/端口在 listen 时就定了，改配置不会重新 bind
  'server.host',
  'server.port',
  'server.portFallbackRange',
  // tickRate 决定 GameLoop 的步长与所有 ms→tick 换算，中途改会让进行中的对局时间轴错乱
  'tickRate',
  // 地图与名单在建局时装配进 GameState，不重建对局改不了
  'mapId',
  'roster.classes',
  'roster.studentsPerClass',
  'roster.subjectTeachers',
  'roster.residentTeachers',
  // debug 端点是在 createHttpHandler 时按开关挂上去的
  'debug.endpoints',
  // 单帧上限绑在 WebSocketServer 的 maxPayload 上，构造后不能改
  'net.maxMessageBytes',
];

const KEY_HINTS = ['apikey', 'secret', 'password', 'token'];
const SECRET_HEX = /^[0-9a-f]{256}$/i;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * 把 {'flatter.min': 5} 这种点路径表展开成嵌套对象。
 * 为什么需要：mergeOverride 按字面键名比对（它面对的是磁盘上的嵌套 JSON），
 * 设置页传来的却是点路径，不展开就会被整条判成「未知键」。
 */
export function expandPaths(patch) {
  const out = {};
  for (const [p, v] of Object.entries(patch || {})) {
    const keys = String(p).split('.');
    let cur = out;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!isPlainObject(cur[keys[i]])) cur[keys[i]] = {};
      cur = cur[keys[i]];
    }
    cur[keys[keys.length - 1]] = v;
  }
  return out;
}

/** 取点路径上的值（不创建中间对象）。 */
export function getPath(obj, path) {
  if (!path) return obj;
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

const isScalar = (v) => v === null || ['string', 'number', 'boolean', 'bigint'].includes(typeof v);

/** 命中 KEY_HINTS（不区分大小写）且值不是空。 */
function nameLooksSecret(key, value) {
  if (value == null || value === '') return false;
  const lowered = String(key).toLowerCase();
  return KEY_HINTS.some((h) => lowered.includes(h));
}

/**
 * 单个键值对算不算「敏感」——打码与「列出敏感路径」必须用同一份判定，
 * 否则前端拿到的 secrets 清单和实际被打码的字段会漂移（靠正则猜形状就是隐式契约）。
 * 两种都查：键名像密钥（apiKey/secret/token…，有些配置项起名很随意），
 * 或者值本身就是 256 位 hex（id 密钥/联机 token 的形态极其固定，靠名字会漏）。
 * 空值不算：没配 token 时不该把它列成「已脱敏字段」。
 */
function isSecretEntry(key, value) {
  // 只有字符串才可能是「一个凭证」。数字/布尔打码后会变成写不回去的字符串，
  // 对象/数组打码会破坏结构（balance.items.password 本身就是个对象，只是键名叫 password）。
  // 空串放过：没配 token 的字段不该被列成「已脱敏」，也不该给前端加只读锁。
  if (typeof value !== 'string' || value === '') return false;
  if (SECRET_HEX.test(value)) return true;
  return nameLooksSecret(key, value);
}

/**
 * 深度脱敏：字段名像密钥（apiKey/secret/token…）或值是 256 位 hex（id 密钥/联机 token）的一律打码。
 *
 * 只有标量才替换成掩码串；数组/对象一律继续递归——这一点是硬约束：
 * 早先对任意非字符串值也走 maskSecret(String(v))，于是 balance.items.password（道具配置对象）
 * 被下发成 "[obj********（共 15 位）"，既不是它原来的结构、也没法再编辑价格。
 * 结构必须原样保留，前端才知道「这是个对象」而不是「这是个字符串密钥」。
 */
export function maskSecrets(obj, depth = 0) {
  if (typeof obj === 'string') return SECRET_HEX.test(obj) ? maskSecret(obj) : obj;
  if (depth > 8 || obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map((v) => maskSecrets(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isScalar(v) && isSecretEntry(k, v)) out[k] = maskSecret(String(v));
    else out[k] = maskSecrets(v, depth + 1);
  }
  return out;
}

/**
 * 收集所有会被打码的点路径（如 llm.openaiCompat.apiKey、online.token）。
 * 给前端一份显式清单：它们据此决定哪些输入框只读/展示掩码，不用再猜「abcd***（共 N 位）」这个形状。
 * 遍历顺序与 maskSecrets 一致，判定共用 isSecretEntry，保证两处永不漂移。
 */
export function collectSecretPaths(obj, prefix = '', acc = []) {
  if (obj === null || typeof obj !== 'object') return acc;
  if (Array.isArray(obj)) {
    for (const v of obj) collectSecretPaths(v, prefix, acc);
    return acc;
  }
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? prefix + '.' + k : k;
    if (isSecretEntry(k, v)) acc.push(p);
    // 已经被打码的整块不再往下钻（否则 {token:{a:1}} 会把里面的 a 也当成独立路径）
    else if (v !== null && typeof v === 'object') collectSecretPaths(v, p, acc);
  }
  return acc;
}

/**
 * isMaskedValue 与 maskSecret 是**一对**：maskSecret 生成什么形态，isMaskedValue 就认什么形态。
 * 改任何一个的格式都必须同步改另一个，否则掩码串又会被当成真实值写回磁盘。
 *
 * 只认「前 4 位 + 1~8 个 * + （共 N 位）」这种带长度后缀的形态：
 * maskSecret 对长度<=4 的值返回纯 `****`，但纯 * 串本身可能是合法的真实值——
 * llm.maxTokens 的真实值是 `**`、balance.items.*.upLevelPrice 是 `{Lv} * 50`。
 * 所以宁可漏判纯 * （风险低：真写回去也只是个错值，前端展示层还会再打一次码），
 * 也不能误伤这些正常配置，让用户连改都改不了。
 */
export function isMaskedValue(s) {
  return typeof s === 'string' && /^[\s\S]{4}\*{1,8}（共 \d+ 位）$/.test(s);
}

/** 只保留头 4 位与长度：足够让用户确认「配的是哪一把」，又不构成泄漏。 */
function maskSecret(s) {
  const str = String(s);
  if (!str) return '';
  if (str.length <= 4) return '*'.repeat(str.length);
  return str.slice(0, 4) + '*'.repeat(Math.min(8, str.length - 4)) + '（共 ' + str.length + ' 位）';
}

/** 把 override 段摊平成一串点路径（只列真正被改过的键，供设置页标「已覆盖」）。 */
export function flattenPaths(obj, prefix = '', acc = []) {
  if (!isPlainObject(obj)) {
    if (prefix) acc.push(prefix);
    return acc;
  }
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? prefix + '.' + k : k;
    if (isPlainObject(v)) flattenPaths(v, p, acc);
    else acc.push(p);
  }
  return acc;
}

/** 列出 override 里改过哪些项：每条带上「覆盖后的值」与「默认值」，方便前端直接展示差异。 */
export function diffOverride(defaults, override) {
  const out = [];
  for (const section of SECTIONS) {
    for (const path of flattenPaths(override?.[section] ?? {})) {
      out.push({ section, path, value: getPath(override[section], path), defaultValue: getPath(defaults?.[section], path) });
    }
  }
  return out;
}

/** 一个点路径需要重启才生效吗？app 段之外（llm/balance）都是热生效。 */
export function classifyRestart(path) {
  const p = String(path ?? '').replace(/^app\./, '');
  for (const key of RESTART_KEYS) if (p === key || p.startsWith(key + '.')) return true;
  return false;
}

/**
 * 整包校验：app/llm/balance 各自跑规则表，balance 额外跑交叉校验（flatter 的 min<=max、道具价格表达式）。
 * 直接复用 ConfigLoader.validateConfig，避免「设置页认了、装载期又回退」的两套标准。
 */
export function validateAll({ app = {}, llm = {}, balance = {} } = {}) {
  const errors = [];
  const push = (section, list) => {
    for (const e of list) {
      // ConfigLoader 的报错是「label.path = 值」或整句中文，这里统一成 { path, message }
      const m = /^[a-z]+\.([A-Za-z0-9_.]+) = /.exec(e);
      errors.push({ section, path: m ? m[1] : '', message: e });
    }
  };
  push('app', validateConfig(app, APP_RULES, 'app'));
  push('balance', validateConfig(balance, BALANCE_RULES, 'balance'));
  push('llm', validateLlm(llm));
  return { ok: errors.length === 0, errors };
}

/** llm 段没有现成规则表（它是本地模型连接参数），这里补最小的一组「不能把网关配崩」的检查。 */
function validateLlm(llm) {
  const errors = [];
  const num = (path, pred, hint) => {
    const v = getPath(llm, path);
    if (!pred(v)) errors.push(`llm.${path} = ${JSON.stringify(v)}${hint ? '（' + hint + '）' : ''}`);
  };
  if (typeof llm?.enabled !== 'boolean') errors.push(`llm.enabled = ${JSON.stringify(llm?.enabled)}`);
  num('timeoutMs', (v) => Number.isInteger(v) && v >= 1, '毫秒，正整数');
  num('healthTimeoutMs', (v) => Number.isInteger(v) && v >= 1, '毫秒，正整数');
  num('maxConcurrency', (v) => Number.isInteger(v) && v >= 1 && v <= 64);
  num('queueMax', (v) => Number.isInteger(v) && v >= 0 && v <= 1000);
  num('temperature', (v) => typeof v === 'number' && v >= 0 && v <= 2);
  num('maxTokens', (v) => Number.isInteger(v) && v >= 1 && v <= 8192);
  return errors;
}

/** 读三段「当前生效值」：默认配置叠一层 override（与运行期装载同一套合并逻辑）。 */
export function readEffective(rootDir) {
  const cfg = loadConfig(rootDir, { logger: { info() {}, warn() {}, error() {} } });
  const app = readSection(rootDir, 'app');
  const llm = readSection(rootDir, 'llm');
  return { app, llm, balance: cfg.balance };
}

/** 在待写入的值里找出掩码串，返回 [{path, value}]（支持 patch 里嵌套对象，如 {llm:{apiKey:'xxx'}}）。 */
function findMaskedValues(value, prefix = '', acc = []) {
  if (isMaskedValue(value)) acc.push({ path: prefix, value });
  else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) findMaskedValues(v, prefix ? prefix + '.' + k : k, acc);
  }
  // 数组里的字符串也算（虽然当前没有数组型配置项，逻辑上仍应一致）
  else if (Array.isArray(value)) value.forEach((v, i) => findMaskedValues(v, prefix + '.' + i, acc));
  return acc;
}

/** 校验一个候选 patch：先合到「当前生效值」上，再整包校验（否则单看一个键永远合法）。 */
export function validatePatch({ section, patch, effective }) {
  if (!SECTIONS.includes(section)) return { ok: false, errors: [{ section, path: '', message: 'section 只能是 app、llm 或 balance' }] };
  if (!isPlainObject(patch) || !Object.keys(patch).length) {
    return { ok: false, errors: [{ section, path: '', message: 'patch 必须是非空对象' }] };
  }
  const base = effective?.[section] ?? {};
  // value=null 在 set 语义里是「删除该键」，而 mergeOverride 会把它当成类型不符。
  // 所以先剔除删除项，剩下的才是要合并的值；最后再按「删除后的结果」整包校验。
  const flat = {};
  const deletes = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) deletes.push(k);
    else flat[k] = v;
  }
  // 掩码串闸：前端把 GET 拿到的显示值原样提交回来的话，会把 "abcd****（共 9 位）" 当真 key 存进 override.json。
  // 前端拦不住别的调用方，服务端必须自己拒绝；只认带「（共 N 位）」后缀的形态，纯 * 不拦（见 isMaskedValue 注释）。
  for (const [k, v] of Object.entries(patch)) {
    for (const bad of findMaskedValues(v, k)) {
      return {
        ok: false,
        errors: [{ section, path: bad.path, message: section + '.' + bad.path + '（这是脱敏后的显示值，不能作为配置写入；请填入真实值）' }],
      };
    }
  }
  let merged = structuredClone(base);
  if (Object.keys(flat).length) {
    // mergeOverride 的 path 参数是「报错用的前缀」，不能传 section（否则报出 balance.flatter.min 这种双段路径）
    const [out, rejected] = mergeOverride(base, expandPaths(flat), '');
    if (rejected.length) return { ok: false, errors: rejected.map((r) => ({ section, path: r.split('（')[0], message: r })) };
    merged = out;
  }
  // 删除项要先确认键存在（否则是拼错路径），再从校验对象里摘掉——反正「生效值」里删掉等于回到默认
  for (const p of deletes) {
    if (getPath(merged, p) === undefined) return { ok: false, errors: [{ section, path: p, message: p + '（未知键）' }] };
  }
  const result = validateAll({ ...(effective ?? {}), [section]: merged });
  return result.ok ? { ok: true, errors: [], merged } : result;
}

export { validateConfig, BALANCE_RULES, APP_RULES };
export { readSection, mergeOverride };

/**
 * 组装「活」的配置管理员：LobbyHttp 只需要 describe/apply/reset 三个方法。
 * 依赖注入 onApply(next) 而不是在这里直接碰 controller：这样 ConfigAdmin 仍然可单测，
 * 而「写盘成功后要让新 balance 立刻生效」这条副作用留在 index.js 组装处，一眼能看全。
 */
export function createConfigAdmin({ rootDir, defaults, onApply = null }) {
  // 默认值取仓库里的 config/*.json（不含 override）：设置页要拿它做「恢复默认」的对照与展示。
  // 允许注入 defaults 覆盖（单测里不想读仓库文件时用），未注入就现读。
  const readDefaults = (file) => {
    const injected = defaults?.[file];
    if (injected && typeof injected === 'object') return structuredClone(injected);
    return JSON.parse(readFileSync(join(rootDir, 'config', file), 'utf8'));
  };
  const defaultOf = (section) => readDefaults(section === 'app' ? 'default.json' : section === 'llm' ? 'llm.json' : 'balance.json');

  const describe = () => {
    const override = readOverrideFile(rootDir);
    const eff = readEffective(rootDir);
    const sections = {};
    for (const section of SECTIONS) {
      // 敏感值一律打码：设置页只需要「有没有配」，不需要看真 key
      sections[section] = maskSecrets(eff[section] ?? {});
      sections[section].meta = {
        restartKeys: section === 'app' ? RESTART_KEYS.slice() : [],
        overridePaths: flattenPaths(override?.[section] ?? {}),
      };
    }
    const defs = {};
    for (const section of SECTIONS) defs[section] = maskSecrets(defaultOf(section));
    // 显式列出「哪些点路径被脱敏了」：前端不必再靠正则猜「abcd***（共 N 位）」这个形状，
    // 换了打码格式也不会静默失效。顺序按 app→llm→balance、段内按对象键序，稳定可比对。
    const secrets = [];
    for (const section of SECTIONS) for (const path of collectSecretPaths(eff[section] ?? {})) secrets.push(section + '.' + path);
    return {
      ok: true,
      secrets,
      sections,
      defaults: defs,
      override: { app: maskSecrets(override?.app ?? {}), llm: maskSecrets(override?.llm ?? {}), balance: override?.balance ?? {} },
      effective: { app: sections.app, llm: sections.llm, balance: sections.balance },
      differences: diffOverride(defs, override),
    };
  };

  const apply = (body) => {
    const section = String(body?.section ?? '');
    // 两种写法都收：「{ path, value }」适合单个开关，「{ patch }」适合整张表单一次提交
    const patch = isPlainObject(body?.patch) ? body.patch : typeof body?.path === 'string' ? { [body.path]: body.value === undefined ? null : body.value } : null;
    if (!patch) return { ok: false, applied: [], needRestart: false, errors: [{ section, path: '', message: '需要 section + (path + value) 或 section + patch' }] };
    const effective = readEffective(rootDir);
    const check = validatePatch({ section, patch, effective });
    if (!check.ok) return { ok: false, applied: [], needRestart: false, errors: check.errors };
    let next;
    try {
      next = patchOverride(rootDir, { section, patch });
    } catch (err) {
      return { ok: false, applied: [], needRestart: false, errors: [{ section, path: '', message: String(err && err.message ? err.message : err) }] };
    }
    const applied = Object.keys(patch);
    // needRestart 只看真正落进 app 段、且命中重启表的键：balance/llm 都热生效，不该吓唬用户重启
    const needRestart = section === 'app' && applied.some((k) => classifyRestart(k));
    let warning;
    if (typeof onApply === 'function') {
      try {
        warning = onApply({ section, patch, override: next });
      } catch (err) {
        // 写盘已成功，只是热生效失败：如实告诉用户「重启后生效」，别谎报成功也别谎报失败
        warning = '已写入磁盘，但热生效失败（重启后生效）：' + String(err && err.message ? err.message : err);
      }
    }
    return { ok: true, applied, needRestart, errors: [], warning };
  };

  const reset = (body) => {
    const section = body?.section == null ? null : String(body.section);
    if (section !== null && !SECTIONS.includes(section)) {
      return { ok: false, errors: [{ section, path: '', message: 'section 只能是 app、llm 或 balance' }] };
    }
    // 清掉了哪些点路径：语义与 apply 的 applied 对齐，前端才能说「已清除 3 项设置」
    const before = readOverrideFile(rootDir);
    const cleared = [];
    for (const sec of section === null ? SECTIONS : [section]) {
      for (const path of flattenPaths(before?.[sec] ?? {})) cleared.push(sec + '.' + path);
    }
    clearOverride(rootDir, section);
    let warning;
    if (typeof onApply === 'function') {
      try {
        warning = onApply({ section, patch: null, override: {} });
      } catch (err) {
        warning = '已重置磁盘配置，但热生效失败（重启后生效）：' + String(err && err.message ? err.message : err);
      }
    }
    return { ok: true, cleared, clearedCount: cleared.length, needRestart: section === null || section === 'app', warning };
  };

  return { describe, apply, reset };
}
