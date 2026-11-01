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
  assert.deepEqual(d.override, { app: {}, llm: {}, balance: {} });
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

