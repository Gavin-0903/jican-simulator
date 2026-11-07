// config.json 联机段读写（需求：安装后检测 TailScale → 开启联机 → 写入本机服务器源地址与默认 token）。
//
// 之所以不直接改 config/default.json：那是仓库里的基线配置，被 git 跟踪、也会被 SEA 内嵌；
// 运行期的用户选择一律写进 data/config.json 的 online 段，由 readOnlineConfig/applyOnline
// 合并后交给服务端，效果等价于「修改 config.json 开启联机功能」，但不会污染基线。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir } from './paths.js';

/**
 * 数据目录（真正的可写目录，见 persistence/paths.js）：
 *   - 开发期 = <仓库根>/data
 *   - SEA = %LOCALAPPDATA%\JicanSimulator（安装到 Program Files 时无权写安装目录，见 paths.js 注释）
 * rootDir 参数保留只为兼容旧调用点，实际路径不再依赖它。
 */
export function dataDirOf(_rootDir) {
  return dataDir();
}

const FILE = (_rootDir) => join(dataDir(), 'config.json');

export const ONLINE_DEFAULTS = Object.freeze({
  enabled: false,
  mode: 'serve',
  serverUrl: '',
  token: '',
  port: 5173,
  tailscale: { autoStart: true, expose: 'serve' },
});

/**
 * 落盘的 mode 只能是 'serve' | 'funnel' | 'off'（ConfigLoader 的 online.mode 规则如此）。
 * 但运行期对外用的是 'tailnet' 这套三选一词汇，历史版本还会把 'tailnet' 直接写进 config.json；
 * 这里统一归一化，否则读回来的值会被校验判成非法，设置页任何 online 段改动都会 400。
 */
function normalizeStoredMode(mode) {
  const m = String(mode ?? '').trim().toLowerCase();
  if (m === 'funnel') return 'funnel';
  if (m === 'off' || m === 'none' || m === 'disabled') return 'off';
  if (m === 'tailnet' || m === 'serve' || m === 'tsnet') return 'serve';
  return ONLINE_DEFAULTS.mode;
}

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
      mode: normalizeStoredMode(online.mode),
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
    mode: normalizeStoredMode(patch.mode ?? prev.mode),
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
