// 服务端配置的后台能力（纯函数 + 一层很薄的 IO）：给设置页「服务端配置」做读写。
//
// 设计取舍：
//   1) 这里不 import 本机环境（tailscale / 进程 / 端口），只吃 rootDir，所以能直接单测；
//   2) 读到的敏感值一律打码后再下发——设置页只需要知道「有没有配」，不需要看真 key；
//   3) 「哪些改动要重启才生效」集中在这一张表里，避免前端各自猜（猜错就是改了没反应）。

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { clearOverride, loadConfig, mergeOverride, patchOverride, readOverrideFile, readSection, validateConfig, APP_RULES, BALANCE_RULES } from '../persistence/ConfigLoader.js';
import { ONLINE_DEFAULTS, readOnlineConfig, writeOnlineConfig } from '../persistence/OnlineConfig.js';
import { dataDir } from '../persistence/paths.js';


/**
 * 要落盘/生效的配置段。
 * online 段不在 config/*.json 里，而是 data/config.json 的 online 键（见 persistence/OnlineConfig.js），
 * 但设置页需要能改它（默认服务器源地址/token、TailScale 暴露方式），所以并入同一套读写接口；
 * 写盘走 writeOnlineConfig 而不是 override.json，两者永不互相覆盖。
 */
export const SECTIONS = ['app', 'llm', 'balance', 'online'];

/** online 段写的是 data/config.json，其余三段写 data/override.json。 */
const CONFIG_SECTION = 'online';

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
/** 递归合并：把 src 的键盖到 dst 上（数组整体替换，不做逐项合并）。 */
function deepAssign(dst, src) {
  if (!isPlainObject(src)) return dst;
  for (const [k, v] of Object.entries(src)) {
    if (isPlainObject(v) && isPlainObject(dst[k])) deepAssign(dst[k], v);
    else dst[k] = v;
  }
  return dst;
}

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
export function validateAll({ app = {}, llm = {}, balance = {}, online = {}, only = null } = {}, opts = {}) {
  const errors = [];
  const push = (section, list) => {
    for (const e of list) {
      // ConfigLoader 的报错是「label.path = 值」或整句中文，这里统一成 { path, message }
      const m = /^[a-z]+\.([A-Za-z0-9_.]+) = /.exec(e);
      errors.push({ section, path: m ? m[1] : '', message: e });
    }
  };
  // only：只校验指定段（JSON 树视图单键写入用）。缺省校验全部段。
  const want = (s) => !(only ?? opts.only) || (only ?? opts.only).includes(s);
  // 各段只在「真的传了内容」时校验：只写一两个键的调用方不该被别段的缺键连坐
  const has = (o) => isPlainObject(o) && Object.keys(o).length > 0;
  if (want('app') && has(app)) push('app', validateConfig(app, APP_RULES, 'app'));
  // balance 的交叉校验（flatter 的 min<=max）直接读 obj.flatter，缺段会抛，所以要挡一道
  if (want('balance') && has(balance)) push('balance', validateConfig(balance, BALANCE_RULES, 'balance'));
  if (want('llm') && has(llm)) push('llm', validateLlm(llm));
  // enabled/mode/port 沿用 APP_RULES 里 online.* 那三条：默认配置与运行期装载用的是同一套标准
  // 注意这个 label 必须是 'online'：APP_RULES 里的键名本身就是 online.enabled 这种全路径
  if (want('online') && has(online)) {
    push('online', validateConfig({ online }, APP_RULES.filter(([k]) => k.startsWith('online.')), 'online'));
    for (const e of validateOnline(online)) errors.push({ section: 'online', path: e.path, message: e.message });
  }
  return { ok: errors.length === 0, errors };
}

/**
 * online 段补充校验：APP_RULES 只管 enabled/mode/port 三个键，
 * 其余键（serverUrl/token/tailscale.*）没有现成规则表，而一旦写坏会直接让联机起不来。
 * 返回 [{path,message}]，由 validateAll 统一挂到 section='online' 下。
 */
