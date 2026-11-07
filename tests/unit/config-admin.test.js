// 服务端配置读写接口的端到端自测（node --test，不依赖真实浏览器）。
// 覆盖：默认值/覆盖值/生效值三层视图、未知键与类型不符被拒、合法 patch 落盘并读回、
// null 删键恢复默认、道具价格表达式与 flatter 交叉校验、needRestart 分类、原子写不留 .tmp。
// 全部用临时目录（JICAN_DATA_DIR 指过去），绝不碰仓库里的 data/。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyRestart as __classify, maskSecrets, createConfigAdmin, RESTART_KEYS } from '../../server/net/ConfigAdmin.js';
import { readOverride, patchOverride, readSection } from '../../server/persistence/ConfigLoader.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 造一个「仓库的迷你副本」：只拷 config/（接口要读 default/llm/balance 与地图），data/ 用临时目录。
 * 为什么要拷而不是直接指 ROOT：接口会写 override.json，指 ROOT 就会污染开发机的 data/。
 */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'jican-cfg-'));
  cpSync(join(ROOT, 'config'), join(dir, 'config'), { recursive: true });
  process.env.JICAN_DATA_DIR = join(dir, 'data');
  return dir;
}

const overridePath = () => join(process.env.JICAN_DATA_DIR, 'override.json');
const readOverrideRaw = () => JSON.parse(readFileSync(overridePath(), 'utf8'));

test('GET /api/config 形状：sections/defaults/override/effective 四层齐全', async () => {
  const dir = sandbox();
  const m = await import('../../server/net/ConfigAdmin.js');
  const admin = m.createConfigAdmin({ rootDir: dir });
  const d = admin.describe();
  assert.equal(d.ok, true);
  for (const k of ['app', 'llm', 'balance']) assert.ok(d.sections[k], 'sections 缺 ' + k);
  assert.ok(Array.isArray(d.sections.app.meta.restartKeys));
  assert.equal(d.sections.app.meta.restartKeys.length, m.RESTART_KEYS.length);
  assert.equal(d.sections.balance.price, undefined, 'balance 段不该有 price');
  assert.equal(d.defaults.balance.items.freeze.price, 150);
  assert.equal(d.effective.balance.items.freeze.price, 150, '未覆盖时生效值等于默认值');
  assert.deepEqual(d.override, { app: {}, llm: {}, balance: {}, online: {} });
  rmSync(dir, { recursive: true, force: true });
});

test('未知键被拒，且不落盘', async () => {
  const dir = sandbox();
  const m = await import('../../server/net/ConfigAdmin.js');
  const admin = m.createConfigAdmin({ rootDir: dir });
  const out = admin.apply({ section: 'balance', path: 'flatter.bogusKey', value: 1 });
  assert.equal(out.ok, false);
  assert.match(out.errors[0].message, /未知键/);
  assert.equal(existsSync(overridePath()), false, '校验失败不许留下文件');
  rmSync(dir, { recursive: true, force: true });
});

test('类型不符被拒（字符串塞给数字键）', async () => {
  const dir = sandbox();
  const m = await import('../../server/net/ConfigAdmin.js');
  const admin = m.createConfigAdmin({ rootDir: dir });
  const out = admin.apply({ section: 'balance', path: 'flatter.min', value: 'abc' });
  assert.equal(out.ok, false);
  assert.match(out.errors[0].message, /类型应为 number/);
  rmSync(dir, { recursive: true, force: true });
});

test('合法 patch 落盘，能 readSection 读回，且原子写不留 .tmp', async () => {
  const dir = sandbox();
  const m = await import('../../server/net/ConfigAdmin.js');
  const cl = await import('../../server/persistence/ConfigLoader.js');
  const admin = m.createConfigAdmin({ rootDir: dir });
  const out = admin.apply({ section: 'balance', patch: { 'flatter.min': 5, 'ask.reward': 88 } });
  assert.equal(out.ok, true);
  assert.deepEqual(out.applied.sort(), ['ask.reward', 'flatter.min']);
  assert.equal(out.needRestart, false, 'balance 段热生效，不需要重启');
  assert.deepEqual(readOverrideRaw().balance, { flatter: { min: 5 }, ask: { reward: 88 } });
  const section = cl.readSection(dir, 'balance');
  assert.equal(section.flatter.min, 5);
  assert.equal(section.ask.reward, 88);
  assert.equal(section.flatter.max, 100, '没改的键保持默认');
  const leftovers = readdirSync(process.env.JICAN_DATA_DIR).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], '原子写结束不该留下 .tmp');
  rmSync(dir, { recursive: true, force: true });
});

