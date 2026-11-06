// 配置写回自测（v0.7）：设置页「直接改 JSON」写的是 config/{default,llm,balance}.json 本体。
//
// 为什么单独一份：用户原话是「改完能在 config/default.json 里用 git diff 看见」，
// 所以这份测试的每一条都落在「仓库里的那三个文件被改成了什么样」——
// 是「只改目标键、其余键与顺序原样保留」，而不是「磁盘上某个镜像文件对了」。
//
// 所有写盘都在 mkdtemp 临时目录里做：config/ 是用户资产，测试绝不碰仓库里的那一份。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfigAdmin, detectIndent, jsonFileKey, locateValueRange, replaceValueText, writeJsonFileOverride } from '../../server/net/ConfigAdmin.js';
import { ROOT, quiet } from '../helpers.js';

/** 建一个隔离沙箱：把仓库 config/ 拷进临时目录，dataDir 也指到临时目录。 */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'jican-cfgwrite-'));
  cpSync(join(ROOT, 'config'), join(dir, 'config'), { recursive: true });
  process.env.JICAN_DATA_DIR = join(dir, 'data');
  return dir;
}

const readConfigFile = (dir, name) => readFileSync(join(dir, 'config', name), 'utf8');

test('jsonFileKey：llm.* 落到 llm、balance.* 落到 balance，其余都落 default', () => {
  assert.equal(jsonFileKey('llm'), 'llm');
  assert.equal(jsonFileKey('llm.enabled'), 'llm');
  assert.equal(jsonFileKey('llm.ollama.model'), 'llm');
  assert.equal(jsonFileKey('balance'), 'balance');
  assert.equal(jsonFileKey('balance.items.freeze.price'), 'balance');
  assert.equal(jsonFileKey('tickRate'), 'default');
  assert.equal(jsonFileKey('online.tailscale.bg'), 'default');
  assert.equal(jsonFileKey('llmish.enabled'), 'default', '前缀必须按段匹配，不能是 startsWith(llm)');
  rmSync(join(tmpdir(), 'x'), { recursive: true, force: true });
});

test('写回 config/default.json：只改目标键，其余键与键序原样保留（不凭空产生、不丢键）', () => {
  const dir = sandbox();
  const admin = createConfigAdmin({ rootDir: dir });
  const before = JSON.parse(readConfigFile(dir, 'default.json'));
  const beforeKeys = Object.keys(before);
  const out = admin.writeJson({ path: 'tickRate', value: 12 });
  assert.equal(out.ok, true);
  assert.equal(out.file, 'config/default.json');
  const after = JSON.parse(readConfigFile(dir, 'default.json'));
  // 只有目标键变化：把目标键改回原值后，两份对象必须深度相等
  assert.notEqual(after.tickRate, before.tickRate);
  assert.equal(after.tickRate, 12);
  after.tickRate = before.tickRate;
  assert.deepEqual(after, before, '除目标键外必须完全一致');
  assert.deepEqual(Object.keys(JSON.parse(readConfigFile(dir, 'default.json'))), beforeKeys, '键序也要原样保留');
  rmSync(dir, { recursive: true, force: true });
});

test('写回 config/llm.json 与 config/balance.json：各归各的文件，default.json 不动', () => {
  const dir = sandbox();
  const admin = createConfigAdmin({ rootDir: dir });
  const defaultSnapshot = readConfigFile(dir, 'default.json');
  const llmBefore = JSON.parse(readConfigFile(dir, 'llm.json'));
  const balBefore = JSON.parse(readConfigFile(dir, 'balance.json'));

  const llmOut = admin.writeJson({ path: 'llm.enabled', value: false });
  assert.equal(llmOut.ok, true);
  assert.equal(llmOut.file, 'config/llm.json');
  const llmAfter = JSON.parse(readConfigFile(dir, 'llm.json'));
  assert.equal(llmAfter.enabled, false);
  llmAfter.enabled = llmBefore.enabled;
  assert.deepEqual(llmAfter, llmBefore);

  const balOut = admin.writeJson({ path: 'balance.items.freeze.price', value: 200 });
  assert.equal(balOut.ok, true);
  assert.equal(balOut.file, 'config/balance.json');
  const balAfter = JSON.parse(readConfigFile(dir, 'balance.json'));
  assert.equal(balAfter.items.freeze.price, 200);
  balAfter.items.freeze.price = balBefore.items.freeze.price;
  assert.deepEqual(balAfter, balBefore);

  assert.equal(readConfigFile(dir, 'default.json'), defaultSnapshot, 'default.json 一个字节都不该动');
  rmSync(dir, { recursive: true, force: true });
});