export function validateOnline(online = {}) {
  const errors = [];
  const add = (path, message) => errors.push({ path, message });
  const o = online ?? {};
  const ts = o.tailscale ?? {};
  for (const [k, v] of Object.entries(o)) {
    // 未知键直接拒：online 段是手改 config.json 的重灾区，拼错一个键名等于静默失效
    if (!['enabled', 'mode', 'serverUrl', 'token', 'port', 'tailscale'].includes(k)) add(k, 'online.' + k + '（未知键）');
  }
  for (const k of Object.keys(ts)) {
    if (!['autoStart', 'expose', 'bg'].includes(k)) add('tailscale.' + k, 'online.tailscale.' + k + '（未知键）');
  }
  // 这里不判 undefined：传进来的永远是「合并后的生效值」，缺键意味着配崩了（会自动回默认），不能放过
  if (typeof ts.autoStart !== 'boolean') add('tailscale.autoStart', 'online.tailscale.autoStart（类型应为 boolean）');
  if (ts.bg !== undefined && typeof ts.bg !== 'boolean') add('tailscale.bg', 'online.tailscale.bg（类型应为 boolean）');
  if (!['serve', 'funnel', 'off'].includes(ts.expose)) add('tailscale.expose', 'online.tailscale.expose（只能是 serve、funnel 或 off）');
  if (o.serverUrl !== undefined && o.serverUrl !== '' && !/^https?:\/\//.test(String(o.serverUrl))) add('serverUrl', 'online.serverUrl（必须为空或以 http:// 、https:// 开头）');
  if (o.token !== undefined) {
    // token 由 makeOnlineToken 生成（256 位 hex），手填也允许，但不许出现空白/引号这类会被 URL 解析吃掉或炸掉的字符
    const t = String(o.token);
    if (t !== '' && !/^[A-Za-z0-9_-]+$/.test(t)) add('token', 'online.token（只能包含字母、数字、下划线与连字符）');
    else if (t.length > 512) add('token', 'online.token（长度不能超过 512）');
  }
  return errors;
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
  // online 段来自 data/config.json（不是 config/*.json + override），单独读一次
  return { app, llm, balance: cfg.balance, online: readOnlineConfig(rootDir) };
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
  if (!SECTIONS.includes(section)) return { ok: false, errors: [{ section, path: '', message: 'section 只能是 ' + SECTIONS.join('、') }] };
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

/**
 * 枚举「样例配置目录」——也就是所有含 config/default.json 的目录。
 * 为什么要枚举而不是固定用 <root>/config：用户把 JSON 搬进面板后需要照着某一份基线看结构，
 * 开发期是仓库里的 config/，装成 SEA 后 resourceDir 下还有一份，两边键名可能不同。
 * 找不到就返回 []，调用方按「没有样例」降级（返回空树而不是 500）。
 */
export function listSampleDirs(rootDir) {
  const out = new Set();
  const addIfSample = (dir) => {
    if (!dir) return;
    try {
      if (existsSync(join(dir, 'config', 'default.json'))) out.add(resolve(dir));
    } catch { /* 权限问题按「不是样例目录」处理 */ }
  };
  // <root>/config 是标准布局；<root> 自己也试一下（SEA 解包目录可能直接把 config 铺平）
  addIfSample(rootDir);
  const r = rootDir ? resolve(rootDir) : '';
  if (r) addIfSample(join(r, 'config'));
  // 再扫一层兄弟目录：开发期 data/ 旁边的 config/、以及 SEA 的 unpacked/config 都能命中
  const parent = r ? dirname(r) : '';
  const scan = (base) => {
    if (!base) return;
    try {
      if (existsSync(join(base, 'config', 'default.json'))) out.add(resolve(base));
      for (const name of readdirSync(base, { withFileTypes: true })) {
        if (!name.isDirectory()) continue;
        const sub = join(base, name.name);
        if (existsSync(join(sub, 'config', 'default.json'))) out.add(resolve(sub));
        else if (existsSync(join(sub, 'default.json')) && name.name === 'config') out.add(resolve(sub, '..'));
      }
    } catch { /* 目录不可读就跳过 */ }
  };
  scan(parent);
  scan(process.cwd());
  // 排序：显式 rootDir 必须排第一——调用方指定的样例目录不能被「父目录扫出来的兄弟目录」抢走，
  // 否则测试/多实例场景下会去写别人的那份 config（历史上就踩过一次污染仓库 config 的坑）。
  const self = r ? resolve(r) : '';
  return Array.from(out).sort((a, b) => {
    if (a === self) return -1;
    if (b === self) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/**
 * 把一个样例目录下的 config/*.json 摊平成便于前端逐行渲染的节点数组。
 * 三个文件各自成段（app/llm/balance），坏文件不抛：跳过并把原因塞进 warnings，
 * 因为「面板能打开、只是少一段」远好过「一个文件语法错就让整页打不开」。
 */
export function buildJsonTree(rootDir, { sampleDir, merged = false } = {}) {
  const dirs = listSampleDirs(rootDir);
  const sample = sampleDir || dirs[0] || (rootDir ? resolve(rootDir) : '');
  const tree = [];
  const warnings = [];
  const files = [['config/default.json', ''], ['config/llm.json', 'llm'], ['config/balance.json', 'balance']];
  // merged：值取「生效值」（默认配置 + override），但**结构仍以样例文件为骨架**。
  // 为什么结构不跟着生效值走：loadConfig 会补出样例里没有的键，那些键样例里不存在、写回去也无从谈起，
  // 多出来只会让「树 == 文件的键集合」这条前端假设失效（面板按 path 分流到三个文件）。
  const effective = merged ? readEffectiveForTree(rootDir, warnings) : null;
  for (const [rel, prefix] of files) {
    const file = join(sample, rel);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      // merged 时样例文件坏了不该让整棵树消失：还有生效值可展示；仍记 warning 让用户知道文件坏了
      warnings.push(rel + '：' + String(err && err.message ? err.message : err));
      if (!effective) continue;
      parsed = effective[prefix === 'llm' ? 'llm' : prefix === 'balance' ? 'balance' : 'app'];
      if (!isPlainObject(parsed)) continue;
    }
    const section = prefix === 'llm' ? effective?.llm : prefix === 'balance' ? effective?.balance : effective?.app;
    // 节点 path 统一带段前缀：default.json → app.*、llm.json → llm.*、balance.json → balance.*。
    // 前端只要看 path 首段就能把一次改动分流到正确的文件（jsonFileKey 用的也是这个约定）。
    const rootPath = prefix || 'app';
    walkJson(isPlainObject(section) ? section : parsed, rootPath, 0, tree);
  }
  return { sampleDir: sample, tree, warnings };
}

/** 试读生效值（app/llm/balance），失败返回 null 而不是抛：树视图宁可变回样例也不该整页 500。 */
function readEffectiveForTree(rootDir, warnings) {
  try {
    const cfg = loadConfig(rootDir, { logger: { info() {}, warn() {}, error() {} } });
    return { app: cfg.app, llm: cfg.llm, balance: cfg.balance };
  } catch (err) {
    warnings.push('生效配置读取失败：' + String(err && err.message ? err.message : err));
    return null;
  }
}

/** 深度优先展开：对象按键序、数组按索引（path.0/path.1），容器节点 value 给空串。 */
function walkJson(value, path, depth, out) {
  if (!path) return out; // 顶层是文件本身，不产出节点（它没有可写的点路径）
  const type = jsonType(value);
  out.push({ path, value: type === 'object' || type === 'array' ? '' : String(value === null ? 'null' : value), type, depth, hasChildren: type === 'object' || type === 'array' });
  if (type === 'object') for (const [k, v] of Object.entries(value)) walkJson(v, path + '.' + k, depth + 1, out);
  else if (type === 'array') value.forEach((v, i) => walkJson(v, path + '.' + i, depth + 1, out));
  return out;
}

function jsonType(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  return t === 'object' ? 'object' : t === 'number' ? 'number' : t === 'boolean' ? 'boolean' : 'string';
}

/**
 * 点路径 → 它属于哪一个 config/*.json（面板按首段分流到三个文件）。
 * 为什么按前缀而不是按「当前样例目录里的文件」判：面板要能在写之前就知道该动哪份文件，
 * 而 llm/balance 两段与文件是一一对应的（见 ConfigLoader.loadConfig），其余一律归 default.json。
 */
export function jsonFileKey(path) {
  const p = String(path ?? '');
  if (p === 'llm' || p.startsWith('llm.')) return 'llm';
  if (p === 'balance' || p.startsWith('balance.')) return 'balance';
  return 'default';
}

/** JSON_FILE_LABELS 里每一项的文件路径（相对 rootDir），面板直接拿去展示与提交。 */
const JSON_FILE_LABELS = [['default', 'config/default.json'], ['llm', 'config/llm.json'], ['balance', 'config/balance.json']];

/** 点路径安全闸：拒绝穿越、空段、控制字符与超长，返回 null 表示通过。 */
export function checkJsonPath(path) {
  const p = String(path ?? '');
  if (!p) return '路径不能为空';
  if (p.length > 200) return '路径长度不能超过 200';
  if (/[\u0000-\u001f\u007f]/.test(p)) return '路径不能包含控制字符';
  for (const seg of p.split('.')) {
    if (!seg) return '路径不能有空段（不要出现连续的两个点）';
    if (seg === '..') return '路径不能包含 ..';
  }
  return null;
}

/** 按点路径写值：父容器不存在就按需建对象；value===null 表示删除该键。 */
function setJsonPath(obj, path, value) {
  const keys = String(path).split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    // 数组下标：'items.prices.2' 这样的路径要落到 prices[2]，不能把数组变成 {"2": ...} 对象 ——
    // 那会把用户的数组写坏（配置里的 items/价格表都是数组）。
    if (Array.isArray(cur) && /^\d+$/.test(k)) {
      const idx = Number(k);
      while (cur.length < idx + 1) cur.push(null);
      if (!isPlainObject(cur[idx]) && !Array.isArray(cur[idx])) cur[idx] = {};
      cur = cur[idx];
      continue;
    }
    // 父亲已经是容器时直接进去：'items.freeze.prices.2' 走到 'prices' 这一层，
    // cur['prices'] 是数组 —— 旧逻辑 isPlainObject([])===false 会把它**整个替换成空对象**，
    // 于是数组被写成 {"2": 45}（用户的数组就这么没了）。数组必须原样保留，交给下一次循环按下标走。
    if (Array.isArray(cur[k])) { cur = cur[k]; continue; }
    if (!isPlainObject(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  const last = keys[keys.length - 1];
  if (Array.isArray(cur) && /^\d+$/.test(last)) {
    // 最后一段是数组下标：'balance.items.freeze.prices.2' 要落到 prices[2]，
    // 而不是把数组变成 {"2": 45}（那样用户的数组就被写坏了）。
    const idx = Number(last);
    if (value === null) { if (idx < cur.length) cur[idx] = null; }
    else {
      while (cur.length < idx + 1) cur.push(null);
      cur[idx] = value;
    }
    return;
  }
  if (value === null) delete cur[last];
  else cur[last] = value;
}

/**
 * 把「点路径→值」写进 dataDir()/config.json（注意不是 override.json）。
 * 为什么单独一份：这个视图是「把整棵 JSON 搬进面板」，用户改的是任意路径（甚至 online 之外的自定义键），
 * 塞进 override.json 会被它的「只覆盖已知键」规则挡掉大半。所以这里按整份配置文件来对待。
 */
export function writeJsonTreeOverride(rootDir, { sampleDir, path, value, validate } = {}) {
  void sampleDir;
  const badPath = checkJsonPath(path);
  if (badPath) return { ok: false, message: badPath };
  // 值安全：掩码串写回去等于把显示值当真值（前端拦不住别的调用方，服务端必须自己拒）
  if (typeof value === 'string' && isMaskedValue(value)) return { ok: false, message: path + '（这是脱敏后的显示值，不能作为配置写入；请填入真实值）' };
  const file = join(dataDir(), 'config.json');
  let raw = {};
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (isPlainObject(parsed)) raw = parsed;
    }
  } catch {
    // 文件坏了：备份一份再重建，绝不静默丢掉用户原来的联机配置
    try { renameSync(file, file + '.broken.' + Date.now()); } catch { /* 备份失败也让写入继续 */ }
    raw = {};
  }
  setJsonPath(raw, path, value === undefined ? null : value);
  // 语义校验放在落盘之前：写进磁盘再被 loadConfig 拒掉，用户只会看到「重启后配置莫名回默认」。
  if (typeof validate === 'function') {
    const bad = validate(raw);
    if (bad) return { ok: false, message: bad };
  }
  mkdirSync(dirname(file), { recursive: true });
  // 原子写：先写临时文件再 rename，避免半截 JSON 让下次启动读崩
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  try {
    writeFileSync(tmp, JSON.stringify(raw, null, 2), 'utf8');
    renameSync(tmp, file);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* 清理失败不影响报错 */ }
    return { ok: false, message: '写入失败：' + String(err && err.message ? err.message : err) };
  }
  return { ok: true, path, file };
}

/**
 * 把「点路径→值」直接写回 config/<key>.json 本体（不是 data/config.json、也不是 override.json）。
 * 为什么要有这条路：用户原话是「直接把几个 json 放上去，前面定值后面变值，能改所有配置」——
 * 他们期望改完能在 config/default.json 里用 git diff 看到。override.json 那套「只覆盖已知键」的
 * 语义反而挡住了大量自定义键，所以这里按整份文件来对待，键级校验交给调用方传进来的 validate。
 *
 * 返回 { ok:true, path, file } / { ok:false, message }，file 是相对 rootDir 的 'config/xxx.json'。
 */

/**
 * 猜原文件的缩进风格，让写回只产生「那个数字变了」的 diff。
 * 用户原话是「直接把几个 json 放上去」，他要的是自己的文件被改一个值，而不是被工具整篇重排 ——
 * 改一个 tickRate 却让 balance.json 冒出 140 行 diff，用户只会认为我们把他的文件搞乱了。
 * 返回值直接可以喂给 JSON.stringify 的第三参：2 / 4 / '\t' / ''（'' = 紧凑单行）。
 */
export function detectIndent(text) {
  const s = String(text ?? '').replace(/\r\n/g, '\n');
  const nl = s.indexOf('\n');
  // 单行紧凑写法（没有换行，或只有结尾那一个换行）→ 保持紧凑
  if (nl === -1 || s.slice(nl + 1).trim() === '') return '';
  const m = /\n([ \t]+)\S/.exec(s);
  if (!m) return 2;
  const unit = m[1];
  if (unit.includes('\t')) return '\t';
  // 取第一个缩进层级（连续 2 或 4 空格）；缩进很深的文件首行缩进本身可能是 4/8，按 2 猜最稳
  return unit.length >= 4 ? 4 : 2;
}

/**
 * 与 JSON.stringify(root, null, indent) 等价，但**空对象/空数组保持 {} []**。
 * 为什么不用原生：原生会把 {} 摊成三行的 "{\n\n}"，一个空对象就贡献 2 行无意义 diff，
 * 而 config/*.json 里空对象很常见（用户删光了某个段就剩 {}）。
 */
export function stringifyJson(root, indent = 2, eol = '\n') {
  const nl = indent ? eol : '';
  // 每个缩进层级该铺多宽：2/4 空格，或制表符
  const ind = (depth) => (indent === '\t' ? '\t'.repeat(depth) : ' '.repeat(indent * depth));
  const walk = (v, depth) => {
    if (v === null) return 'null';
    if (Array.isArray(v)) {
      if (v.length === 0) return '[]';
      const inner = v.map((x) => ind(depth + 1) + walk(x, depth + 1));
      return '[' + nl + inner.join(',' + nl) + nl + ind(depth) + ']';
    }
    if (typeof v === 'object') {
      const keys = Object.keys(v);
      if (keys.length === 0) return '{}';
      const inner = keys.map((k) => ind(depth + 1) + JSON.stringify(k) + (indent ? ': ' : ':') + walk(v[k], depth + 1));
      return '{' + nl + inner.join(',' + nl) + nl + ind(depth) + '}';
    }
    return JSON.stringify(v);
  };
  return walk(root, 0);
}

/**
 * 「源文本定位器」：在**原来的 JSON 文本**里找到某个键/数组元素的值字面量占的区间，
 * 这样写回时可以只替换这几个字符，得到「只有那一行变了」的 diff。
 *
 * 为什么不用正则：JSON 里的字符串可以包含 "{"/"}"、键名可以是 "a.b"、值里可能有转义引号，
 * 正则猜边界一定会错（错一次就是把用户的配置文件写坏）。这里做一个几十行的正经扫描器：
 * 逐字符走，遇到字符串字面量就整段跳过（并处理反斜杠转义），只按 {}[] 的层级与键名导航。
 * 文件本身不合法（顶层不是对象/数组、同一层出现重复键）时返回 null，调用方回退整篇重排。
 *
 * @param {string} text   原文件文本（含 CRLF 也行）
 * @param {Array<string|number>} segs 从文件顶层开始的键路径（数字 = 数组下标）
 * @returns {{start:number,end:number}|null} start = 值的第一个非空白字符，end = 值最后一个字符之后
 *          （end 不含尾随空白/逗号/换行）。定位不到就返回 null。
 */
export function locateValueRange(text, segs) {
  const s = String(text ?? '');
  const n = s.length;
  const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
  const skipWs = (i) => { while (i < n && isWs(s[i])) i += 1; return i; };
  /** 跳过一个字符串字面量（s[i] 必须是 "），返回结尾引号之后的下标；坏字符串 -1 */
  const skipString = (i) => {
    i += 1;
    while (i < n) {
      const c = s[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '"') return i + 1;
      i += 1;
    }
    return -1;
  };
  /** 跳过一个值，返回它结束之后的下标 */
  const skipValue = (i) => {
    i = skipWs(i);
    if (i >= n) return -1;
    const c = s[i];
    if (c === '"') return skipString(i);
    if (c === '{' || c === '[') {
      let depth = 0;
      while (i < n) {
        const ch = s[i];
        if (ch === '"') { i = skipString(i); if (i === -1) return -1; continue; }
        if (ch === '{' || ch === '[') depth += 1;
        else if (ch === '}' || ch === ']') { depth -= 1; if (depth === 0) return i + 1; }
        i += 1;
      }
      return -1;
    }
    while (i < n && !isWs(s[i]) && s[i] !== ',' && s[i] !== '}' && s[i] !== ']') i += 1;
    return i;
  };
  /** 在对象里找 key：只认唯一一次出现（出现两次说明文本不标准 → 放弃，宁可整篇重排也不猜） */
  const findKeyValue = (objStart, key) => {
    let i = objStart + 1;
    const hits = [];
    while (i < n) {
      i = skipWs(i);
      if (i < n && s[i] === ',') { i = skipWs(i + 1); }
      if (i >= n) return null;
      if (s[i] === '}') break;
      if (s[i] !== '"') return null;
      const kEnd = skipString(i);
      if (kEnd === -1) return null;
      let k;
      try { k = JSON.parse(s.slice(i, kEnd)); } catch { return null; }
      let j = skipWs(kEnd);
      if (s[j] !== ':') return null;
      const vStart = skipWs(j + 1);
      const vEnd = skipValue(vStart);
      if (vEnd === -1) return null;
      if (k === key) hits.push({ start: vStart, end: vEnd });
      i = vEnd;
    }
    return hits.length === 1 ? hits[0] : null;
  };
  /** 在数组里找第 index 个元素（下标从 0 起） */
  const findIndexValue = (arrStart, index) => {
    let i = arrStart + 1;
    let at = 0;
    while (i < n) {
      i = skipWs(i);
      if (i < n && s[i] === ',') { i = skipWs(i + 1); }
      if (i >= n) return null;
      if (s[i] === ']') break;
      const vEnd = skipValue(i);
      if (vEnd === -1) return null;
      if (at === index) return { start: i, end: vEnd };
      at += 1;
      i = vEnd;
    }
    return null;
  };

  if (!Array.isArray(segs) || segs.length === 0) return null;
  let range = { start: skipWs(0), end: -1 };
  range.end = skipValue(range.start);
  if (range.end === -1) return null;
  for (let segIndex = 0; segIndex < segs.length; segIndex += 1) {
    const seg = segs[segIndex];
    const at = s[range.start];
    let next = null;
    if (at === '{') next = findKeyValue(range.start, String(seg));
    else if (at === '[') {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0) return null;
      next = findIndexValue(range.start, idx);
    } else return null;
    // 位置 0 = 「文件顶层」：树视图的路径带段前缀（app./llm./balance.），文件本身没有那层包装
    // （llm.json / balance.json 的顶层就是那一段，default.json 的顶层就是 app 段）。
    // 所以顶层找不到同名键时，只有当它就是那个段名前缀才允许吃掉这一段，否则按定位失败回退。
    if (!next && segIndex === 0 && (seg === 'app' || seg === 'llm' || seg === 'balance')) {
      if (at !== '{' && at !== '[') return null;
      continue;
    }
    if (!next) return null;
    range = next;
    // 还有下一段，但这一层的值在原文本里是 null → 路径穿不透，回退整篇重排
    if (segIndex < segs.length - 1 && s.slice(range.start, range.end) === 'null') return null;
  }
  return range;
}

/** 只替换 [start,end) 这一段的文本，其余字节（含 CRLF、缩进、键序、段内紧凑写法）原样保留。 */
export function replaceValueText(text, range, value) {
  if (!range) return null;
  const s = String(text ?? '');
  return s.slice(0, range.start) + JSON.stringify(value === undefined ? null : value) + s.slice(range.end);
}

export function writeJsonFileOverride(rootDir, { sampleDir, path, value, validate, format = 'preserve' } = {}) {
  const badPath = checkJsonPath(path);
  if (badPath) return { ok: false, message: badPath };
  // 掩码串写回去等于把显示值当真值（前端拦不住别的调用方，服务端必须自己拒）
  if (typeof value === 'string' && isMaskedValue(value)) {
    return { ok: false, message: path + '（这是脱敏后的显示值，不能作为配置写入；请填入真实值）' };
  }
  const key = jsonFileKey(path);
  const rel = 'config/' + key + '.json';
  const file = join(sampleDir || rootDir, rel);
  if (!existsSync(file)) return { ok: false, message: '找不到 ' + rel };
  // 树视图的 path 带段前缀（app.* / llm.* / balance.*），而文件本身没有那层包装：
  //   llm.json / balance.json 的顶层**就是**那一段；default.json 的顶层就是 app 段（但 online.* 是嵌在里面的独立段）。
  // 所以写 'app.tickRate' 要落到 default.json 的 tickRate、写 'llm.enabled' 要落到 llm.json 的 enabled，
  // 不能再套一层 app.app.tickRate / llm.llm.enabled。
  const p0 = String(path);
  let segPath = p0;
  if (p0.startsWith('app.')) segPath = p0.slice(4);
  else if (key !== 'default' && (p0 === key || p0.startsWith(key + '.'))) segPath = p0.slice(key.length + 1);
  let root = {};
  let originalText = null;
  try {
    originalText = readFileSync(file, 'utf8');
    const parsed = JSON.parse(originalText);
    if (isPlainObject(parsed)) root = parsed;
  } catch {
    // 文件坏了：备份一份再重建。绝不静默丢掉用户原来的配置（哪怕它已经不合法 JSON）
    try { renameSync(file, file + '.broken.' + Date.now()); } catch { /* 备份失败也让写入继续 */ }
    root = {};
  }
  const before = JSON.stringify(root);
  setJsonPath(root, segPath, value === undefined ? null : value);
  const orig = originalText === null ? '' : originalText;
  const sameValue = JSON.stringify(root) === before;
  // ① 首选「按行替换」保真写：在原文里定位目标值那几个字符，只换这一段，其余字节原样不动。
  //    这样仓库里那种「CRLF + 2 空格 + 段内紧凑单行」的 balance.json 改一个价格只产生 1 行 diff，
  //    而不是整篇重排成 181 行（用户会以为我们把他的文件搞乱了）。
  //    失败就落到 ②：格式不可判断的文本、目标键原本不存在（要新增键）、容器变标量、
  //    源文本里同一个键出现两次、数组越界 —— 这些一律回退整篇重排，绝不靠猜掐字符。
  let text = null;
  if (format === 'preserve' && orig && !sameValue) {
    const locSegs = String(segPath).split('.');
    const range = locateValueRange(orig, locSegs);
    if (range) {
      const candidate = replaceValueText(orig, range, value === undefined ? null : value);
      // 自检：替换后必须仍可解析且与内存里的 root 深度相等，否则说明定位偏了 → 回退（宁多几行 diff，不可写坏）
      let okCandidate = false;
      try {
        const got = JSON.parse(candidate);
        okCandidate = JSON.stringify(got) === JSON.stringify(root);
      } catch { okCandidate = false; }
      if (okCandidate) text = candidate;
    }
  }
  // ② 回退：整篇重排，但沿用原文件的缩进风格（紧凑的保持紧凑、2/4 空格与制表符照旧）与换行符（CRLF/LF）。
  //    format 可显式传 'preserve'（默认）或数字 2/4，后者只在用户主动要求「整理格式」时才用。
  if (text === null) {
    const eol = orig.includes('\r\n') ? '\r\n' : '\n';
    const indent = format === 'preserve' ? detectIndent(orig) : format;
    text = stringifyJson(root, indent, eol) + eol;
    // 值根本没变时直接沿用原字节，不做任何重写
    if (sameValue && orig) text = orig;
  }
  if (typeof validate === 'function') {
    const bad = validate(text);
    if (bad) return { ok: false, message: String(bad) };
  }
  // 原子写：先写同目录临时文件再 rename，避免写到一半进程被杀留下半截 JSON
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, file);
  } catch (err) {
    try { rmSync(tmp, { force: true }); } catch { /* 清理失败不影响报错 */ }
    return { ok: false, message: '写入失败：' + String(err && err.message ? err.message : err) };
  }
  return { ok: true, path, file: rel };
}