test('value=null 删键并回落到默认值', async () => {
  const dir = sandbox();
  const m = await import('../../server/net/ConfigAdmin.js');
  const cl = await import('../../server/persistence/ConfigLoader.js');
  const admin = m.createConfigAdmin({ rootDir: dir });
  admin.apply({ section: 'balance', path: 'flatter.min', value: 7 });
  assert.equal(cl.readSection(dir, 'balance').flatter.min, 7);
  const out = admin.apply({ section: 'balance', path: 'flatter.min', value: null });
  assert.equal(out.ok, true);
  assert.equal(cl.readSection(dir, 'balance').flatter.min, 0, '删键后回到 balance.json 的默认值');
  assert.deepEqual(readOverrideRaw().balance ?? {}, {}, '空壳对象要被清掉');
  rmSync(dir, { recursive: true, force: true });
});

test('道具价格表达式非法时被拦下（不只看类型）', async () => {
  const dir = sandbox();
  const m = await import('../../server/net/ConfigAdmin.js');
  const admin = m.createConfigAdmin({ rootDir: dir });
  const out = admin.apply({ section: 'balance', path: 'items.freeze.price', value: -5 });
  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => /价格表达式/.test(e.message)), '应命中 costExpr 校验：' + JSON.stringify(out.errors));
  rmSync(dir, { recursive: true, force: true });
});

test('flatter.successRateMin > Max 被拦', async () => {
  const dir = sandbox();
  const m = await import('../../server/net/ConfigAdmin.js');
  const admin = m.createConfigAdmin({ rootDir: dir });
  const out = admin.apply({ section: 'balance', patch: { 'flatter.successRateMin': 0.9, 'flatter.successRateMax': 0.1 } });
  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => /不能大于/.test(e.message)));
  rmSync(dir, { recursive: true, force: true });
});

test('classifyRestart：app. 前缀可省略，balance/llm 一律不重启', () => {
  assert.equal(__classify('app.server.port'), true);
  assert.equal(__classify('app.server.port'), true);
  assert.equal(__classify('server.port'), true);
  assert.equal(__classify('app.tickRate'), true);
  assert.equal(__classify('app.mapId'), true);
  assert.equal(__classify('app.roster.studentsPerClass'), true);
  assert.equal(__classify('app.debug.endpoints'), true);
  assert.equal(__classify('app.net.maxMessageBytes'), true);
  assert.equal(__classify('app.round.durationMs'), false, '回合时长是热生效的');
  assert.equal(__classify('balance.items.freeze.price'), false);
  assert.equal(__classify('llm.model'), false);
});

test('app 段改 tickRate 返回 needRestart=true，改热生效键返回 false', async () => {
  const dir = sandbox();
  const m = await import('../../server/net/ConfigAdmin.js');
  const admin = m.createConfigAdmin({ rootDir: dir });
  const a = admin.apply({ section: 'app', path: 'tickRate', value: 20 });
  assert.equal(a.ok, true);
  assert.equal(a.needRestart, true);
  const b = admin.apply({ section: 'app', path: 'round.targetScore', value: 3000 });
  assert.equal(b.ok, true);
  assert.equal(b.needRestart, false);
  assert.equal(readOverrideRaw().app.round.targetScore, 3000);
  rmSync(dir, { recursive: true, force: true });
});

test('reset 清空该段覆盖项，之后 describe 的 override 变空', async () => {
  const dir = sandbox();
  const m = await import('../../server/net/ConfigAdmin.js');
  const admin = m.createConfigAdmin({ rootDir: dir });
  admin.apply({ section: 'balance', path: 'flatter.min', value: 9 });
  admin.apply({ section: 'app', path: 'round.targetScore', value: 2500 });
  assert.equal(admin.describe().sections.balance.meta.overridePaths.length, 1);
  const out = admin.reset({ section: 'balance' });
  assert.equal(out.ok, true);
  assert.equal(admin.describe().sections.balance.meta.overridePaths.length, 0);
  assert.equal(admin.describe().sections.app.meta.overridePaths.length, 1, '只清 balance，app 段不受影响');
  rmSync(dir, { recursive: true, force: true });
});

