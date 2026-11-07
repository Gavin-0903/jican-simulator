// 浏览器本地配置仓库：纯网页版没有服务端文件系统，但也得让「设置 → config JSON」能读能写。
// 做法：三个 config/*.json 整份文本分别存一个 localStorage 键；读不到就回落到打包时内联的原版配置。
// 与服务器版语义保持一致：写路径用点路径，数字段落到数组下标；value === null 表示删除该键。
const DATA = globalThis.__JICAN_WEB__ || {};
const SHIPPED = DATA.config || { app: {}, llm: {}, balance: {} };

const FILE_DEFS = [
  { key: 'default', file: 'config/default.json', prefix: 'app', fallback: SHIPPED.app || {} },
  { key: 'llm', file: 'config/llm.json', prefix: 'llm', fallback: SHIPPED.llm || {} },
  { key: 'balance', file: 'config/balance.json', prefix: 'balance', fallback: SHIPPED.balance || {} },
];
const FILE_BY_KEY = {};
for (const def of FILE_DEFS) FILE_BY_KEY[def.key] = def;
const STORE_PREFIX = 'jican.web.config.';
const ONLINE_KEY = 'jican.web.online';
const ONLINE_DEFAULTS = {
  enabled: false,
  mode: 'serve',
  serverUrl: '',
  token: '',
  port: 5173,
  tailscale: { autoStart: true, expose: 'serve', bg: true },
};

function clone(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function getPath(root, path) {
  let cur = root;
  for (const seg of String(path).split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[seg];
  }
  return cur;
}
/** 与 server/net/ConfigAdmin.js 的 setJsonPath 同一套语义：父容器按需建，数组下标不变成对象。 */
function setPath(obj, path, value) {
  const keys = String(path).split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const k = keys[i];
    if (Array.isArray(cur) && /^\d+$/.test(k)) {
      const idx = Number(k);
      while (cur.length < idx + 1) cur.push(null);
      if (!isPlainObject(cur[idx]) && !Array.isArray(cur[idx])) cur[idx] = {};
      cur = cur[idx];
      continue;
    }
    if (Array.isArray(cur[k])) { cur = cur[k]; continue; }
    if (!isPlainObject(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  const last = keys[keys.length - 1];
  if (Array.isArray(cur) && /^\d+$/.test(last)) {
    const idx = Number(last);
    if (value === null) { if (idx < cur.length) cur[idx] = null; }
    else { while (cur.length < idx + 1) cur.push(null); cur[idx] = value; }
    return;
  }
  if (value === null) delete cur[last];
  else cur[last] = value;
}
function mergeDeep(target, source) {
  if (!isPlainObject(source)) return target;
  for (const [k, v] of Object.entries(source)) {
    if (isPlainObject(v) && isPlainObject(target[k])) mergeDeep(target[k], v);
    else target[k] = clone(v);
  }
  return target;
}
function readStoredJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return clone(fallback);
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? parsed : clone(fallback);
  } catch (err) {
    return clone(fallback);
  }
}
function writeStoredJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value, null, 2));
    return true;
  } catch (err) {
    console.error('[web] 浏览器配置写入失败（localStorage 满了？）', err);
    return false;
  }
}
function storeKeyOf(def) { return STORE_PREFIX + def.key; }
function loadFile(def) { return readStoredJson(storeKeyOf(def), def.fallback); }
function saveFile(def, value) { return writeStoredJson(storeKeyOf(def), value); }

