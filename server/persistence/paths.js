// 运行期路径：资源目录（只读）与数据目录（可写）分开解析。
//
// 为什么需要这个模块：程序装进 C:\Program Files 后，普通用户对企业目录只有「读取+执行」权限
// （icacls: BUILTIN\Users:(RX)），任何写操作都会 EPERM。旧实现把 data/ 建在 <exe目录>/data，
// 于是装好后双击必然崩：EPERM: operation not permitted, open '...\data\config.json'。
//
// 现在的规则：
//   资源（server/client/config…）  开发期 = 仓库根；SEA = <exe目录>/data/unpacked（安装时静态展开，只读）
//   数据（config.json/settings.json/id.key/存档）  开发期 = <仓库根>/data；SEA = %LOCALAPPDATA%\JicanSimulator
// 环境变量 JICAN_DATA_DIR 可显式覆盖数据目录（便携版、共享电脑、CI 测试都用得上）。

import { homedir } from 'node:os';
import { join } from 'node:path';

/** 本程序在用户目录下的固定文件夹名。 */
export const APP_DATA_FOLDER = 'JicanSimulator';

/**
 * 默认数据目录（不考虑显式覆盖）。
 * @param {{ appData?: string, platform?: string, home?: string, xdg?: string }} [env]
 */
export function defaultDataDir({ appData = process.env.LOCALAPPDATA || process.env.APPDATA || '', platform = process.platform, home = homedir(), xdg = process.env.XDG_DATA_HOME || '' } = {}) {
  if (platform === 'win32' && appData) return join(appData, APP_DATA_FOLDER);
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', APP_DATA_FOLDER);
  return join(xdg || join(home, '.local', 'share'), APP_DATA_FOLDER);
}

/**
 * 数据目录（唯一的运行期可写位置）。
 * SEA 入口会把它写进 globalThis.__JICAN_DATA_DIR__；其余模块一律通过本函数取，
 * 不要各自拼 join(rootDir, 'data')，否则安装到 Program Files 后又会 EPERM。
 */
export function dataDir() {
  const g = globalThis.__JICAN_DATA_DIR__;
  if (typeof g === 'string' && g) return g;
  if (process.env.JICAN_DATA_DIR) return process.env.JICAN_DATA_DIR;
  return defaultDataDir();
}

/** 资源目录（SEA 里是安装时展开的只读目录；开发期是仓库根）。 */
export function resourceDir(fallbackRoot = process.cwd()) {
  const g = globalThis.__JICAN_RESOURCE_DIR__;
  if (typeof g === 'string' && g) return g;
  return fallbackRoot;
}

/** 数据目录下的一个文件。 */
export function dataPath(...parts) {
  return join(dataDir(), ...parts);
}