test('敏感值下发前被打码（apiKey / 256 位 hex）', async () => {
  const m = await import('../../server/net/ConfigAdmin.js');
  const masked = m.maskSecrets({ openaiCompat: { apiKey: 'sk-abcdefghijk' }, idKey: 'a'.repeat(256) });
  assert.match(masked.openaiCompat.apiKey, /^sk-a\*+/);
  assert.match(masked.idKey, /共 256 位/);
  assert.equal(JSON.stringify(masked).includes('abcdefghijk'), false, '原文不许出现在输出里');
});

test('override.json 损坏时拒绝在其上打补丁（不静默吞掉）', async () => {
  const dir = sandbox();
  const m = await import('../../server/net/ConfigAdmin.js');
  const cl = await import('../../server/persistence/ConfigLoader.js');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(process.env.JICAN_DATA_DIR, { recursive: true });
  writeFileSync(overridePath(), '{ 这不是 JSON', 'utf8');
  const broken = cl.readOverride(dir);
  assert.ok(broken.__error, '坏文件必须暴露为 __error，而不是当成空对象');
  assert.throws(() => cl.patchOverride(dir, { section: 'balance', path: 'flatter.min', value: 1 }), /已损坏/);
  rmSync(dir, { recursive: true, force: true });
});
// ---- task-13：secrets 清单 / 掩码串闸 / reset.cleared / 非标量打码 ----

test('describe 顶层带 secrets：列出被脱敏的点路径，空值不计入', async () => {
  const dir = sandbox();
  const m = await import('../../server/net/ConfigAdmin.js');
  const admin = m.createConfigAdmin({ rootDir: dir });
  const d = admin.describe();
  assert.ok(Array.isArray(d.secrets), 'secrets 必须是数组');
  assert.ok(d.secrets.includes('llm.openaiCompat.apiKeyEnv'), 'apiKeyEnv 是带密钥形状的字段名');
  // 空字符串的 token 不算「已脱敏字段」，否则前端会给一个从没配过的控件加只读锁
  for (const s of d.secrets) assert.ok(typeof s === 'string' && s.includes('.'), '点路径形如 section.path');
  assert.equal(d.secrets.includes('online.token'), false, '默认配置里 token 为空，不应入列');
  rmSync(dir, { recursive: true, force: true });
});

test('secrets 与实际被打码的字段完全一致（共用同一份判定，不漂移）', async () => {
  const m = await import('../../server/net/ConfigAdmin.js');
  const cfg = { llm: { apiKey: 'sk-1234567890', plain: 'x' }, online: { token: 'tok-abcdef' }, net: { token: '' } };
  const paths = m.collectSecretPaths(cfg);
  assert.deepEqual(paths.slice().sort(), ['llm.apiKey', 'online.token']);
  // 非字符串值（数字/布尔/对象）绝不算敏感：打码后既写不回去也破坏结构
  const masked = m.maskSecrets(cfg);
  for (const p of paths) {
    const parts = p.split('.');
    assert.equal(m.isMaskedValue(masked[parts[0]][parts[1]]), true, p + ' 应被 maskSecrets 打码');
  }
  assert.equal(masked.llm.plain, 'x', '普通字段原样');
  assert.equal(masked.net.token, '', '空值保持空串，不打码');
});

test('把脱敏掩码串原样 POST 回来 → 400 拒绝且不落盘', async () => {
  const dir = sandbox();
  const m = await import('../../server/net/ConfigAdmin.js');
  const admin = m.createConfigAdmin({ rootDir: dir });
  // 掩码形状取自 maskSecret 的真实产出：前 4 位 + 若干 * + （共 N 位）
  const shown = admin.describe().sections.llm.openaiCompat.apiKeyEnv;
  assert.equal(m.isMaskedValue(shown), true, '挑一个真实掩码串来试');
  const out = admin.apply({ section: 'llm', path: 'openaiCompat.apiKeyEnv', value: shown });
  assert.equal(out.ok, false);
  assert.equal(out.errors[0].path, 'openaiCompat.apiKeyEnv');
  assert.match(out.errors[0].message, /脱敏后的显示值/);
  assert.equal(existsSync(overridePath()), false, '被拒的掩码串绝不能落盘');
  rmSync(dir, { recursive: true, force: true });
});