/** 原始文件视图：不脱敏（本机只读视图，用户明确要求能直接看到 JSON 原文）。 */
export function readRawJsonFiles(rootDir, { sampleDir, merged = false } = {}) {
  const dirs = listSampleDirs(rootDir);
  const sample = sampleDir || dirs[0] || (rootDir ? resolve(rootDir) : '');
  const files = {};
  if (merged) {
    // merged 的「原文」= 面板看到的那份内容（生效值），序列化回带缩进的 JSON 文本，
    // 否则用户在同一块 UI 里切到「原文」会看到跟树上不一致的旧值。
    const eff = readEffectiveForTree(rootDir, []);
    const pairs = [['config/default.json', eff?.app], ['config/llm.json', eff?.llm], ['config/balance.json', eff?.balance]];
    for (const [rel, value] of pairs) {
      if (!isPlainObject(value)) {
        files[rel] = { text: '', parsed: null, error: 'not found' };
        continue;
      }
      const text = JSON.stringify(value, null, 2) + '\n';
      files[rel] = { text, parsed: structuredClone(value) };
    }
    return { sampleDir: sample, sampleDirs: dirs, files };
  }
  for (const rel of ['config/default.json', 'config/llm.json', 'config/balance.json']) {
    const file = join(sample, rel);
    if (!existsSync(file)) {
      files[rel] = { text: '', parsed: null, error: 'not found' };
      continue;
    }
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      files[rel] = { text: '', parsed: null, error: String(err && err.message ? err.message : err) };
      continue;
    }
    const entry = { text, parsed: null };
    try {
      entry.parsed = JSON.parse(text);
    } catch (err) {
      entry.error = String(err && err.message ? err.message : err);
    }
    files[rel] = entry;
  }
  return { sampleDir: sample, sampleDirs: dirs, files };
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
  const defaultOf = (section) => {
    // online 的「默认值」是 ONLINE_DEFAULTS（它压根不在 config/*.json 里）
    if (section === CONFIG_SECTION) return { ...ONLINE_DEFAULTS, tailscale: { ...ONLINE_DEFAULTS.tailscale } };
    return readDefaults(section === 'app' ? 'default.json' : section === 'llm' ? 'llm.json' : 'balance.json');
  };

  const describe = () => {
    const override = readOverrideFile(rootDir);
    const eff = readEffective(rootDir);
    const sections = {};
    for (const section of SECTIONS) {
      // 敏感值一律打码：设置页只需要「有没有配」，不需要看真 key
      sections[section] = maskSecrets(eff[section] ?? {});
      sections[section].meta = {
        restartKeys: section === 'app' ? RESTART_KEYS.slice() : [],
        // online 段没有 override 文件：凡与默认值不同的键都算「已覆盖」（它就在 config.json 里）
        overridePaths: section === CONFIG_SECTION
          ? flattenPaths(eff.online ?? {}).filter((p) => JSON.stringify(getPath(eff.online, p)) !== JSON.stringify(getPath(ONLINE_DEFAULTS, p)))
          : flattenPaths(override?.[section] ?? {}),
      };
    }
    const defs = {};
    for (const section of SECTIONS) defs[section] = maskSecrets(defaultOf(section));
    // 显式列出「哪些点路径被脱敏了」：前端不必再靠正则猜「abcd***（共 N 位）」这个形状，
    // 换了打码格式也不会静默失效。顺序按 app→llm→balance、段内按对象键序，稳定可比对。
    const secrets = [];
    for (const section of SECTIONS) for (const path of collectSecretPaths(eff[section] ?? {})) secrets.push(section + '.' + path);
    const effective = {};
    for (const section of SECTIONS) effective[section] = sections[section];
    const overrideView = { app: maskSecrets(override?.app ?? {}), llm: maskSecrets(override?.llm ?? {}), balance: override?.balance ?? {} };
    // online 不在 override.json 里：把「与默认值不同的键」当作覆盖项展示，语义与另三段一致
    overrideView.online = maskSecrets(Object.fromEntries((sections.online?.meta.overridePaths ?? []).map((p) => [p, getPath(eff.online, p)])));
    return {
      ok: true,
      secrets,
      sections,
      defaults: defs,
      override: overrideView,
      effective,
      differences: diffOverride(defs, override).concat(
        (sections.online?.meta.overridePaths ?? []).map((path) => ({ section: 'online', path, value: maskSecrets(getPath(eff.online, path)), defaultValue: getPath(ONLINE_DEFAULTS, path) })),
      ),
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
      // online 走 data/config.json（writeOnlineConfig 只动 online 段，保留其它自定义键）；
      // 其余三段走 data/override.json。两条路互不相干，不会互相覆盖。
      next = section === CONFIG_SECTION ? { online: writeOnlineConfig(rootDir, expandPaths(patch).online ?? expandPaths(patch)) } : patchOverride(rootDir, { section, patch });
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
      return { ok: false, errors: [{ section, path: '', message: 'section 只能是 ' + SECTIONS.join('、') }] };
    }
    // 清掉了哪些点路径：语义与 apply 的 applied 对齐，前端才能说「已清除 3 项设置」
    const before = readOverrideFile(rootDir);
    const cleared = [];
    for (const sec of section === null ? SECTIONS : [section]) {
      if (sec === CONFIG_SECTION) {
        // online 的「清除」= 写回 ONLINE_DEFAULTS，clearOverride 碰不到它
        for (const path of describe().sections.online.meta.overridePaths) cleared.push(sec + '.' + path);
        writeOnlineConfig(rootDir, { ...ONLINE_DEFAULTS, tailscale: { ...ONLINE_DEFAULTS.tailscale } });
        continue;
      }
      for (const path of flattenPaths(before?.[sec] ?? {})) cleared.push(sec + '.' + path);
    }
    // 全清时 online 已单独处理完，再 clearOverride(null) 会把三段一起清掉（它本来就不认 online）
    clearOverride(rootDir, section === CONFIG_SECTION ? null : section);
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

  /**
   * JSON 树视图（面板「直接改 JSON」）：样例目录 + 摊平节点 + 坏文件告警。
   * merged:true —— 用户要的是「我现在真实的配置」，所以值取生效值（默认 + override），
   * 结构仍以样例文件为骨架（见 buildJsonTree 里的说明）。files 让面板不用自己猜哪段对应哪个文件。
   */
  const jsonTree = (body) => {
    const dirs = listSampleDirs(rootDir);
    const wanted = body?.sample == null ? '' : String(body.sample);
    const sampleDir = dirs.includes(wanted) ? wanted : dirs[0] ?? '';
    const fileList = JSON_FILE_LABELS.map(([key, file]) => ({ key, file, label: file }));
    if (!sampleDir) {
      // 没有样例目录不是错误：面板显示空树 + 一条提示即可，绝不 500
      return { ok: true, sampleDir: '', sampleDirs: [], tree: [], files: fileList, warnings: ['未找到含 config/default.json 的样例目录'] };
    }
    const built = buildJsonTree(rootDir, { sampleDir, merged: true });
    return { ok: true, sampleDir, sampleDirs: dirs, tree: built.tree, files: fileList, warnings: built.warnings };
  };
  /** 写一个 JSON 路径（直接写回 config/*.json），成功后重新装载并触发热生效回调。 */
  const writeJson = (body) => {
    // 树视图能改到任意键，所以校验必须在这里做：写进磁盘再被 loadConfig 拒掉，用户只会看到「重启后配置没了」。
    // 只校验已知段（app/llm/balance/online）；未知段（例如用户自己加的）没有规则可依，放行。
    const parts = String(body?.path ?? '').split('.');
    const section = parts[0];
    // 校验器拿「即将落成的那份文件文本」来跑：删键会连带恢复默认值，只看单键会误报缺键。
    const baseSample = body?.sample ? String(body.sample) : '';
    const sampleDir = baseSample || listSampleDirs(rootDir)[0] || rootDir;
    const validate = SECTIONS.includes(section)
      ? (rawText) => {
        let diskRoot;
        try {
          diskRoot = JSON.parse(String(rawText));
        } catch {
          // 我们自己序列化出来的文本不可能坏；真坏了当成「无法校验」放行，装载期告警兜底
          return null;
        }
        // 树文件的顶段：default.json 没有 app 包装（它本身就是 app 段），llm.json 是 llm 段，balance.json 是 balance 段
        const diskSection = isPlainObject(diskRoot) ? diskRoot : {};
        // readEffective 会跑一遍 loadConfig —— 而此刻磁盘上**已经是我们刚写好的新文件**了，
        // 万一这个半成品过不了装载校验（例如用户正在填一半的 balance），readEffective 会直接抛。
        // 校验器自己崩掉不能变成「写入失败」：抛出当成无法校验（放行），装载期的告警兜底。
        let merged;
        try {
          merged = { ...readEffective(rootDir) };
        } catch {
          return null;
        }
        // 树文件里该段的落点：default.json 的顶段就是 app，但它的 online.* 是嵌在 app 文件里的独立段；
        // 而 online 的「生效值」在 data/config.json —— 不换成文件里的值，用户刚写进
        // default.json 的 online.* 会被生效值盖掉，校验器就把那条路径当成未知键误拒。
        // 'app.*' 就是 default.json 的顶层（文件本身没有 app 包装），所以落点是 app 段本身，
        // 只有 'app.online.*' 例外：online 是嵌在 default.json 里的独立段，规则表也是 online.* 的。
        const inner = section === 'app'
          ? (parts[1] === 'online' ? 'online' : 'app')
          : parts[1] && SECTIONS.includes(parts[1]) && section === parts[1]
            ? parts[1]
            : section;
        // 落点：该文件顶段就是这一段（default.json / llm.json / balance.json）时用整个文件；
        // 否则这一段是嵌在文件里的一个子对象（default.json 的 online.*）。
        const segRoot = isPlainObject(diskSection[inner]) ? diskSection[inner] : diskSection;
        merged[inner] = deepAssign(structuredClone(defaultOf(inner) ?? {}), isPlainObject(segRoot) ? segRoot : {});
        // 只跑目标段的规则：其它段与本条写入无关，它们缺键报出来等于无解
        let result = { ok: true, errors: [] };
        try {
          result = inner === 'online'
            ? { ok: true, errors: validateOnline(merged.online) }
            : validateAll({ [inner]: merged[inner], only: [inner] });
        } catch {
          // 校验器内部崩了（缺段交叉校验之类）：当成「无法校验」放行
          return null;
        }
        // errors 里可能是 {path,message} 也可能是 validateAll 的 {section,path,message}，两种都要认
        const first = (result.errors ?? [])[0];
        if (!first) return null;
        const where = first.path ? first.path : '';
        return (where ? section + '.' + where + '：' : '') + (first.message ?? '配置不合法');
      }
      : null;
    const out = writeJsonFileOverride(rootDir, {
      sampleDir,
      path: body?.path,
      value: body?.value === undefined ? null : body.value,
      validate,
    });
    if (!out.ok) return out;
    if (typeof onApply === 'function') {
      try {
        onApply({ section: 'json', file: out.file, patch: { [String(body?.path)]: body?.value }, override: {} });
      } catch (err) {
        // 已落盘，只是热生效失败：如实回报而不是谎报失败
        out.warning = '已写入磁盘，但热生效失败（重启后生效）：' + String(err && err.message ? err.message : err);
      }
    }
    return out;
  };
  /** 原文视图：不脱敏。 */
  const jsonRaw = (body) => ({ ok: true, ...readRawJsonFiles(rootDir, { sampleDir: body?.sample }) });

  return { describe, apply, reset, jsonTree, writeJson, jsonRaw };
}