test('校验拦在落盘之前：非法值不写文件，且报错里带出完整点路径', () => {
  const dir = sandbox();
  const admin = createConfigAdmin({ rootDir: dir });
  const snapshot = readConfigFile(dir, 'balance.json');
  const bad = admin.writeJson({ path: 'balance.items.freeze.price', value: -1 });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /balance\.items\.freeze\.price/);
  assert.equal(readConfigFile(dir, 'balance.json'), snapshot, '被拒的值不许落盘');

  // default.json 顶层的 online.* 也要被同一套规则拦住（它虽然写在 default.json 里）
  const defSnapshot = readConfigFile(dir, 'default.json');
  const badEnum = admin.writeJson({ path: 'online.tailscale.expose', value: 'bogus' });
  assert.equal(badEnum.ok, false);
  assert.match(badEnum.message, /tailscale\.expose/);
  assert.equal(readConfigFile(dir, 'default.json'), defSnapshot);
  rmSync(dir, { recursive: true, force: true });
});

test('value=null 删键但保留空父对象；重复删同一个键仍然 ok（幂等）', () => {
  const dir = sandbox();
  const file = join(dir, 'config', 'default.json');
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  raw.tempProbe = { a: 1 };
  writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8');
  const admin = createConfigAdmin({ rootDir: dir });
  assert.equal(admin.writeJson({ path: 'tempProbe.a', value: null }).ok, true);
  const after = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(after.tempProbe, {}, '父对象要保留，只是子键没了');
  assert.equal(admin.writeJson({ path: 'tempProbe.a', value: null }).ok, true, '删已不存在的键不算错');
  rmSync(dir, { recursive: true, force: true });
});

test('坏 JSON 备份成 <file>.broken.<ts> 再重建，原子写不留 .tmp', () => {
  const dir = sandbox();
  const file = join(dir, 'config', 'llm.json');
  writeFileSync(file, '{ 这不是 JSON', 'utf8');
  const out = writeJsonFileOverride(dir, { sampleDir: dir, path: 'llm.enabled', value: false });
  assert.equal(out.ok, true);
  assert.equal(out.file, 'config/llm.json');
  const names = readdirSync(join(dir, 'config'));
  const broken = names.filter((n) => n.startsWith('llm.json.broken.'));
  assert.equal(broken.length, 1, '坏文件先备份，不能静默丢掉用户原来的内容');
  assert.equal(readFileSync(join(dir, 'config', broken[0]), 'utf8'), '{ 这不是 JSON', '备份的就是原文');
  assert.equal(names.filter((n) => n.endsWith('.tmp')).length, 0, '原子写不许留临时文件');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).enabled, false);
  rmSync(dir, { recursive: true, force: true });
});

test('掩码串不许写回（那是显示值），路径穿越一律拒绝', () => {
  const dir = sandbox();
  const masked = admin => admin.writeJson({ path: 'llm.openaiCompat.apiKeyEnv', value: 'abcd****（共 256 位）' });
  const admin = createConfigAdmin({ rootDir: dir });
  const r = masked(admin);
  assert.equal(r.ok, false);
  assert.match(r.message, /脱敏/);
  assert.equal(admin.writeJson({ path: '../escape', value: 1 }).ok, false);
  assert.equal(admin.writeJson({ path: 'a..b', value: 1 }).ok, false);
  rmSync(dir, { recursive: true, force: true });
});