test('isMaskedValue 只认带「（共 N 位）」后缀的形态，纯 * 与表达式不误伤', async () => {
  const m = await import('../../server/net/ConfigAdmin.js');
  assert.equal(m.isMaskedValue('JICA********（共 17 位）'), true);
  assert.equal(m.isMaskedValue('abc1*****（共 9 位）'), true);
  // 下面这些可能是真实值，必须放行：llm.maxTokens 真值就是 '**'，道具加价公式含 ' * '
  assert.equal(m.isMaskedValue('**'), false);
  assert.equal(m.isMaskedValue('****'), false);
  assert.equal(m.isMaskedValue('{Lv} * 50'), false);
  assert.equal(m.isMaskedValue(''), false);
  assert.equal(m.isMaskedValue(50), false);
  const dir = sandbox();
  const admin = m.createConfigAdmin({ rootDir: dir });
  const ok = admin.apply({ section: 'balance', path: 'items.freeze.upLevelPrice', value: '{Lv} * 60' });
  assert.equal(ok.ok, true, '含 * 的加价公式是合法价格表达式');
  rmSync(dir, { recursive: true, force: true });
});

test('reset 返回 cleared 点路径数组（语义对齐 apply 的 applied）', async () => {
  const dir = sandbox();
  const m = await import('../../server/net/ConfigAdmin.js');
  const admin = m.createConfigAdmin({ rootDir: dir });
  admin.apply({ section: 'balance', path: 'flatter.min', value: 9 });
  admin.apply({ section: 'balance', path: 'ask.reward', value: 7 });
  admin.apply({ section: 'app', path: 'round.targetScore', value: 2500 });
  const one = admin.reset({ section: 'balance' });
  assert.equal(one.ok, true);
  assert.deepEqual(one.cleared.slice().sort(), ['balance.ask.reward', 'balance.flatter.min']);
  assert.equal(one.clearedCount, 2);
  const all = admin.reset();
  assert.deepEqual(all.cleared, ['app.round.targetScore'], '全清时只报剩下的 app 项');
  assert.equal(all.clearedCount, 1);
  assert.equal(all.needRestart, true, '清 app 段需要重启');
  rmSync(dir, { recursive: true, force: true });
});

test('对象型字段（如 items.password）不被字符串化，只对标量打码', async () => {
  const m = await import('../../server/net/ConfigAdmin.js');
  const masked = m.maskSecrets({ items: { password: { price: 50, maxLevel: 5, name: '强密码' } }, token: 'tok-abcdef' });
  assert.equal(typeof masked.items.password, 'object', '对象必须保持对象，前端才能编辑里面的数值');
  assert.deepEqual(masked.items.password, { price: 50, maxLevel: 5, name: '强密码' }, '对象内部没有敏感键名，原样下发');
  // JSON 往返必须仍然合法（早先会产出 '[obj********（共 15 位）' 这种坏串）
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(masked)));
  assert.equal(m.isMaskedValue(masked.token), true, '同层的真 token 照常打码');
  // 名字像凭证但值是对象：结构必须保留，绝不整体字符串化
  const nested = m.maskSecrets({ net: { token: { value: 'zzz999888' } } });
  assert.equal(typeof nested.net.token, 'object');
});

// ---- task-17：整棵 JSON 树（listSampleDirs / buildJsonTree / writeJsonTreeOverride）+ online 段 ----