function fileKeyOfPath(path) {
  const p = String(path == null ? '' : path);
  if (p === 'llm' || p.indexOf('llm.') === 0) return 'llm';
  if (p === 'balance' || p.indexOf('balance.') === 0) return 'balance';
  return 'default';
}
/** 树里的路径带段前缀（app./llm./balance.），落进文件时要剥掉这一层。 */
function stripPrefix(path, def) {
  const p = String(path == null ? '' : path);
  if (p === def.prefix) return '';
  if (p.indexOf(def.prefix + '.') === 0) return p.slice(def.prefix.length + 1);
  return p;
}
function jsonTypeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  return t === 'object' ? 'object' : t === 'number' ? 'number' : t === 'boolean' ? 'boolean' : 'string';
}
function walkNode(value, path, depth, out) {
  const type = jsonTypeOf(value);
  const container = type === 'object' || type === 'array';
  out.push({
    path: path,
    value: container ? '' : String(value === null ? 'null' : value),
    type: type,
    depth: depth,
    hasChildren: container,
  });
  if (type === 'object') for (const [k, v] of Object.entries(value)) walkNode(v, path + '.' + k, depth + 1, out);
  else if (type === 'array') value.forEach((v, i) => walkNode(v, path + '.' + i, depth + 1, out));
  return out;
}
function flattenLeaves(value, prefix, out) {
  if (value !== null && typeof value === 'object') {
    const keys = Array.isArray(value) ? value.map((x, i) => String(i)) : Object.keys(value);
    if (!keys.length) { if (prefix) out.push(prefix); return out; }
    for (const k of keys) flattenLeaves(value[k], prefix ? prefix + '.' + k : k, out);
    return out;
  }
  if (prefix) out.push(prefix);
  return out;
}
function diffSection(section, current, shipped) {
  const out = [];
  const paths = new Set(flattenLeaves(current, '', []).concat(flattenLeaves(shipped, '', [])));
  for (const path of paths) {
    const a = getPath(current, path);
    const b = getPath(shipped, path);
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      out.push({ section: section, path: path, value: clone(a), defaultValue: clone(b) });
    }
  }
  return out;
}

/** 当前生效配置：三段文件 + 联机段（联机段是独立存储，和 default.json 的 online 默认值合并）。 */
function effective() {
  return {
    app: loadFile(FILE_BY_KEY.default),
    llm: loadFile(FILE_BY_KEY.llm),
    balance: loadFile(FILE_BY_KEY.balance),
    online: onlineConfig(),
  };
}
function onlineConfig() {
  const cur = readStoredJson(ONLINE_KEY, ONLINE_DEFAULTS);
  const merged = clone(ONLINE_DEFAULTS);
  mergeDeep(merged, isPlainObject(cur) ? cur : {});
  return merged;
}
function saveOnline(value) {
  return writeStoredJson(ONLINE_KEY, value);
}

function filesPayload() {
  return FILE_DEFS.map((def) => ({ key: def.key, file: def.file, label: def.file }));
}
function jsonTree() {
  const tree = [];
  for (const def of FILE_DEFS) walkNode(loadFile(def), def.prefix, 0, tree);
  return {
    ok: true,
    sampleDir: '浏览器本地存储',
    sampleDirs: ['浏览器本地存储'],
    tree: tree,
    files: filesPayload(),
    warnings: [],
  };
}
function jsonRaw() {
  const files = {};
  for (const def of FILE_DEFS) {
    const value = loadFile(def);
    const text = JSON.stringify(value, null, 2) + '\n';
    files[def.file] = { text: text, parsed: clone(value) };
  }
  return { ok: true, sampleDir: '浏览器本地存储', sampleDirs: ['浏览器本地存储'], files: files };
}

function writeJson(body) {
  const path = String(body && body.path != null ? body.path : '');
  if (!path) return { ok: false, message: '路径不能为空' };
  const def = FILE_BY_KEY[fileKeyOfPath(path)];
  const segPath = stripPrefix(path, def);
  if (!segPath) return { ok: false, message: '不能把整个配置文件当成一个值来写：' + path };
  const value = body && Object.prototype.hasOwnProperty.call(body, 'value') ? body.value : null;
  const root = loadFile(def);
  setPath(root, segPath, value === undefined ? null : value);
  if (!saveFile(def, root)) return { ok: false, message: '浏览器存储写入失败（可能已满）：请在浏览器设置里清理本站数据' };
  return { ok: true, path: path, file: def.file };
}

