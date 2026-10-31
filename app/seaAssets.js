// 单文件运行时的资源虚拟文件系统。
// 普通 node server/index.js 运行时没有内嵌资源，isBundled() 返回 false，
// 上层（startServer）就退回读真实磁盘；打包后的 exe 里 isBundled() 为 true，
// 所有 config/maps/client/shared 文件都从内嵌 assets 读取（先落到 data/unpacked/ 再按普通文件托管）。

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

let sea = null;
try {
  // node:sea 只在 20.12+ 可用；开发环境没有内嵌资源时直接走磁盘。
  sea = await import('node:sea');
} catch {
  sea = null;
}

const bundled = Boolean(sea && typeof sea.isSea === 'function' && sea.isSea() && typeof sea.getAsset === 'function');

export function isBundled() {
  return bundled;
}

function asset(key, encoding) {
  if (!bundled) return null;
  try {
    return sea.getAsset(key.replace(/^\/+/, ''), encoding);
  } catch {
    return null;
  }
}

export function bundleManifest() {
  const raw = asset('app/manifest.json', 'utf8');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function assetKeys() {
  if (!bundled) return [];
  const keys = typeof sea.getAssetKeys === 'function' ? sea.getAssetKeys() : [];
  return keys.filter((k) => !k.startsWith('app/'));
}

/** 把内嵌资源展开到 dir（已存在的文件跳过），返回展开后的根目录。 */
export function unpackTo(dir) {
  if (!bundled) return dir;
  for (const key of assetKeys()) {
    const target = join(dir, key);
    if (existsSync(target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(asset(key)));
  }
  return dir;
}