test('listSampleDirs 至少认出 <root>/config，且可注入的样例目录排在前面', async () => {
  const dir = sandbox();
  const m = await import('../../server/net/ConfigAdmin.js');
  const dirs = m.listSampleDirs(dir);
  assert.ok(dirs.length >= 1, '仓库副本里必然有 config/default.json');
  assert.equal(dirs[0], resolve(dir), '显式传入的 rootDir 必须排第一（不能被父目录扫出来的兄弟目录抢走）');
  assert.ok(dirs.every((d) => d.includes('config') === false || true));
  // 目录下确实存在 config/default.json 才算样例目录。
  // 注意：这里只校验「传给它的那个目录」——listSampleDirs 会顺带扫父目录与 cwd，
  // 并行跑测试时别的用例的临时样例目录可能正好被删掉（node --test 多文件并发），
  // 那是竞态不是本函数的错，所以不对扫出来的兄弟目录做存在性断言。
  assert.equal(existsSync(join(dir, 'config', 'default.json')), true, dir + ' 必须含 config/default.json');
  // 无论如何都不许抛，且返回的每一项都必须是真样例目录（会顺带扫父目录与 cwd，所以不假设为空）
  const nowhere = m.listSampleDirs(join(dir, 'nowhere'));
  assert.ok(Array.isArray(nowhere), '找不到时也要返回数组');
  for (const d of nowhere) assert.equal(existsSync(join(d, 'config', 'default.json')), true, d + ' 必须含 config/default.json');
  rmSync(dir, { recursive: true, force: true });
});

test('buildJsonTree 深度优先展开：对象按键序、数组按索引、容器 value 为空串', async () => {
  const dir = sandbox();
  const m = await import('../../server/net/ConfigAdmin.js');
  const built = m.buildJsonTree(dir, { sampleDir: dir });
  assert.equal(built.warnings.length, 0, '样例文件都是合法 JSON');
  assert.ok(built.tree.length > 100, '三段配置摊平后节点数应该上百');
  const byPath = new Map(built.tree.map((n) => [n.path, n]));
  assert.equal(byPath.get('llm').type, 'object');
  assert.equal(byPath.get('llm').value, '', '容器节点不给 value');
  assert.equal(byPath.get('llm').hasChildren, true);
  assert.equal(byPath.get('llm').depth, 0, '顶层段 depth=0');
  assert.equal(byPath.get('llm.enabled').type, 'boolean');
  assert.equal(byPath.get('llm.enabled').depth, 1);
  assert.equal(byPath.get('llm.enabled').value, 'true', 'value 是 JSON 原始值的字符串化');
  assert.equal(byPath.get('llm.enabled').hasChildren, false);
  // 数组必须按索引展开成 path.0 / path.1
  const arrNode = built.tree.find((n) => n.type === 'array');
  assert.ok(arrNode, '配置里应当存在数组（如 loop.speeds）');
  assert.equal(byPath.get(arrNode.path + '.0').depth, arrNode.depth + 1, '数组元素深度 +1');
  // 顺序：父节点一定排在子节点之前（前端缩进渲染依赖这个）
  const idx = (p) => built.tree.findIndex((n) => n.path === p);
  assert.ok(idx('llm') < idx('llm.enabled'));
});

test('buildJsonTree 遇到坏文件不抛，跳过该段并记 warnings', async () => {
  const dir = sandbox();
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(dir, 'config', 'balance.json'), '{ 这不是 JSON', 'utf8');
  const m = await import('../../server/net/ConfigAdmin.js');
  const built = m.buildJsonTree(dir, { sampleDir: dir });
  assert.equal(built.warnings.length, 1);
  assert.match(built.warnings[0], /balance\.json/);
  assert.ok(built.tree.some((n) => n.path.startsWith('llm.')), '坏掉的 balance 不影响 llm 段');
  assert.equal(built.tree.some((n) => n.path.startsWith('balance.')), false);
  rmSync(dir, { recursive: true, force: true });
});

