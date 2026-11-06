// 邀请链接构建（P2-A 与 P2-B 共用）：ConfigPanel 的「联机连接」面板与 NetPanel 的建房结果都用它。
//
// 为什么单独一个文件：邀请链接的字段顺序、token 长度、username 编码一旦两边各写一份，
// 就会出现「面板里复制的链接联机页不认」这种极难排查的问题。这里只放纯函数，不碰 DOM、不引别的模块。
//
// 约定：
//   · token 必须是 256 位十六进制（服务端 checkToken 与 RoomClient 都按这个校验）；
//   · id 是「服务器源的 ID 密钥」（/api/local/id 的 idKey），加入方带着它做身份校验；
//   · type=join 表示这是一条「加入已有房间」的邀请，不带房间号时进大厅自己挑房间。

/** 256 位十六进制房间口令（128 字节 → 256 hex）。crypto 不可用时退化成 Math.random 兜底。 */
export function randomToken() {
  const bytes = new Uint8Array(128);
  const c = typeof crypto !== 'undefined' ? crypto : null;
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** 去掉 origin 尾部的斜杠（'https://a//' → 'https://a'）；空值返回空串。 */
export function normalizeOrigin(origin) {
  return String(origin == null ? '' : origin).trim().replace(/\/+$/, '');
}

/**
 * 拼一条邀请链接：{origin}/?token=<token>&id=<idKey>&type=join&username=<名字>
 *
 * 参数缺省时按「能省则省」处理，但 origin 与 token 是必需的——
 * 少了它们链接点开也加不进去，所以缺失时直接返回空串，让调用方显示「无法生成邀请链接」。
 * username 用 encodeURIComponent：中文名/空格/emoji 都能安全进 URL。
 */
export function buildInviteUrl({ origin, token, idKey, username } = {}) {
  const base = normalizeOrigin(origin);
  const tk = String(token == null ? '' : token).trim();
  if (!base || !tk) return '';
  const params = [['token', tk], ['id', String(idKey == null ? '' : idKey).trim()], ['type', 'join']];
  const name = String(username == null ? '' : username).trim();
  if (name) params.push(['username', name]);
  const qs = params.map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
  return base + '/?' + qs;
}

/** 这条 token 是否是 256 位十六进制（不合法时面板给红字提示，别让用户复制出去一条废链接）。 */
export function isInviteToken(token) {
  return /^[0-9a-fA-F]{256}$/.test(String(token == null ? '' : token).trim());
}

export default { randomToken, buildInviteUrl, normalizeOrigin, isInviteToken };
