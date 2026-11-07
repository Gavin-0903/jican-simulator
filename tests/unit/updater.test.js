// 自动更新（v1.2）：版本比对、安装包挑选、下载/安装的离线用例（不依赖真实网络）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeVersion,
  versionsEqual,
  parseVersion,
  compareVersions,
  isNewerVersion,
  pickSetupUrl,
  setupFileNameFromUrl,
  createUpdater,
} from '../../server/net/Updater.js';

const DOWNLOAD_MAP = {
  '机惨模拟器-Win10满血版-v1.2.1beta-1107': 'https://example.com/jican-simulator-win10-v1.2.1beta-1107-setup.exe',
  '机惨模拟器-Win7联机客户端-v1.2.1dev-1107': 'https://example.com/jican-simulator-win7-v1.2.1dev-1107-setup.exe',
};

test('normalizeVersion 去掉 v 前缀与空白', () => {
  assert.equal(normalizeVersion('v1.2.1beta'), '1.2.1beta');
  assert.equal(normalizeVersion('  V1.2.1beta '), '1.2.1beta');
  assert.equal(normalizeVersion(undefined), '');
});

test('versionsEqual 只比是否相同（大小写不敏感，v 前缀可省）', () => {
  assert.equal(versionsEqual('v1.2.1beta', '1.2.1beta'), true);
  assert.equal(versionsEqual('1.2.1beta', '1.2.1BETA'), true);
  assert.equal(versionsEqual('1.2.1beta', '1.2.2beta'), false);
  assert.equal(versionsEqual('1.2.1beta', '1.2.1dev'), false);
  assert.equal(versionsEqual('', '1.2.1beta'), false);
});

test('parseVersion 拆出数字段 / 预发布标签 / 尾号', () => {
  assert.deepEqual(parseVersion('v1.2.1beta'), { nums: [1, 2, 1], tag: 'beta', build: null });
  assert.deepEqual(parseVersion('1.2dev'), { nums: [1, 2], tag: 'dev', build: null });
  assert.deepEqual(parseVersion('1.2.1-beta2'), { nums: [1, 2, 1], tag: 'beta', build: 2 });
  assert.deepEqual(parseVersion('1.0'), { nums: [1, 0], tag: '', build: null });
  assert.equal(parseVersion(''), null);
  assert.equal(parseVersion('abc'), null);
});

test('compareVersions：数字段 > 预发布标签 > 尾号', () => {
  // 真实事故：1.2.1beta 被告知要装 1.2dev（数字段更小，属于旧版）
  assert.ok(compareVersions('1.2dev', '1.2.1beta') < 0);
  assert.ok(compareVersions('1.2.1beta', '1.2dev') > 0);
  // 数字段优先
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
  assert.ok(compareVersions('2.0.0dev', '1.9.9') > 0);
  // 同数字段比标签：dev < beta < rc < 正式版
  assert.ok(compareVersions('1.2.1dev', '1.2.1beta') < 0);
  assert.ok(compareVersions('1.2.1beta', '1.2.1rc') < 0);
  assert.ok(compareVersions('1.2.1rc', '1.2.1') < 0);
  assert.ok(compareVersions('1.2.1', '1.2.1beta') > 0);
  // 尾号
  assert.ok(compareVersions('1.2.1beta2', '1.2.1beta') > 0);
  assert.ok(compareVersions('1.2.1beta2', '1.2.1beta1') > 0);
  // 相同 / 带 v / 大小写
  assert.equal(compareVersions('v1.2.1beta', '1.2.1BETA'), 0);
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  // 解析不了：一律不认为"更新"
  assert.equal(compareVersions('abc', '1.2.1'), 0);
  assert.equal(isNewerVersion('', '1.2.1'), false);
});

test('isNewerVersion：只有更高才算更新', () => {
  assert.equal(isNewerVersion('v1.2.1beta', '1.0.0'), true);
  assert.equal(isNewerVersion('1.2dev', '1.2.1beta'), false);
  assert.equal(isNewerVersion('1.2.1dev', '1.2.1beta'), false);
  assert.equal(isNewerVersion('1.2.1beta', '1.2.1beta'), false);
  assert.equal(isNewerVersion('1.2.2beta', '1.2.1beta'), true);
});

test('pickSetupUrl 按版本 + 渠道挑安装包', () => {
  assert.equal(
    pickSetupUrl(DOWNLOAD_MAP, { flavor: 'win10-full', version: 'v1.2.1beta' }).url,
    DOWNLOAD_MAP['机惨模拟器-Win10满血版-v1.2.1beta-1107'],
  );
  assert.equal(
    pickSetupUrl(DOWNLOAD_MAP, { flavor: 'win7-compat', version: '1.2.1dev' }).url,
    DOWNLOAD_MAP['机惨模拟器-Win7联机客户端-v1.2.1dev-1107'],
  );
  // 版本对不上就明确失败，绝不瞎猜一个安装包
  assert.equal(pickSetupUrl(DOWNLOAD_MAP, { flavor: 'win10-full', version: '9.9.9' }), null);
  assert.equal(pickSetupUrl(null, { flavor: 'win10-full', version: '1.2.1beta' }), null);
});