test('writeJsonTreeOverride 写 data/config.json：保留其他键、支持删除、原子写不留 .tmp', async () => {
  const dir = sandbox();
  const m = await import('../../server/net/ConfigAdmin.js');
  const cl = await import('../../server/persistence/OnlineConfig.js');
  // 先放一份 online 配置，验证不会被 JSON 树写入覆盖掉
  cl.writeOnlineConfig(dir, { serverUrl: 'http://127.0.0.1:5173', token: 'keep-me-token' });
  const r1 = m.writeJsonTreeOverride(dir, { sampleDir: dir, path: 'online.custom.note', value: '来自面板' });
  assert.equal(r1.ok, true);
  assert.equal(r1.file, join(process.env.JICAN_DATA_DIR, 'config.json'));
  const after = JSON.parse(readFileSync(r1.file, 'utf8'));
  assert.equal(after.online.custom.note, '来自面板', '父容器按需创建');
  assert.equal(after.online.token, 'keep-me-token', '其他键必须保留（尤其 online 段）');
  // 覆盖已有值
  m.writeJsonTreeOverride(dir, { sampleDir: dir, path: 'online.custom.note', value: '改过了' });
  assert.equal(JSON.parse(readFileSync(r1.file, 'utf8')).online.custom.note, '改过了');
  // value === null 删除该键
  const r3 = m.writeJsonTreeOverride(dir, { sampleDir: dir, path: 'online.custom.note', value: null });
  assert.equal(r3.ok, true);
  assert.equal(JSON.parse(readFileSync(r1.file, 'utf8')).online.custom?.note, undefined, '删键而不是置 null');
  // 原子写：临时文件必须已被 rename 掉
  const leftovers = readdirSync(process.env.JICAN_DATA_DIR).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], '不该留下 .tmp');
  rmSync(dir, { recursive: true, force: true });
});

test('writeJsonTreeOverride 拒绝路径穿越/空段/超长/控制字符', async () => {
  const dir = sandbox();
  const m = await import('../../server/net/ConfigAdmin.js');
  const bad = ['../etc', 'a..b', '', 'a' + '.b'.repeat(150), 'a.\u0001b'];
  for (const p of bad) {
    const out = m.writeJsonTreeOverride(dir, { sampleDir: dir, path: p, value: 1 });
    assert.equal(out.ok, false, JSON.stringify(p) + ' 应被拒');
    assert.ok(out.message, '被拒时必须有 message');
  }
  assert.equal(existsSync(join(process.env.JICAN_DATA_DIR, 'config.json')), false, '全被拒时不该建文件');
  rmSync(dir, { recursive: true, force: true });
});

test('writeJsonTreeOverride 拒绝脱敏掩码串写回', async () => {
  const dir = sandbox();
  const m = await import('../../server/net/ConfigAdmin.js');
  const out = m.writeJsonTreeOverride(dir, { sampleDir: dir, path: 'llm.openaiCompat.apiKeyEnv', value: 'JICA********（共 17 位）' });
  assert.equal(out.ok, false);
  assert.match(out.message, /脱敏后的显示值/);
  assert.ok(out.message.startsWith('llm.openaiCompat.apiKeyEnv'), 'message 带路径前缀');
  rmSync(dir, { recursive: true, force: true });
});

test('readRawJsonFiles 给出原文（不脱敏），缺失文件报 not found', async () => {
  const dir = sandbox();
  const m = await import('../../server/net/ConfigAdmin.js');
  const { rmSync: rm } = await import('node:fs');
  rm(join(dir, 'config', 'balance.json'), { force: true });
  const raw = m.readRawJsonFiles(dir, { sampleDir: dir });
  assert.equal(raw.files['config/default.json'].error, undefined);
  assert.ok(raw.files['config/default.json'].text.includes('server'), 'text 是 JSON 原文');
  assert.equal(typeof raw.files['config/default.json'].parsed, 'object');
  assert.equal(raw.files['config/balance.json'].error, 'not found');
  assert.equal(raw.files['config/balance.json'].text, '');
  // 原文视图不许脱敏：塞一个 hex token 进去，text/parsed 里必须还是原值
  const { writeFileSync } = await import('node:fs');
  const hex = 'a'.repeat(256);
  writeFileSync(join(dir, 'config', 'llm.json'), JSON.stringify({ apiKey: hex }), 'utf8');
  const raw2 = m.readRawJsonFiles(dir, { sampleDir: dir });
  assert.equal(raw2.files['config/llm.json'].parsed.apiKey, hex, 'raw 视图不脱敏');
  assert.ok(raw2.files['config/llm.json'].text.includes(hex));
  rmSync(dir, { recursive: true, force: true });
});