test('jsonTree 带 files 三段清单，值取生效值（merged），面板不用自己猜哪段对应哪个文件', () => {
  const dir = sandbox();
  const admin = createConfigAdmin({ rootDir: dir });
  const tree = admin.jsonTree({});
  assert.equal(tree.ok, true);
  assert.deepEqual(tree.files.map((f) => f.key), ['default', 'llm', 'balance']);
  assert.deepEqual(tree.files.map((f) => f.label), ['config/default.json', 'config/llm.json', 'config/balance.json']);
  for (const f of tree.files) assert.equal(f.file, f.label);
  // 树节点 path 带段前缀：default.json 的顶层键在树里是 app.<key>，llm.json/balance.json 各自一段。
  // 这样面板才能只按 path 首段就把一次改动分流到正确的文件。
  assert.ok(tree.tree.some((n) => n.path.startsWith('app.')), 'default.json 的键挂在 app 段下');
  assert.ok(tree.tree.some((n) => n.path.startsWith('llm.')), 'llm.json 的键挂在 llm 段下');
  assert.ok(tree.tree.some((n) => n.path.startsWith('balance.')), 'balance.json 的键挂在 balance 段下');
  // 写一个值后树里看到的就是磁盘上的新值（不是样例旧值）
  assert.equal(admin.writeJson({ path: 'app.tickRate', value: 9 }).ok, true);
  const again = admin.jsonTree({}).tree.find((n) => n.path === 'app.tickRate');
  assert.equal(again.value, '9', '树里给的是磁盘上的真实值');
  rmSync(dir, { recursive: true, force: true });
});

