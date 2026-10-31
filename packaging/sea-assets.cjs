// 单文件运行时的资源虚拟文件系统（SEA 入口用 CommonJS）。
// Node SEA 的 main 按 CJS 加载、且运行期没有文件系统里的模块（require('./x') 会报 unknown builtin），
// 所以这里必须自包含：不 require 相对路径，只用 node: 内置模块。

const { existsSync, mkdirSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');

let sea = null;
try {
  sea = require('node:sea');
} catch {
  sea = null;
}

const bundled = Boolean(sea && typeof sea.isSea === 'function' && sea.isSea() && typeof sea.getAsset === 'function');

function isBundled() {
  return bundled;
}

function asset(key, encoding) {
  if (!bundled) return null;
  try {
    return sea.getAsset(String(key).replace(/^\/+/, ''), encoding);
  } catch {
    return null;
  }
}

function bundleManifest() {
  const raw = asset('app/manifest.json', 'utf8');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function assetKeys() {
  if (!bundled) return [];
  const keys = typeof sea.getAssetKeys === 'function' ? sea.getAssetKeys() : [];
  return keys.filter((k) => !k.startsWith('app/'));
}

/** 把内嵌资源展开到 dir（已存在的文件跳过），返回该目录。 */
function unpackTo(dir) {
  if (!bundled) return dir;
  for (const key of assetKeys()) {
    const target = join(dir, key);
    if (existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(asset(key)));
  }
  return dir;
}

module.exports = { isBundled, bundleManifest, assetKeys, unpackTo };