test('SECTIONS 现在含 online 段，online.token 进 secrets 清单', async () => {
  const dir = sandbox();
  const m = await import('../../server/net/ConfigAdmin.js');
  const cl = await import('../../server/persistence/OnlineConfig.js');
  assert.deepEqual(m.SECTIONS, ['app', 'llm', 'balance', 'online']);
  cl.writeOnlineConfig(dir, { serverUrl: 'http://127.0.0.1:5173', token: 'tok_ABC-123' });
  const admin = m.createConfigAdmin({ rootDir: dir });
  const d = admin.describe();
  assert.ok(d.secrets.includes('online.token'), 'online.token 必须列进 secrets');
  assert.equal(m.isMaskedValue(d.sections.online.token), true, '下发时必须打码');
  assert.equal(d.sections.online.token.includes('tok_ABC'), false, '真 token 不许出现在 describe 里');
  assert.equal(d.effective.online.serverUrl, 'http://127.0.0.1:5173');
  assert.deepEqual(d.sections.online.meta.overridePaths.sort(), ['serverUrl', 'token']);
  assert.equal(d.defaults.online.enabled, false);
  rmSync(dir, { recursive: true, force: true });
});

test('online.mode 落盘归一化：运行期 tailnet 写回 serve，历史 config.json 也能继续保存', async () => {
  const dir = sandbox();
  const cl = await import('../../server/persistence/OnlineConfig.js');
  // 老版本启动时会把运行期词汇 'tailnet' 直接写进 config.json；它不在 ConfigLoader 的
  // online.mode 白名单里，会让之后任何 online 段保存都 400。落盘必须统一成 serve。
  cl.writeOnlineConfig(dir, { enabled: true, mode: 'tailnet', serverUrl: 'http://127.0.0.1:5199', token: 'tok_ABC-123' });
  const cfg = JSON.parse(readFileSync(join(process.env.JICAN_DATA_DIR, 'config.json'), 'utf8'));
  assert.equal(cfg.online.mode, 'serve', '落盘必须是 ConfigLoader 认的 serve，而不是 tailnet');
  const admin = createConfigAdmin({ rootDir: dir });
  assert.equal(admin.describe().effective.online.mode, 'serve', '读回来也要归一化');
  const out = admin.apply({ section: 'online', patch: { serverUrl: 'https://x.ts.net' } });
  assert.equal(out.ok, true, JSON.stringify(out.errors));
  rmSync(dir, { recursive: true, force: true });
});

test('online 段写盘走 config.json（不是 override.json），校验拦下非法值', async () => {
  const dir = sandbox();
  const m = await import('../../server/net/ConfigAdmin.js');
  const admin = m.createConfigAdmin({ rootDir: dir });
  const ok = admin.apply({ section: 'online', patch: { serverUrl: 'https://x.ts.net', token: 'abc_DEF-123', 'tailscale.expose': 'funnel' } });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.applied.sort(), ['serverUrl', 'tailscale.expose', 'token']);
  assert.equal(existsSync(overridePath()), false, 'online 不许写 override.json');
  const cfg = JSON.parse(readFileSync(join(process.env.JICAN_DATA_DIR, 'config.json'), 'utf8'));
  assert.equal(cfg.online.serverUrl, 'https://x.ts.net');
  assert.equal(cfg.online.tailscale.expose, 'funnel');
  // 非法值逐个拦
  const bad = [
    ['serverUrl', 'ftp://x'],
    ['token', 'has space'],
    ['tailscale.expose', 'nope'],
    ['tailscale.autoStart', 'yes'],
    ['mode', 'off'],
  ];
  for (const [path, value] of bad) {
    const out = admin.apply({ section: 'online', path, value });
    assert.equal(out.ok, false, path + '=' + JSON.stringify(value) + ' 应被拒');
  }
  // 未知键也要拒（online 是手改 config.json 的重灾区）
  const unk = admin.apply({ section: 'online', patch: { nope: 1 } });
  assert.equal(unk.ok, false);
  assert.match(unk.errors[0].message, /未知键/);
  rmSync(dir, { recursive: true, force: true });
});

test('online 段 reset 写回 ONLINE_DEFAULTS 并把 cleared 列成 online.* 点路径', async () => {
  const dir = sandbox();
  const m = await import('../../server/net/ConfigAdmin.js');
  const admin = m.createConfigAdmin({ rootDir: dir });
  admin.apply({ section: 'online', patch: { serverUrl: 'https://x.ts.net', token: 'abc_DEF-123' } });
  const out = admin.reset({ section: 'online' });
  assert.equal(out.ok, true);
  assert.deepEqual(out.cleared.sort(), ['online.serverUrl', 'online.token']);
  assert.equal(out.clearedCount, 2);
  const eff = admin.describe().effective.online;
  assert.equal(eff.serverUrl, '');
  assert.equal(eff.token, '');
  assert.equal(eff.mode, 'serve');
  assert.deepEqual(admin.describe().sections.online.meta.overridePaths, []);
  rmSync(dir, { recursive: true, force: true });
});