test('写盘成功后触发 onApply，带上 section=json 与落点文件（前端据此提示「已写入 config/xxx.json」）', () => {
  const dir = sandbox();
  const calls = [];
  const admin = createConfigAdmin({ rootDir: dir, onApply: (info) => { calls.push(info); } });
  assert.equal(admin.writeJson({ path: 'tickRate', value: 11 }).ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].section, 'json');
  assert.equal(calls[0].file, 'config/default.json');
  assert.deepEqual(calls[0].patch, { tickRate: 11 });
  // 被拒的写入不该触发 onApply
  assert.equal(admin.writeJson({ path: 'balance.items.freeze.price', value: -5 }).ok, false);
  assert.equal(calls.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

// ---- 格式化保真（v0.7.1）：写回只产生「那个值变了」的 diff，不许整篇重排 ----
// 为什么重要：用户原话是「直接把几个 json 放上去改」，改一个 tickRate 却让 balance.json 冒出上百行
// diff，用户只会认为我们把他的文件搞乱了。所以缩进风格与换行符都必须沿用原文件。

test('紧凑单行文件保持紧凑：diff 只有数字变化', () => {
  const dir = sandbox();
  const file = join(dir, 'config', 'default.json');
  writeFileSync(file, '{"a": {"b": 1}, "c": [1, 2]}', 'utf8');
  const before = readFileSync(file, 'utf8');
  assert.equal(detectIndent(before), '', '没有换行 = 紧凑单行');
  const out = writeJsonFileOverride(dir, { path: 'app.a.b', value: 2 });
  assert.equal(out.ok, true);
  const after = readFileSync(file, 'utf8');
  // v0.7.1 起走「按行替换」：只换数字那一个字符，连原本键值之间的空格都原样留着 ——
  // 紧凑文件的字节级 diff 就是 '1' → '2' 一个字符，其余完全不动。
  assert.equal(after.trim().includes('\n'), false, '紧凑文件不许被摊成多行');
  assert.equal(after, '{"a": {"b": 2}, "c": [1, 2]}');
  assert.equal(after.length, before.length, '只换一个字符，长度不变');
  assert.deepEqual(JSON.parse(after), { a: { b: 2 }, c: [1, 2] });
  rmSync(dir, { recursive: true, force: true });
});

test('2 空格多行文件保持 2 空格：只有目标那一行变', () => {
  const dir = sandbox();
  const file = join(dir, 'config', 'balance.json');
  const original = { move: { baseSpeed: 120, accel: 900 }, nav: { gridSize: 16 } };
  writeFileSync(file, JSON.stringify(original, null, 2) + '\n', 'utf8');
  const before = readFileSync(file, 'utf8');
  assert.equal(detectIndent(before), 2);
  const out = writeJsonFileOverride(dir, { path: 'balance.move.baseSpeed', value: 130 });
  assert.equal(out.ok, true);
  const after = readFileSync(file, 'utf8');
  const bl = before.split('\n');
  const al = after.split('\n');
  assert.equal(al.length, bl.length, '行数不变 = 没有整篇重排');
  assert.deepEqual(al.map((l, i) => l === bl[i]).filter((x) => !x), [false], '只允许有一行不同');
  assert.equal(after, before.replace('"baseSpeed": 120', '"baseSpeed": 130'));
  assert.deepEqual(JSON.parse(after), { move: { baseSpeed: 130, accel: 900 }, nav: { gridSize: 16 } }, '键集合与键序都不变');
  rmSync(dir, { recursive: true, force: true });
});

test('CRLF + 段内紧凑的 balance.json：沿用 CRLF 与 2 空格，且同值重写不动文件', () => {
  const dir = sandbox();
  const file = join(dir, 'config', 'balance.json');
  const crlf = '{\r\n  "move": { "baseSpeed": 120 },\r\n  "nav": { "gridSize": 16 }\r\n}\r\n';
  writeFileSync(file, crlf, 'utf8');
  // 写回仍然正常（multi-line 但段内紧凑的写法会被规范化成逐行，这是可接受的 —— 关键是值与键序对）
  const out = writeJsonFileOverride(dir, { path: 'balance.nav.gridSize', value: 20 });
  assert.equal(out.ok, true);
  const after = readFileSync(file, 'utf8');
  assert.equal(after.includes('\r\n'), true, 'CRLF 文件不许被改写成 LF（否则 git 上整个文件都算改过）');
  assert.equal(after.includes('\t'), false);
  assert.deepEqual(JSON.parse(after), { move: { baseSpeed: 120 }, nav: { gridSize: 20 } });
  // v0.7.1：段内紧凑那行不再被展开，字节级只差一个字符（'16' → '20'）
  assert.equal(after, crlf.replace('"gridSize": 16', '"gridSize": 20'));
  assert.equal(after.split('\r\n').length, crlf.split('\r\n').length, '行数与 CRLF 位置都不变');
  // 幂等：写「本来就等于」的值不该让文件内容发生任何变化
  const snapshot = readFileSync(file, 'utf8');
  assert.equal(writeJsonFileOverride(dir, { path: 'balance.nav.gridSize', value: 20 }).ok, true);
  assert.equal(readFileSync(file, 'utf8'), snapshot, '同值重写必须字节级不变');
  rmSync(dir, { recursive: true, force: true });
});

test('format 可显式指定：传 2 才重排成 2 空格（默认 preserve 不会）', () => {
  const dir = sandbox();
  const file = join(dir, 'config', 'default.json');
  writeFileSync(file, '{"a": {"b": 1}}', 'utf8');
  assert.equal(writeJsonFileOverride(dir, { path: 'app.a.b', value: 2 }).ok, true);
  assert.equal(readFileSync(file, 'utf8').trim().includes('\n'), false, 'preserve 默认不重排');
  assert.equal(writeJsonFileOverride(dir, { path: 'app.a.b', value: 3, format: 2 }).ok, true);
  assert.equal(readFileSync(file, 'utf8'), '{\n  "a": {\n    "b": 3\n  }\n}\n');
  rmSync(dir, { recursive: true, force: true });
});

test('写临时目录以外的路径不可能命中：sampleDir 决定落点，找不到就明确报错', () => {
  const dir = sandbox();
  const out = writeJsonFileOverride(dir, { sampleDir: join(dir, 'nowhere'), path: 'tickRate', value: 5 });
  assert.equal(out.ok, false);
  assert.match(out.message, /找不到 config\/default\.json/);
  rmSync(dir, { recursive: true, force: true });
});
// ── v0.7.1「按行替换」保真写：diff 必须只有目标那个值 ───────────────────────────────
// 起因：仓库里的 balance.json 是「CRLF + 2 空格 + 段内紧凑单行」的写法，整篇 stringify 会把
// 段内那行展开，改一个价格 → 179 行 diff。用户看到会认为我们把他的配置文件搞乱了。
// 所以写回改成「在原文里定位目标值的字符区间，只替换这一段」，其余字节一律不动。

/** 逐字节比较：返回两个 Buffer 第一个不同的下标（-1 = 完全相同） */
function firstDiffIndex(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

test('按行替换①：段内紧凑的文件改一个标量 → 只有 1 行不同，其余字节完全相同', () => {
  const dir = sandbox();
  const file = join(dir, 'config', 'balance.json');
  // 真实 balance.json 的写法：CRLF + 2 空格缩进 + 段内紧凑单行
  const crlf =
    '{\r\n' +
    '  "move": { "baseSpeed": 120, "accel": 900, "radius": 14 },\r\n' +
    '  "items": {\r\n' +
    '    "freeze": { "price": 250, "duration": 3000 },\r\n' +
    '    "speed": { "price": 180, "mult": 1.5 }\r\n' +
    '  }\r\n' +
    '}\r\n';
  writeFileSync(file, crlf, 'utf8');
  const beforeBuf = readFileSync(file);
  const out = writeJsonFileOverride(dir, { path: 'balance.items.freeze.price', value: 260 });
  assert.equal(out.ok, true);
  const afterBuf = readFileSync(file);
  const after = afterBuf.toString('utf8');

  // 行数一行没多：段内紧凑那行没有被展开
  assert.equal(after.split('\r\n').length, crlf.split('\r\n').length, '行数必须不变（段内紧凑不许被展开）');

  const expected = crlf.replace('"price": 250', '"price": 260');
  assert.equal(after, expected, '除了这一个值，其余字节（含键值间空格）必须一模一样');

  // 逐字节：只在 "250" → "260" 的那一段不同，前缀与后缀完全相同
  const idx = firstDiffIndex(beforeBuf, afterBuf);
  assert.notEqual(idx, -1, '值变了，必然有字节不同');
  // 250 → 260：'2' 相同，第一个不同的字节是 3 个字符里的第二个（5 → 6）
  assert.equal(idx, beforeBuf.indexOf(Buffer.from('250', 'utf8')) + 1, '差异点必须落在旧值的数字位上');
  assert.equal(Buffer.compare(beforeBuf.subarray(0, idx), afterBuf.subarray(0, idx)), 0, '前缀逐字节相同');
  assert.equal(Buffer.compare(beforeBuf.subarray(idx + 3), afterBuf.subarray(idx + 3)), 0, '后缀逐字节相同');
  assert.deepEqual(JSON.parse(after), JSON.parse(expected));

  // git 视角的 diff 行数：只有这 1 行变了
  const bl = crlf.split('\r\n');
  const al = after.split('\r\n');
  assert.equal(al.filter((l, i) => l !== bl[i]).length, 1, 'git diff 只有 1 行');
  rmSync(dir, { recursive: true, force: true });
});

test('按行替换②：写字符串/布尔/null 时引号与转义正确，且不破坏相邻内容', () => {
  const dir = sandbox();
  const file = join(dir, 'config', 'default.json');
  writeFileSync(file, '{\n  "name": "old",\n  "flag": false,\n  "note": "keep",\n  "extra": 1\n}\n', 'utf8');

  // 带引号、反斜杠、换行、中文、控制字符的字符串：必须被 JSON.stringify 正确转义
  const nasty = 'he said "hi" \\ 换\n行\u0001';
  assert.equal(writeJsonFileOverride(dir, { path: 'app.name', value: nasty }).ok, true);
  let text = readFileSync(file, 'utf8');
  assert.equal(JSON.parse(text).name, nasty, '转义后读回来必须是原字符串');
  assert.equal(text.split('\n').length, 7, '字符串里的 \n 必须是转义的两个字符，不能真的换行（行数仍是原来那 7 段）');
  assert.equal(text.includes('he said \\"hi\\" \\\\ 换\\n行\\u0001'), true, '转义形式符合 JSON 规范');

  // 布尔
  assert.equal(writeJsonFileOverride(dir, { path: 'app.flag', value: true }).ok, true);
  text = readFileSync(file, 'utf8');
  assert.equal(text.includes('"flag": true'), true);
  assert.equal(JSON.parse(text).flag, true);

  // null：按既有约定「value===null = 删掉这个键」（与 config-admin.test.js 的删键用例一致），
  // 不是写成 JSON null —— 所以断言键消失，而不是文件里出现 "note": null。
  assert.equal(writeJsonFileOverride(dir, { path: 'app.note', value: null }).ok, true);
  text = readFileSync(file, 'utf8');
  assert.equal(text.includes('"note"'), false, 'null 表示删键，键名不该再出现');
  assert.equal('note' in JSON.parse(text), false);
  assert.equal(JSON.parse(text).name, nasty, '只删了 note，邻居 name 的转义值原样还在');
  // 邻居没被顺带改坏（"extra": 1 与整篇缩进都还在）
  assert.equal(text.includes('"extra": 1'), true);
  assert.equal(text.startsWith('{\n  "name"'), true, '缩进与开头不变');
  assert.equal(text.endsWith('}\n'), true, '结尾结构不变');
  rmSync(dir, { recursive: true, force: true });
});

test('按行替换③：数组元素 balance.items.freeze.prices.2 也能定位（只改那个数字）', () => {
  const dir = sandbox();
  const file = join(dir, 'config', 'balance.json');
  const crlf = '{\r\n  "items": { "freeze": { "prices": [10, 20, 30], "label": "x" } }\r\n}\r\n';
  writeFileSync(file, crlf, 'utf8');
  const out = writeJsonFileOverride(dir, { path: 'balance.items.freeze.prices.2', value: 45 });
  assert.equal(out.ok, true);
  const after = readFileSync(file, 'utf8');
  assert.equal(after, crlf.replace('30]', '45]'), '只有数组第 3 个元素变了，其余字节不动');
  assert.deepEqual(JSON.parse(after).items.freeze.prices, [10, 20, 45]);
  assert.equal(after.split('\r\n').length, crlf.split('\r\n').length, '行数不变');
  assert.equal(after.includes('\r\n'), true, 'CRLF 不许变 LF');
  rmSync(dir, { recursive: true, force: true });
});

test('按行替换④：键原本不存在 → 回退整篇重排，写入成功且 JSON 合法', () => {
  const dir = sandbox();
  const file = join(dir, 'config', 'default.json');
  const crlf = '{\r\n  "move": { "baseSpeed": 120 }\r\n}\r\n';
  writeFileSync(file, crlf, 'utf8');
  // 'newKey' 原文里没有 → 定位失败 → 回退。回退也必须保留 CRLF，且新键真的写进去了。
  const out = writeJsonFileOverride(dir, { path: 'app.newKey', value: { deep: [1, 2] } });
  assert.equal(out.ok, true);
  const after = readFileSync(file, 'utf8');
  assert.equal(after.includes('\r\n'), true, '回退路径也要保留 CRLF');
  assert.equal(/(^|[^\r])\n/.test(after), false, '不许混入裸 LF');
  const parsed = JSON.parse(after);
  assert.deepEqual(parsed, { move: { baseSpeed: 120 }, newKey: { deep: [1, 2] } });
  assert.deepEqual(Object.keys(parsed), ['move', 'newKey'], '原有键序在前面，新键追加在后面');
  rmSync(dir, { recursive: true, force: true });
});

test('按行替换⑤：原文件 CRLF 时绝不产生 LF 混入（含需要回退的情形）', () => {
  const dir = sandbox();
  const file = join(dir, 'config', 'balance.json');
  const crlf = '{\r\n  "a": { "b": 1, "c": [1, 2] },\r\n  "d": 4\r\n}\r\n';
  writeFileSync(file, crlf, 'utf8');
  for (const [p, value] of [
    ['balance.a.b', 2],            // 按行替换路径
    ['balance.a.c.0', 9],          // 数组元素
    ['balance.zzz', 'new'],        // 回退路径（新增键）
    ['balance.d', [1, 2, 3]],      // 标量 → 容器（回退路径）
  ]) {
    assert.equal(writeJsonFileOverride(dir, { path: p, value }).ok, true, p);
    const after = readFileSync(file, 'utf8');
    assert.equal(after.includes('\r\n'), true, p + ' 必须保留 CRLF');
    assert.equal(/(^|[^\r])\n/.test(after), false, p + ' 不许出现裸 LF');
    assert.doesNotThrow(() => JSON.parse(after), p + ' 必须是合法 JSON');
  }
  rmSync(dir, { recursive: true, force: true });
});

test('按行替换：源文本里同名键出现两次这种不标准写法 → 放弃精确定位、回退整篇，不写坏文件', () => {
  const dir = sandbox();
  const file = join(dir, 'config', 'default.json');
  // 同一层出现两个 "b"：JSON.parse 只保留后者，定位器不敢猜该改哪一个 → 必须回退
  writeFileSync(file, '{\n  "a": { "b": 1, "b": 5 }\n}\n', 'utf8');
  const out = writeJsonFileOverride(dir, { path: 'app.a.b', value: 9 });
  assert.equal(out.ok, true);
  const after = readFileSync(file, 'utf8');
  assert.doesNotThrow(() => JSON.parse(after));
  assert.equal(JSON.parse(after).a.b, 9);
  rmSync(dir, { recursive: true, force: true });
});

test('locateValueRange：跳过字符串里的括号/冒号，键名带点也能正确导航', () => {
  // 值里带 "}" 和 "\""（转义引号）——正则猜边界一定会在这里错，扫描器必须整段跳过字符串字面量。
  // 注意：这是合法 JSON，对应对象 { 'a.b': { x: '}{' + '": 1', y: 2 }, arr: [{ k: 3 }] }。
  const text = `{"a.b": {"x": "}{\\": 1", "y": 2}, "arr": [{"k": 3}]}`;
  assert.doesNotThrow(() => JSON.parse(text), '样本本身必须是合法 JSON');
  const r1 = locateValueRange(text, ['a.b', 'y']);
  assert.equal(text.slice(r1.start, r1.end), '2', '键名里的点不能当分隔符，值里的括号/冒号不能干扰导航');
  const r2 = locateValueRange(text, ['arr', '0', 'k']);
  assert.equal(text.slice(r2.start, r2.end), '3', '数组元素也能按逗号计数定位');
  assert.equal(locateValueRange(text, ['nope']), null, '找不到就返回 null，让调用方回退');
  assert.equal(locateValueRange(text, ['arr', '5']), null, '数组越界返回 null');
  assert.equal(locateValueRange(text, []), null, '空路径返回 null');
  assert.equal(replaceValueText(text, r1, true), text.replace('"y": 2', '"y": true'), '只换目标值');
});
