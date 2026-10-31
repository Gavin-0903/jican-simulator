// 本机「ID 密钥」：联机模式下的身份凭证。首次运行生成一次并持久化，之后只读复用。
// 格式（需求 3）：[时区]*[MAC]*[OS]*[默认语言]*[安装?用户名:系统应用数量]*[256位随机]
// 每一段先转成字符序列再折算成 16 进制，最后整体补齐成 256 位 hex。
// 服务器校验格式：不合规（被篡改）直接返回 500。

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { networkInterfaces, tmpdir, type } from 'node:os';

const KEY_RE = /^[0-9a-f]{256}$/;

/** 段 → 16 进制指纹：先转字符，再按 UTF-8 取 md5，取前若干位。 */
function segHex(value, chars = 8) {
  const text = String(value ?? '');
  const digest = createHash('md5').update(Buffer.from(text, 'utf8')).digest('hex');
  return digest.slice(0, chars);
}

function firstMac() {
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.mac && net.mac !== '00:00:00:00:00:00') return net.mac.replace(/:/g, '').toLowerCase();
    }
  }
  return 'nomac';
}

function osTag() {
  const names = { win32: 'win', darwin: 'mac', linux: 'linux' };
  return `${names[type()] ?? 'unknown'}-${process.arch}`;
}

function defaultLanguage() {
  const raw = process.env.LANG || process.env.LC_ALL || 'zh_CN';
  return raw.split('.')[0].replace(/[^a-zA-Z0-9_]/g, '') || 'zh_CN';
}

/**
 * 计算本机 ID 密钥（纯函数，种子随机串可控，便于测试）。
 * 返回 256 位小写 hex 字符串。
 */
export function computeIdKey({ timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', mac = firstMac(), os = osTag(), lang = defaultLanguage(), installed = false, username = process.env.USERNAME || process.env.USER || 'user', appCount = 0, rand = randomBytes(32).toString('hex') } = {}) {
  const userSeg = `${installed ? 'installed' : 'portable'}:${username}:${appCount}`;
  const parts = [segHex(timezone), segHex(mac), segHex(os), segHex(lang), segHex(userSeg), segHex(rand, 32)];
  // 段与段之间做一次异或融合（前一段滚动异或下一段），再把 88 位 hex 扩到 256 位：
  // 用 sha256 对融合结果再做一次摘要，避免出现大量补零导致密钥熵骤降。
  let acc = 0;
  for (const p of parts) for (const ch of p) acc = ((acc << 3) ^ acc ^ ch.charCodeAt(0)) >>> 0;
  const mixed = parts.join(':') + ':' + acc.toString(16);
  let out = '';
  for (let round = 0; out.length < 256; round++) out += createHash('sha256').update(`${mixed}#${round}`).digest('hex');
  return out.slice(0, 256);
}

export function isValidIdKey(key) {
  return typeof key === 'string' && KEY_RE.test(key);
}

/** 密钥文件位置：便携版放在 exe 同级 data/，开发环境放在 data/。 */
export function idKeyPath(rootDir) {
  return join(rootDir, 'data', 'id.key');
}

/** 读取或首次生成；返回 { key, created }。 */
export function loadOrCreateIdKey(rootDir, { logger = console } = {}) {
  const file = idKeyPath(rootDir);
  try {
    if (existsSync(file)) {
      const raw = readFileSync(file, 'utf8').trim();
      if (isValidIdKey(raw)) return { key: raw, created: false, file };
      logger.warn?.('[idkey] data/id.key 格式非法，已重新生成');
    }
  } catch {
    /* 读失败按未生成处理 */
  }
  const key = computeIdKey();
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, key, { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    logger.warn?.(`[idkey] 无法写入 ${file}（${err.message}），本次运行使用内存中的密钥`);
    return { key, created: true, file: null };
  }
  return { key, created: true, file };
}

export { tmpdir };