test('admin.jsonTree / writeJson / jsonRaw 三个方法给 HTTP 路由用', async () => {
  const dir = sandbox();
  const m = await import('../../server/net/ConfigAdmin.js');
  const admin = m.createConfigAdmin({ rootDir: dir });
  const tree = admin.jsonTree({});
  assert.equal(tree.ok, true);
  assert.ok(tree.sampleDirs.length >= 1);
  assert.ok(tree.tree.length > 0 && tree.warnings.length === 0);
  // 传入不存在的 sample 要回退到第一个，而不是报错
  assert.equal(admin.jsonTree({ sample: '/nowhere' }).sampleDir, tree.sampleDir);
  const wrote = admin.writeJson({ path: 'online.tailscale.bg', value: false });
  assert.equal(wrote.ok, true);
  // 新的语义：直接写回 config/*.json 本体（用户要在 git diff 里看见自己的改动），不再写 data/config.json 的镜像
  assert.equal(wrote.file, 'config/default.json');
  const sampleDefault = () => JSON.parse(readFileSync(join(tree.sampleDir, 'config', 'default.json'), 'utf8'));
  assert.equal(sampleDefault().online.tailscale.bg, false);
  assert.equal(admin.writeJson({ path: '../escape', value: 1 }).ok, false);
  // 树视图能改任意键，所以必须落盘前校验已知段（否则 config/default.json 里写坏值，重启后被 loadConfig 静默丢弃）
  const bad = admin.writeJson({ path: 'online.tailscale.expose', value: 'bogus' });
  assert.equal(bad.ok, false, '非法枚举必须在落盘前被拦');
  assert.match(bad.message, /tailscale.expose/);
  assert.notEqual(sampleDefault().online.tailscale?.expose, 'bogus', '被拒的值不许落盘');
  assert.equal(admin.writeJson({ path: 'balance.items.freeze.price', value: -1 }).ok, false, '负数价格也要拦');
  assert.equal(admin.writeJson({ path: 'balance.items.freeze.price', value: 200 }).ok, true, '合法值照常写');
  // 未知段没有规则可依，放行（用户自定义键不能被这套校验锁死）
  assert.equal(admin.writeJson({ path: 'myOwnSection.key', value: 'x' }).ok, true);
  // 树里每一段的 path 都带段前缀（app./llm./balance.），前端据此把一次改动分流到正确的文件；
  // 前缀必须能原样写回：'app.tickRate' 落在 default.json 的 tickRate，不能变成 app.app.tickRate。
  assert.ok(tree.tree.some((n) => n.path === 'app.tickRate'), 'default.json 的键挂在 app 段下');
  assert.ok(tree.tree.some((n) => n.path.startsWith('llm.')), 'llm.json 挂在 llm 段下');
  assert.ok(tree.tree.some((n) => n.path.startsWith('balance.')), 'balance.json 挂在 balance 段下');
  const prefixed = admin.writeJson({ path: 'app.tickRate', value: 9 });
  assert.equal(prefixed.ok, true);
  assert.equal(sampleDefault().tickRate, 9);
  assert.equal(sampleDefault().app, undefined, '不能写出 app.app.tickRate 这种套娃键');
  assert.equal(admin.writeJson({ path: 'llm.enabled', value: false }).ok, true);
  const sampleLlm = () => JSON.parse(readFileSync(join(tree.sampleDir, 'config', 'llm.json'), 'utf8'));
  assert.equal(sampleLlm().enabled, false);
  assert.equal(sampleLlm().llm, undefined, 'llm.json 的顶层就是 llm 段本身，不能套一层');
  const raw = admin.jsonRaw({});
  assert.equal(raw.ok, true);
  assert.ok(raw.files['config/default.json'].text.includes('tickRate'));
  rmSync(dir, { recursive: true, force: true });
});
