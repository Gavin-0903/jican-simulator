// config.json 联机段读写（需求：安装后检测 TailScale → 开启联机 → 写入本机服务器源地址与默认 token）。
//
// 之所以不直接改 config/default.json：那是仓库里的基线配置，被 git 跟踪、也会被 SEA 内嵌；
// 运行期的用户选择一律写进 data/config.json 的 online 段，由 readOnlineConfig/applyOnline
// 合并后交给服务端，效果等价于「修改 config.json 开启联机功能」，但不会污染基线。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * 数据目录：SEA 单文件运行时由 entry 设置 globalThis.__JICAN_DATA_DIR__（= <exe目录>/data）。
 * 未设置时按开发期约定落到 <rootDir>/data —— 源码运行时 rootDir 是仓库根，
 * 两者结果一致，但 SEA 里 rootDir 是 <exe目录>/data/unpacked，必须靠全局变量指回外层，
 * 否则安装器写进 data/config.json 的联机配置会被丢到 unpacked/data/ 下，重启后读不到。
 */
export function dataDirOf(rootDir) {
  const g = globalThis.__JICAN_DATA_DIR__;
  if (typeof g === 'string' && g) return g;
  return join(rootDir, 'data');
}

const FILE = (rootDir) => join(dataDirOf(rootDir), 'config.json');

export const ONLINE_DEFAULTS = Object.freeze({
  enabled: false,
  mode: 'serve',
  serverUrl: '',
  token: '',
  port: 5173,
  tailscale: { autoStart: true, expose: 'serve' },
});

/** 读 data/config.json（不存在或损坏都返回默认值，绝不抛）。 */
export function readOnlineConfig(rootDir) {
  const file = FILE(rootDir);
  if (!existsSync(file)) return { ...ONLINE_DEFAULTS, tailscale: { ...ONLINE_DEFAULTS.tailscale } };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const online = raw?.online ?? {};
    return {
      ...ONLINE_DEFAULTS,
      ...online,
      tailscale: { ...ONLINE_DEFAULTS.tailscale, ...(online.tailscale ?? {}) },
    };
  } catch {
    return { ...ONLINE_DEFAULTS, tailscale: { ...ONLINE_DEFAULTS.tailscale } };
  }
}

/** 合并写入 data/config.json（只动 online 段，保留其它自定义键）。 */
export function writeOnlineConfig(rootDir, patch) {
  const file = FILE(rootDir);
  let raw = {};
  try {
    if (existsSync(file)) raw = JSON.parse(readFileSync(file, 'utf8')) ?? {};
  } catch {
    raw = {};
  }
  const prev = raw.online ?? {};
  raw.online = {
    ...ONLINE_DEFAULTS,
    ...prev,
    ...patch,
    tailscale: { ...ONLINE_DEFAULTS.tailscale, ...(prev.tailscale ?? {}), ...(patch.tailscale ?? {}) },
  };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8');
  return raw.online;
}

/**
 * 打开联机并把本机写成服务器源。
 * @param {{ rootDir: string, url: string, token: string, port?: number, mode?: 'serve'|'funnel' }} o
 */
export function enableServerSource({ rootDir, url, token, port = 5173, mode = 'serve' }) {
  return writeOnlineConfig(rootDir, { enabled: true, mode, serverUrl: url, token, port });
}

/** 关闭联机（设置页可以点回单机）。 */
export function disableOnline(rootDir) {
  return writeOnlineConfig(rootDir, { enabled: false, serverUrl: '', token: '' });
}