test('setupFileNameFromUrl 取文件名并拒绝危险字符', () => {
  assert.equal(setupFileNameFromUrl('https://x/y/abc-setup.exe?download=1'), 'abc-setup.exe');
  assert.equal(setupFileNameFromUrl('https://x/y/abc.txt'), 'jican-simulator-setup.exe');
  assert.equal(setupFileNameFromUrl('not a url'), 'jican-simulator-setup.exe');
});

function feedResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('createUpdater：检查到新版本 → 下载 → 启动安装程序并退出', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jican-update-'));
  const payload = 'x'.repeat(4096);
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const u = String(url);
    if (u.endsWith('version.json')) {
      return feedResponse({ version: 'v1.2.1beta', channel: '开发版', headline: '测试', notes: ['一', '二'] });
    }
    if (u.endsWith('download.json')) return feedResponse(DOWNLOAD_MAP);
    if (u.endsWith('.exe')) {
      return new Response(payload, { status: 200, headers: { 'content-length': String(payload.length) } });
    }
    return feedResponse({}, 404);
  };
  let quitReason = null;
  const spawned = [];
  const updater = createUpdater({
    rootDir: dir,
    dataDir: dir,
    enabled: true,
    version: '1.0.0',
    flavor: 'win10-full',
    feedUrl: 'https://example.com/version.json',
    downloadMapUrl: 'https://example.com/download.json',
    fetchImpl,
    spawnImpl: (file, args, opts) => {
      spawned.push({ file, args, opts });
      return { unref() {} };
    },
    requestQuit: (reason) => {
      quitReason = reason;
    },
  });

  try {
    const checked = await updater.check();
    assert.equal(checked.updateAvailable, true);
    assert.equal(checked.localVersion, '1.0.0');
    assert.equal(checked.remoteVersion, 'v1.2.1beta');
    assert.deepEqual(checked.notes, ['一', '二']);

    // 下载完成 → ready，文件落在 <dataDir>/updates/
    const afterDownload = await updater.download();
    assert.equal(afterDownload.phase, 'ready');
    const setupFile = afterDownload.installer;
    assert.ok(existsSync(setupFile), '安装包应该已经落盘');
    assert.equal(readFileSync(setupFile, 'utf8'), payload);

    const out = await updater.install();
    assert.equal(out.ok, true);
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].file, setupFile);
    // 宿主靠这个标记一起退出
    assert.ok(existsSync(join(dir, 'update.quit')), '应该写 update.quit');
    // 安装后 600ms 才请求退出，给安装程序一点启动时间
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(quitReason, 'update');
    assert.ok(calls.some((u) => u.endsWith('download.json')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createUpdater：线上版本更旧（v1.2dev vs 本机 v1.2.1beta）不提示更新、不下载', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jican-update-'));
  let fetched = 0;
  const fetchImpl = async () => {
    fetched += 1;
    return feedResponse({ version: 'v1.2dev', channel: '开发版' });
  };
  try {
    const updater = createUpdater({ rootDir: dir, dataDir: dir, version: '1.2.1beta', fetchImpl });
    const r = await updater.check();
    assert.equal(r.updateAvailable, false, '线上更旧不能算新版本');
    assert.equal(r.phase, 'latest');
    await assert.rejects(() => updater.download(), /最新版本/);
    assert.equal(fetched, 1, '不该去拉 download.json');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createUpdater：线上版本更高（v1.2.2beta）才提示更新', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jican-update-'));
  const fetchImpl = async () => feedResponse({ version: 'v1.2.2beta' });
  try {
    const updater = createUpdater({ rootDir: dir, dataDir: dir, version: '1.2.1beta', fetchImpl });
    const r = await updater.check();
    assert.equal(r.updateAvailable, true);
    assert.equal(r.phase, 'available');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createUpdater：已是最新时不下载；关闭时不联网', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jican-update-'));
  let fetched = 0;
  const fetchImpl = async () => {
    fetched += 1;
    return feedResponse({ version: '1.2.1beta' });
  };
  try {
    const upToDate = createUpdater({ rootDir: dir, dataDir: dir, version: '1.2.1beta', fetchImpl });
    const r = await upToDate.check();
    assert.equal(r.updateAvailable, false);
    assert.equal(r.phase, 'latest');
    await assert.rejects(() => upToDate.download(), /最新版本/);

    const disabled = createUpdater({ rootDir: dir, dataDir: dir, enabled: false, version: '0.0.0', fetchImpl });
    const d = await disabled.check();
    assert.equal(d.enabled, false);
    assert.equal(fetched, 1, '关闭时不应该发任何请求');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
