// 大厅顶部的「单机 / 联机」切换与联机房间面板（需求 3）。
// 本机角色以 GET /api/net/info 探测为准。该接口现在所有实例都会返回 200，
// 所以判定必须看 body.serverSource：true → 本机就是服务器源；false → 本机是客户端，需要手填服务器源地址与 Token。
// 兼容老服务端：只有服务器源才挂这个接口时，客户端会拿 404，同样按「客户端」处理。
// 建房 / 加入都走 GET {origin}/api/net/join?...，房间号、Token、邀请码、成员全部以服务端返回为准。

import { h, icon } from '../util/dom.js';
import { forceEnglishInput } from '../util/ime.js';
import { RoomClient, checkToken } from '../net/RoomClient.js';

/** 生成 256 位十六进制房间口令（客户端 Token 校验要求 /^[0-9a-fA-F]{256}$/）。 */
function randomToken() {
  const bytes = new Uint8Array(128); // 128 字节 → 256 位十六进制
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export class NetPanel {
  constructor(store) {
    this.store = store;
    this.client = new RoomClient(store);
    this.mode = 'solo'; // 'solo' | 'net'
    this.origin = ''; // 服务器源地址（本机是服务器源时自动填本机地址）
    this.token = ''; // 服务器源 Token
    this.idKey = '';
    this.username = '';
    this.roomId = '';
    this.invCode = '';
    this.busy = '';
    this.error = '';
    this.info = null; // { ok, origin, name, rooms } | { ok:false, error }
    this.result = null; // 最近一次成功创建/加入的结果
    this.probed = false;
    this.mounted = false; // 大厅重新渲染时会被挪到新容器，期间不能重复探测
    this.#loadIdKey();
    this.refresh();
  }

  /** 大厅每次重渲染时把新容器交给面板。 */
  mount(root) {
    this.root = root;
    this.mounted = true;
    this.render();
  }

  get probing() {
    return this.busy === 'probe';
  }

  async refresh() {
    await this.#probe();
  }

  /**
   * 探测本机是否就是服务器源。
   * 服务端 GET /api/net/info 现在所有实例都会返回 200，判定依据是 body.serverSource：
   *   - true  → 本机是服务器源，服务器源固定为 location.origin；
   *   - false → 本机是客户端，需要手填服务器源 URL 与 Token。
   * 老版本只在服务器源上挂这个接口（客户端拿 404），所以 404 也按「客户端」处理。
   */
  async #probe() {
    if (this.busy === 'probe') return;
    this.busy = 'probe';
    this.render();
    let info;
    try {
      const res = await fetch('/api/net/info', { cache: 'no-store' });
      if (res.ok) {
        const body = await res.json().catch(() => null);
        const isSource = body?.ok === true && body?.serverSource === true;
        info = isSource
          ? { ok: true, origin: location.origin, name: String(body.name ?? '服务器源'), rooms: Number(body.rooms) || 0, idKeyHint: String(body.idKeyHint ?? '') }
          : { ok: false, error: '本机是客户端（serverSource: false）——请填写服务器源的地址与 Token' };
      } else if (res.status === 404) {
        // 老服务端：只有服务器源才挂 /api/net/info
        info = { ok: false, error: '本机是客户端（没有 /api/net/info）——请填写服务器源的地址与 Token' };
      } else {
        info = { ok: false, error: `探测失败（HTTP ${res.status}），请手填服务器源地址与 Token` };
      }
    } catch (err) {
      info = { ok: false, error: `探测失败：${err?.message ?? err}` };
    }
    this.info = info;
    this.probed = true;
    this.busy = '';
    if (info.ok && !this.origin) this.origin = info.origin;
    this.render();
  }

  /**
   * 本机 ID 密钥（联机身份标识）；读不到就返回空串，由 submit 提示「联机需要 ID 密钥」。
   * /api/local/id 同时带 serverSource，若探测接口不可用（老服务端 404），这里可以兜底判定本机角色。
   */
  async #loadIdKey() {
    try {
      const res = await fetch('/api/local/id', { cache: 'no-store' });
      if (!res.ok) return '';
      const body = await res.json();
      if (body?.ok !== true) return '';
      // 兜底：探测没拿到结论时，用 /api/local/id 的 serverSource 判断本机是不是服务器源
      if (!this.probed && body.serverSource === true && !this.info?.ok) {
        this.info = { ok: true, origin: location.origin, name: '服务器源', rooms: 0, idKeyHint: '' };
        if (!this.origin) this.origin = location.origin;
      }
      return String(body.idKey ?? '');
    } catch {
      return '';
    }
  }

  /** 取 ID 密钥 → 调用创建/加入 → 结果写回 state 并重渲染。 */
  async submit(type) {
    if (this.busy) return;
    this.error = '';
    // 本机是服务器源且没填 Token 时，自动生成一个 256 位十六进制口令，避免服务端判「缺少 token」
    if (this.info?.ok && !this.token.trim()) this.token = randomToken();
    // Token 是「服务器源的房间口令」：服务端 parseRoomUrl 要求 token 字段非空（空串会被判「缺少 token」），
    // 所以两种模式都必须给出一个非空 Token；本机是服务器源时上面已自动生成，客户端模式必须手填。
    const mustToken = true;
    const tokenCheck = this.token.trim() ? checkToken(this.token) : { ok: false, message: '请填写服务器源 Token' };
    if (!this.info?.ok && !this.origin) {
      this.error = '请先填写服务器源地址';
      return this.render();
    }
    if (mustToken && !tokenCheck.ok) {
      this.error = tokenCheck.message;
      return this.render();
    }
    if (type === 'join' && !this.roomId.trim()) {
      this.error = '请填写要加入的房间号';
      return this.render();
    }
    this.busy = type;
    this.render();
    if (!this.idKey) this.idKey = await this.#loadIdKey();
    if (!this.idKey) {
      this.busy = '';
      this.error = '联机需要 ID 密钥：本机没有可用的 /api/local/id';
      return this.render();
    }
    const origin = (this.info?.ok ? this.origin || this.info.origin : this.origin).replace(/\/+$/, '');
    const params = {
      origin,
      token: tokenCheck.value,
      idKey: this.idKey,
      username: this.username.trim() || `玩家${Math.floor(Math.random() * 900 + 100)}`,
    };
    const out = type === 'create'
      ? await this.client.create(params)
      : await this.client.joinRoom({ ...params, roomId: this.roomId.trim(), invCode: this.invCode.trim() });
    this.busy = '';
    if (!out.ok) {
      // 失败（HTTP 500 等）把服务端的 error 原样展示，连续失败也照常提示
      this.error = out.error;
      return this.render();
    }
    this.result = out;
    this.origin = origin;
    this.render();
  }

  render() {
    const root = this.root;
    if (!root) return;
    const isSolo = this.mode === 'solo';
    const seg = h('div.segmented.net-mode', { role: 'group', 'aria-label': '游戏模式' },
      h('button', { 'aria-pressed': String(isSolo), onclick: () => { this.mode = 'solo'; this.render(); } }, icon('user', 'sm'), '单机'),
      h('button', { 'aria-pressed': String(!isSolo), onclick: () => { this.mode = 'net'; this.render(); if (!this.probed) this.#probe(); } }, icon('signal', 'sm'), '联机'));
    root.replaceChildren(h('div.net-mode-bar', {}, seg,
      h('span.net-hint', { text: isSolo ? '单机：本机开一局，不需要网络' : '联机：通过服务器源建房 / 加入' })),
    isSolo ? null : this.#netBody());
  }

  #netBody() {
    const info = this.info;
    const isSource = !!info?.ok;
    const roleText = this.busy === 'probe'
      ? '正在探测本机角色…'
      : isSource
        ? `本机角色：服务器源（${info.name}，当前 ${info.rooms} 间房）`
        : '本机角色：客户端（需要填写服务器源地址与 Token）';

    const textInput = (label, key, opts = {}) => {
      const input = h('input.input' + (opts.mono ? '.net-mono' : ''), {
        type: opts.password ? 'password' : 'text',
        placeholder: opts.placeholder ?? '',
        value: this[key] ?? '',
        'aria-label': label,
        ...(opts.readonly ? { readonly: true } : {}),
        oninput: (e) => { this[key] = e.target.value; },
      });
      forceEnglishInput(input);
      return h('div.net-row', {}, h('label', { text: label }), input);
    };

    const rows = [];
    if (isSource) {
      // 本机是服务器源：默认使用本机地址，直接显示
      rows.push(h('div.net-row', {}, h('label', { text: '服务器源' }), h('span.net-kv-inline', { text: info.origin })));
    } else {
      rows.push(textInput('服务器源 URL', 'origin', { placeholder: 'https://xxxxx.ts.net' }));
      rows.push(textInput('Token', 'token', { placeholder: '服务器源给的 Token（256 位十六进制）', mono: true }),
        h('div.net-hint', { text: 'Token 应为 256 位十六进制；服务端用 ID 密钥（/api/local/id）校验身份。' }));
    }
    // 本机是服务器源：Token 自己定（服务端要求该字段非空，长度任意，join 时要用同一个）
    if (isSource) rows.push(textInput('Token', 'token', { placeholder: '房间口令（自定，加入者需填同一个）', mono: true }));
    rows.push(textInput('用户名', 'username', { placeholder: '显示给同房间的其他玩家' }));

    const actions = h('div.net-actions', {},
      h('button.btn.primary.sm', { disabled: !!this.busy, onclick: () => this.submit('create') }, icon('door', 'sm'), this.busy === 'create' ? '创建中…' : '创建房间'),
      h('button.btn.sm', { disabled: !!this.busy, onclick: () => this.submit('join') }, icon('signal', 'sm'), this.busy === 'join' ? '加入中…' : '加入房间'));

    const joinRows = h('div.net-join', {},
      textInput('房间号', 'roomId', { placeholder: '6 位数字', mono: true }),
      textInput('邀请码', 'invCode', { placeholder: '8 位邀请码', mono: true }));

    return h('div.net-panel.card',
      h('div.net-role', {}, icon(isSource ? 'signal' : 'user', 'sm'), h('span', { text: roleText })),
      !info && !this.busy ? h('div.note.warn', {}, icon('warn', 'sm'), '无法探测本机角色，请手动填写服务器源地址与 Token。') : null,
      info && !info.ok && this.probed ? h('div.net-hint', { text: info.error }) : null,
      h('div.net-form', {}, ...rows),
      joinRows,
      actions,
      this.error ? h('div.net-err', { text: this.error }) : null,
      this.result ? this.#roomView(this.result) : null);
  }

  /** 房间信息：房间号 / Token / 邀请码 / 在线成员 + 可复制的邀请链接。 */
  #roomView(res) {
    const room = res.room ?? {};
    const members = Array.isArray(room.members) ? room.members : [];
    const copy = (text) => {
      navigator.clipboard?.writeText(text).catch(() => {});
    };
    const kv = (label, value) => h('div.net-kv-row', {},
      h('span', { text: label }),
      h('code', { text: String(value ?? '') }),
      h('button.btn.icon.sm', { title: '复制', onclick: () => copy(String(value ?? '')) }, icon('book', 'sm')));
    const linkInput = h('input.input.net-link', { value: res.inviteUrl, readonly: true, 'aria-label': '邀请链接' });
    forceEnglishInput(linkInput);
    return h('div.net-room',
      h('div.net-ok', {}, icon('check', 'sm'), res.created ? '房间已创建' : '已加入房间'),
      h('dl.net-kv', {},
        kv('房间号', room.id),
        kv('Token', room.token),
        kv('邀请码', room.invCode),
        kv('房主', room.owner)),
      h('div.net-members', {}, icon('user', 'sm'), h('span', { text: `在线成员（${members.length}）：${members.join('、') || '—'}` })),
      h('div.net-link-row', {}, linkInput, h('button.btn.sm', { onclick: () => copy(res.inviteUrl) }, '复制邀请链接')),
      h('div.net-hint', { text: '把邀请链接发给同学，对方在服务器源地址上打开并带 token/id/roomid/invcode 即可加入。' }));
  }
}
