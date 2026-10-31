// 安装/首次运行标记：记录「是否设为服务器源」等只问一次的选择。
// 存放在 data/settings.json（便携版即 exe 同级 data/）。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const FILE = (rootDir) => join(rootDir, 'data', 'settings.json');

const DEFAULTS = Object.freeze({ installed: false, isServerSource: false, serverUrl: '', askedServerSource: false, setupAt: null });

export function readSettings(rootDir) {
  try {
    const file = FILE(rootDir);
    if (!existsSync(file)) return { ...DEFAULTS };
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeSettings(rootDir, patch) {
  const next = { ...readSettings(rootDir), ...patch };
  const file = FILE(rootDir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/** 安装包首次运行时写入（Inno Setup 以 --setup 参数调用）。 */
export function applySetup(rootDir, { isServerSource = false, installed = true } = {}) {
  return writeSettings(rootDir, { installed, isServerSource, askedServerSource: true, setupAt: new Date().toISOString() });
}