function apply(body) {
  const section = String(body && body.section != null ? body.section : '');
  if (!section) return { ok: false, applied: [], needRestart: false, errors: [{ section: section, path: '', message: '需要 section + (path + value) 或 section + patch' }] };
  const patch = isPlainObject(body.patch)
    ? body.patch
    : typeof body.path === 'string'
      ? (function () { const p = {}; p[body.path] = body.value === undefined ? null : body.value; return p; })()
      : null;
  if (!patch || !Object.keys(patch).length) return { ok: false, applied: [], needRestart: false, errors: [{ section: section, path: '', message: 'patch 必须是非空对象' }] };
  const applied = Object.keys(patch);
  if (section === 'online') {
    const cur = onlineConfig();
    mergeDeep(cur, patch);
    if (!saveOnline(cur)) return { ok: false, applied: [], needRestart: false, errors: [{ section: section, path: '', message: '浏览器存储写入失败（可能已满）' }] };
    return { ok: true, applied: applied, needRestart: false, errors: [] };
  }
  const def = section === 'app' ? FILE_BY_KEY.default : section === 'llm' ? FILE_BY_KEY.llm : section === 'balance' ? FILE_BY_KEY.balance : null;
  if (!def) return { ok: false, applied: [], needRestart: false, errors: [{ section: section, path: '', message: 'section 只能是 app、llm、balance、online' }] };
  const root = loadFile(def);
  for (const [k, v] of Object.entries(patch)) {
    if (isPlainObject(v) && isPlainObject(root[k])) mergeDeep(root[k], v);
    else root[k] = clone(v);
  }
  if (!saveFile(def, root)) return { ok: false, applied: [], needRestart: false, errors: [{ section: section, path: '', message: '浏览器存储写入失败（可能已满）' }] };
  return { ok: true, applied: applied, needRestart: false, errors: [] };
}

function reset(section) {
  const wanted = section == null || section === '' ? null : String(section);
  const targets = wanted === 'app' ? ['default'] : wanted === 'llm' ? ['llm'] : wanted === 'balance' ? ['balance'] : wanted === 'online' ? [] : wanted === null ? ['default', 'llm', 'balance', 'online'] : null;
  if (!targets) return { ok: false, message: 'section 只能是 app、llm、balance、online' };
  const before = describe();
  const cleared = [];
  for (const d of before.differences) {
    if (wanted === null || d.section === wanted || (wanted === 'app' && d.section === 'app')) cleared.push(d.section + '.' + d.path);
  }
  for (const key of targets) {
    try {
      if (key === 'online') localStorage.removeItem(ONLINE_KEY);
      else localStorage.removeItem(storeKeyOf(FILE_BY_KEY[key]));
    } catch (err) { /* 忽略 */ }
  }
  return { ok: true, cleared: cleared, clearedCount: cleared.length, needRestart: false, warning: '浏览器版：已恢复打包时的默认配置，刷新页面后生效' };
}

function describe() {
  const cur = effective();
  const defaults = {
    app: clone(SHIPPED.app || {}),
    llm: clone(SHIPPED.llm || {}),
    balance: clone(SHIPPED.balance || {}),
    online: clone(ONLINE_DEFAULTS),
  };
  const differences = []
    .concat(diffSection('app', cur.app, defaults.app))
    .concat(diffSection('llm', cur.llm, defaults.llm))
    .concat(diffSection('balance', cur.balance, defaults.balance))
    .concat(diffSection('online', cur.online, defaults.online));
  const sections = {};
  for (const name of ['app', 'llm', 'balance', 'online']) {
    const paths = differences.filter((d) => d.section === name).map((d) => d.path);
    const sectionValue = name === 'online' ? cur.online : cur[name];
    const view = isPlainObject(sectionValue) ? clone(sectionValue) : {};
    view.meta = { restartKeys: [], overridePaths: paths };
    sections[name] = view;
  }
  const override = { app: {}, llm: {}, balance: {}, online: {} };
  for (const d of differences) {
    if (d.section === 'online' && d.path) {
      // 与服务器版一致：联机段的「覆盖」用「与默认值不同」的键展示
      override.online[d.path] = clone(d.value);
    }
  }
  return {
    ok: true,
    secrets: [],
    sections: sections,
    defaults: defaults,
    override: override,
    effective: cur,
    differences: differences,
  };
}

export function createConfigStore() {
  return {
    effective: effective,
    online: onlineConfig,
    jsonTree: jsonTree,
    jsonRaw: jsonRaw,
    writeJson: writeJson,
    apply: apply,
    reset: reset,
    describe: describe,
    files: filesPayload,
    storageKeys: { filePrefix: STORE_PREFIX, online: ONLINE_KEY },
  };
}
