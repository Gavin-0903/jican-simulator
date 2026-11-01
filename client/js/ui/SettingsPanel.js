// 设置面板：分「联机 / 画面 / 操作」三个标签。
// 联机标签是本机联机控制台（身份密钥 / 服务器状态 / Token / TailScale 暴露方式），
// 数据全部来自服务端 /api/net/admin（失败退回 /api/net/online）。

import { h, icon, kbd } from '../util/dom.js';
import { forceEnglishInput } from '../util/ime.js';

const KEYS = [
  ['W A S D / 方向键', '移动（按住鼠标左键也可朝鼠标方向移动）'],
  ['E / 空格', '交互：进入电脑 / 与老师互动 / 老师检查电脑'],
  ['Q · F', '靠近老师时：提问 · 讨好'],
  ['V', '在自己电脑上查看积分'],
  ['J', '在他人电脑上打开 JC'],
  ['Esc', '关闭对话框 / 暂停'],
  ['Tab', '显示统计与事件记录'],
  ['+ / −', '倍速 0.5× / 1× / 2×'],
  ['M', '切换跟随镜头 / 全景'],
];

/** 道具（需求 2.1）快捷键：服务端没下发道具配置时整段隐藏。 */
const ITEM_KEYS = [
  ['B', '打开 / 关闭道具商店（购买与升级）'],
  ['1 – 5', '使用道具栏对应槽位的道具（Shift+1..5 或小键盘同样可用）'],
  ['1 · 定格手枪', '进入「选择目标」模式，点击画面里的角色后定格（Esc 取消）'],
  ['2 · 买通老师', '立即生效：老师目击你 JC 时有概率看不出'],
  ['3 · 强密码', '立即生效：别人 JC 你的电脑前要先破解锁定时间'],
  ['4 · 时间沙漏', '立即生效：除你之外全场定格（每局次数有限）'],
  ['5 · 黑客手册', '打开入侵面板，改任意角色的积分 / 工资（风险极高）'],
];

/** 三个标签页。 */
const TABS = [
  ['online', '联机', 'signal'],
  ['view', '画面', 'camera'],
  ['keys', '操作', 'keyboard'],
];

const TIMEOUT_MS = 4000;

/** 带超时的 fetch：任何失败都收敛成 { ok:false, status, error }，绝不抛。 */
async function req(url, opts = {}) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => {
    if (ctl) ctl.abort();
  }, TIMEOUT_MS);
  try {
    const r = await fetch(url, { cache: 'no-store', ...opts, ...(ctl ? { signal: ctl.signal } : {}) });
    let body = null;
    try {
      body = await r.json();
    } catch {
      body = null;
    }
    return { ok: r.ok, status: r.status, json: body };
  } catch (e) {
    const aborted = e && e.name === 'AbortError';
    return { ok: false, status: 0, json: null, error: aborted ? '' : String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

export class SettingsPanel {
  constructor(modals, store, renderer, net) {
    this.modals = modals;
    this.store = store;
    this.renderer = renderer;
    this.net = net;
    this.onlineInfo = null; // 旧的 /api/net/online 形状（兜底用）
    this.admin = null; // /api/net/admin 的 data 段
    this.adminState = 'idle'; // idle | loading | ok | fail
    this.adminError = '';
    this.tab = 'online';
    // 密钥 / Token 的可见状态。完整值只放内存，绝不写 console、不写 URL。
    this.idKeyShown = false;
    this.idKeyFull = '';
    this.tokenShown = false;
    this.tokenFull = '';
    this.hasRegen = true; // 接口 404 时置 false → 隐藏「重新生成」
    this.hasTokenApi = true; // /api/net/admin/token 404/501 时置 false → 提示版本不支持
    this.switchError = '';
    this.busy = ''; // '' | 'mode:tailnet' | 'mode:funnel' | 'mode:off' | 'regen'
    this.roomsOpen = false;
    this.copied = '';
    this.copyTimer = null;
    this.onClose = null;
  }

  // ------------------------------------------------------------------ 数据

  /** 拉一次 /api/net/online（老接口，作兜底）。 */
  async probeOnline() {
    const r = await req('/api/net/online');
    this.onlineInfo = r.ok ? ((r.json && r.json.online) || null) : null;
    return this.onlineInfo;
  }

  /**
   * 拉联机控制台数据：主用 /api/net/admin，失败退回 /api/net/online。
   * 两个都失败 → adminState='fail'，界面显示「无法读取本机联机信息」+ 重试按钮。
   */
  async loadAdmin() {
    if (this.adminState === 'loading') return;
    this.adminState = 'loading';
    this.adminError = '';
    const r = await req('/api/net/admin');
    const j = r.json;
    // 服务端（server/net/LobbyHttp.js:275）是 { ok:true, ...sanitizeAdmin(info) }，没有 data 包装；
    // 但为了兼容别的实现，data 段存在时优先取 data。
    let data = r.ok && j && j.ok !== false ? (j.data || j) : null;
    if (data && data.ok !== undefined) {
      const { ok: _ok, ...rest } = data;
      data = rest;
    }
    if (!data) {
      // 退回老接口：{ ok, online:{enabled,mode,serverUrl,port,hasToken} } 包成 admin 形状
      const old = await req('/api/net/online');
      const o = old.ok && old.json ? old.json.online : null;
      if (o) {
        data = {
          idKey: null,
          online: {
            enabled: Boolean(o.enabled),
            mode: o.mode || 'serve',
            serverUrl: o.serverUrl || '',
            port: o.port == null ? null : o.port,
            hasToken: Boolean(o.hasToken),
            tokenMasked: '',
            tokenLength: null,
          },
          tailscale: null,
          rooms: null,
          drift: [],
          degraded: true,
        };
      } else {
        this.adminState = 'fail';
        this.admin = null;
        this.adminError = (r.json && r.json.error) || r.error || (r.status ? 'HTTP ' + r.status : '网络不可用');
        return;
      }
    }
    if (typeof data.idKey === 'string') data.idKey = { hint: data.idKey, full: data.idKey };
    this.admin = data;
    this.adminState = 'ok';
  }

  /** 切换暴露方式：tailnet(serve) / funnel / off。失败把服务端 error 原样显示。 */
  async switchMode(mode) {
    if (this.busy) return;
    this.busy = 'mode:' + mode;
    this.switchError = '';
    this.rerender();
    const r = await req('/api/net/online/mode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    if (!(r.ok && r.json && r.json.ok !== false)) {
      this.switchError = (r.json && r.json.error) || r.error || ('切换失败（HTTP ' + r.status + '）');
    }
    this.busy = '';
    this.adminState = 'idle';
    await this.loadAdmin();
    this.rerender();
  }

  /** 重新生成联机 Token（404 / 501 = 服务端没这接口 → 隐藏按钮，不报错）。 */
  async regenerateToken() {
    if (this.busy) return;
    this.busy = 'regen';
    this.rerender();
    const r = await req('/api/net/token/regenerate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    if (r.status === 404 || r.status === 501) {
      this.hasRegen = false;
    } else if (!(r.ok && r.json && r.json.ok !== false)) {
      this.switchError = (r.json && r.json.error) || r.error || ('重新生成失败（HTTP ' + r.status + '）');
    } else {
      this.tokenShown = false;
      this.tokenFull = '';
    }
    this.busy = '';
    this.adminState = 'idle';
    await this.loadAdmin();
    this.rerender();
  }

  /** 完整 ID 密钥：只在展开时从 /api/net/info 取一次（/api/net/admin 只给 hint）。 */
  async fetchIdKey() {
    if (this.idKeyFull) return this.idKeyFull;
    const r = await req('/api/net/info');
    const j = r.ok && r.json && r.json.ok !== false ? r.json : null;
    if (j && typeof j.idKey === 'string' && j.idKey) this.idKeyFull = j.idKey;
    return this.idKeyFull;
  }

  /** 「显示完整」ID 密钥（本机可见即可，不需要二次确认；Token 才需要）。 */
  async toggleIdKey() {
    if (this.idKeyShown) {
      this.idKeyShown = false;
      return this.rerender();
    }
    if (!this.idKeyFull) await this.fetchIdKey();
    this.idKeyShown = !!this.idKeyFull;
    if (!this.idKeyFull) this.switchError = '服务端没有返回完整 ID 密钥（/api/net/info 的 idKey 为空）';
    this.rerender();
  }

  /** 完整 Token 只在「显示」时从服务端取一次（不在 URL 里、不进 console）。 */
  async fetchToken() {
    const r = await req('/api/net/admin/token');
    const j = r.ok && r.json && r.json.ok !== false ? r.json : null;
    if (r.status === 404 || r.status === 501) this.hasTokenApi = false;
    this.tokenFull = j && j.token ? String(j.token) : '';
    if (!this.tokenFull) {
      this.switchError = (j && j.error) || (r.status === 404 || r.status === 501
        ? '当前服务端版本不支持查看完整 Token（缺少 /api/net/admin/token）'
        : '服务端没有返回完整 Token');
    }
    return this.tokenFull;
  }

  /** 「显示完整 Token」必须二次确认（用户要求：能看，但每次展开都要确认）。 */
  async toggleToken() {
    if (this.tokenShown) {
      this.tokenShown = false;
      return this.rerender();
    }
    const ok = await this.modals.confirm({
      title: '显示完整 Token？',
      text: 'Token 相当于房间口令：看到的人都能加入你的房间。确认本机屏幕只有你自己可见再继续。',
      ok: '显示',
      tone: 'warn',
      iconName: 'shield',
    });
    if (!ok) {
      // confirm 会关掉设置弹窗，取消后重新打开并停在联机标签
      if (this.modals.kind !== 'settings') this.show(this.onClose);
      return;
    }
    if (this.modals.kind !== 'settings') this.show(this.onClose);
    if (!this.tokenFull) await this.fetchToken();
    this.tokenShown = !!this.tokenFull;
    this.rerender();
  }

  /** 复制（只走按钮点击：项目全局拦了 Ctrl+C/Ctrl+V）。 */
  async copyText(text, key) {
    let done = false;
    try {
      await navigator.clipboard.writeText(text);
      done = true;
    } catch {
      try {
        const ta = h('textarea', { value: text, readonly: true });
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        ta.style.opacity = '0';
        document.body.append(ta);
        ta.select();
        done = document.execCommand('copy');
        ta.remove();
      } catch {
        done = false;
      }
    }
    this.copied = done ? key : '';
    if (!done) return;
    clearTimeout(this.copyTimer);
    this.copyTimer = setTimeout(() => {
      this.copied = '';
      this.rerender();
    }, 1500);
    this.rerender();
  }

  rerender() {
    if (this.modals.kind === 'settings') this.modals.setBody('settings', this.buildBody());
  }

  async fixDrift(x) {
    const action = x && (x.action || x.fix);
    if (!action) return;
    if (typeof action === 'string' && ['serve', 'tailnet', 'funnel', 'off'].includes(action)) return this.switchMode(action);
    if (action.type === 'mode') return this.switchMode(String(action.mode || 'tailnet'));
    const r = await req(String(action.url || action.path || ''), {
      method: String(action.method || 'POST'),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(action.body || {}),
    });
    if (!(r.ok && r.json && r.json.ok !== false)) {
      this.switchError = (r.json && r.json.error) || r.error || '修复失败';
    }
    this.adminState = 'idle';
    await this.loadAdmin();
    this.rerender();
  }

  // ------------------------------------------------------------------ 渲染

  /** 折叠/展开的密钥块（ID 密钥、Token 共用）。 */
  secretBlock(o) {
    const full = String(o.full || '');
    const shown = o.shown && !!full;
    const copyBtn = shown
      ? h('button.btn.sm', { onclick: () => this.copyText(full, o.keyName) }, this.copied === o.keyName ? '已复制 ✓' : '复制')
      : null;
    const extra = (o.extraButtons || []).filter(Boolean);
    return h('div.settings-block', {},
      h('div.settings-block-head', {},
        icon(o.iconName, 'sm'),
        h('span.settings-block-title', { text: o.title }),
        h('span.spacer'),
        ...extra,
        copyBtn,
        h('button.btn.sm', {
          'aria-expanded': String(shown),
          'aria-controls': 'settings-secret-' + o.keyName,
          onclick: (e) => {
            e.preventDefault();
            o.onToggle();
          },
        }, shown ? '隐藏' : (o.canShow === false ? '无数据' : '显示完整'))),
      h('div.fine', { text: o.hint }),
      shown
        ? h('div.settings-secret', { id: 'settings-secret-' + o.keyName },
            h('code.settings-mono.settings-secret-value', { text: full }))
        : h('div.settings-secret.settings-secret-mask', { id: 'settings-secret-' + o.keyName, text: o.masked }),
      shown ? h('div.fine', { text: '可拖选或点「复制」（游戏内已禁用 Ctrl+C，请用按钮）。完整值只显示在这一处，不会写日志或地址栏。' }) : null,
      o.note || null);
  }

  tabBar() {
    return h('div.segmented.settings-tabs', { role: 'group', 'aria-label': '设置分类' },
      ...TABS.map(([id, label, ic]) => h('button', {
        'aria-pressed': String(this.tab === id),
        onclick: () => {
          if (this.tab === id) return;
          this.tab = id;
          this.rerender();
        },
      }, icon(ic, 'sm'), label)));
  }

  onlineTab() {
    const out = [];
    // 统一错误展示
    if (this.switchError) out.push(h('div.note.danger', {}, icon('warn', 'sm'), h('span', { text: this.switchError })));
    if (this.adminState === 'fail') {
      out.push(h('div.note.warn', {},
        icon('warn', 'sm'),
        h('div', {}, h('div', { text: '无法读取本机联机信息' }),
          this.adminError ? h('div.fine', { text: this.adminError }) : null),
        h('button.btn.sm', { onclick: () => { this.adminState = 'idle'; this.loadAdmin().then(() => this.rerender()); } }, icon('refresh', 'sm'), '重试')));
      return out;
    }
    if (this.adminState !== 'ok' || !this.admin) {
      out.push(h('div.note', {}, icon('signal', 'sm'), '正在读取本机联机信息…',
        h('button.btn.sm', { onclick: () => { this.adminState = 'idle'; this.loadAdmin().then(() => this.rerender()); } }, icon('refresh', 'sm'), '刷新')));
      return out;
    }
    const d = this.admin;
    const drift = this.driftBar(d);
    if (drift) out.push(drift);
    out.push(this.idKeyBlock(d));
    out.push(this.serverBlock(d));
    out.push(this.tokenBlock(d));
    out.push(this.tailscaleBlock(d));
    out.push(h('div.settings-actions', {},
      h('button.btn.sm', { onclick: () => { this.adminState = 'idle'; this.loadAdmin().then(() => this.rerender()); } }, icon('refresh', 'sm'), '刷新状态'),
      h('span.fine.settings-stamp', { text: d.degraded ? '数据来源：/api/net/online（/api/net/admin 不可用，信息较少）' : '数据来源：/api/net/admin' })));
    return out;
  }

  idKeyBlock(d) {
    const idk = d.idKey || {};
    // /api/net/admin 出于脱敏只给 hint/length/file；完整 256 位密钥只有 /api/net/info 给（联机加入必需）。
    // 这里用 this.idKeyFull 缓存：初次渲染后异步补一次，不阻塞首屏。
    const full = String(idk.full || this.idKeyFull || '');
    const hint = String(idk.hint || (full ? full.slice(0, 8) + '…' : ''));
    // 密钥来源路径：服务端只给 idKey.file（绝对路径）；老接口只给 dataDir，按 data/id.key 拼。
    let path = idk.file || idk.path || (d.dataDir ? String(d.dataDir).replace(/[\\/]+$/, '') + '/id.key' : '');
    const len = idk.length != null ? idk.length : (full ? full.length : null);
    if (!hint && !full) {
      return h('div.settings-block', {},
        h('div.settings-block-head', {}, icon('shield', 'sm'), h('span.settings-block-title', { text: 'ID 密钥' })),
        h('div.note.warn', {}, icon('warn', 'sm'), '服务端没有返回 ID 密钥（/api/net/admin 的 idKey 为空）。'));
    }
    // 展开后多出来的两项：来源路径 + 长度（lead 明确要求公示密钥来源路径）
    const note = h('dl.kv.settings-kv.settings-sub',
      h('dt', { text: '来源路径' }), h('dd', {}, h('code.settings-mono', { text: path || '（服务端未给出路径，默认 data/id.key）' })),
      h('dt', { text: '长度' }), h('dd', { text: len != null ? len + ' 字符（256 位十六进制）' : '（展开后显示）' }));
    return this.secretBlock({
      iconName: 'shield',
      title: 'ID 密钥',
      hint: '本机联机身份凭证，只对你自己可见，不要发给别人。',
      masked: hint || '—',
      full,
      shown: this.idKeyShown && !!full,
      keyName: 'idkey',
      onToggle: () => this.toggleIdKey(),
      note,
    });
  }

  serverBlock(d) {
    const o = d.online || {};
    const on = Boolean(o.enabled);
    const port = o.port == null ? null : o.port;
    // 「本机联机服务器」的实时事实：d.port 是本进程真正监听的端口（/api/net/admin 里 server 侧实测），
    // o.port 是配置里想暴露的端口。两者都在 realtime 一栏里回显，前端不做任何推测。
    const listenPort = d.port != null ? d.port : port;
    const addr = o.listen || o.listenAddr || o.address || (listenPort != null ? '127.0.0.1:' + listenPort : '');
    const pageUrl = (typeof location !== 'undefined' && location.host ? location.host : '') === '' ? '' : 'http://' + location.host + '/';
    const rooms = d.rooms;
    const count = rooms && typeof rooms === 'object' ? Number(rooms.count || 0) : Number(rooms || 0);
    const list = rooms && typeof rooms === 'object' && Array.isArray(rooms.list) ? rooms.list : [];
    const portSeg = h('div.segmented', {},
      h('button', { 'aria-pressed': String(port === 5199), onclick: () => this.switchPort(5199) }, '5199（本页）'),
      h('button', { 'aria-pressed': String(port === 5173), onclick: () => this.switchPort(5173) }, '5173（默认）'));
    return h('div.settings-block', {},
      h('div.settings-block-head', {},
        icon('signal', 'sm'),
        h('span.settings-block-title', { text: '本机联机服务器' }),
        h('span.spacer'),
        h('span.badge-llm' + (on ? '.on' : '.degraded'), {}, h('span.dot')),
        h('span.settings-status-' + (on ? 'on' : 'off'), { text: on ? '已启动' : '未启动' }),
        h('button.btn.sm', { onclick: () => { this.adminState = 'idle'; this.loadAdmin().then(() => this.rerender()); } }, icon('refresh', 'sm'), '刷新')),
      h('dl.kv.settings-kv',
        h('dt', { text: '本页地址' }), h('dd', {}, h('code.settings-mono', { text: pageUrl || '—' }),
          h('span.fine', { text: on ? '（联机服务器已在跑，本页就是它）' : '' })),
        h('dt', { text: '监听地址' }), h('dd', {}, h('code.settings-mono', { text: addr || '—' })),
        h('dt', { text: '对外地址' }), h('dd', {}, h('code.settings-mono', { text: o.serverUrl || '（没有对外地址：TailScale 未暴露）' })),
        h('dt', { text: '数据目录' }), h('dd', {}, h('code.settings-mono', { text: d.dataDir || '—' })),
        h('dt', { text: '房间数' }), h('dd', {},
          h('button.btn.sm.settings-link', {
            'aria-expanded': String(this.roomsOpen),
            onclick: () => {
              this.roomsOpen = !this.roomsOpen;
              this.rerender();
            },
          }, String(Number.isFinite(count) ? count : '—') + ' 间' + (list.length ? (this.roomsOpen ? ' ▾' : ' ▸') : ''))),
        h('dt', { text: '监听端口' }), h('dd', {}, portSeg)),
      this.roomsOpen && list.length
        ? h('table.settings-rooms',
            h('thead', {}, h('tr', {}, h('th', { text: '房间号' }), h('th', { text: '人数' }), h('th', { text: '创建时间' }))),
            h('tbody', {}, ...list.map((r) => h('tr', {},
              h('td', {}, h('code.settings-mono', { text: String(r.id || r.roomId || '—') })),
              h('td', { text: String(r.members != null ? r.members : (r.count != null ? r.count : '—')) }),
              h('td', { text: r.createdAt != null ? String(r.createdAt) : '—' })))))
        : null,
      this.roomsOpen && !list.length
        ? h('div.fine', { text: '当前没有房间。' })
        : null,
      h('div.settings-actions', {},
        !on
          ? h('button.btn.primary.sm', {
              disabled: !!this.busy,
              onclick: () => this.switchMode('tailnet'),
            }, icon('bolt', 'sm'), this.busy === 'mode:tailnet' ? '启动中…' : '开启联机（--启动服务器源）')
          : null,
        h('button.btn.sm', {
          disabled: !!this.busy,
          onclick: () => this.restartServer(),
        }, icon('refresh', 'sm'), this.busy === 'restart' ? '重启中…' : '重启服务器')),
      h('div.fine', { text: '这些都是这次打开设置页时向本机服务端实时问的（/api/net/admin + tailscale status + 进程内监听端口），不是前端猜的。' }));
  }

  tokenBlock(d) {
    const o = d.online || {};
    const masked = String(o.tokenMasked || (o.hasToken ? '已生成（点「显示完整」查看）' : ''));
    const len = o.tokenLength != null ? o.tokenLength : (o.tokenLen != null ? o.tokenLen : null);
    const regen = this.hasRegen
      ? h('button.btn.sm', { disabled: !!this.busy, onclick: () => this.askRegen() }, icon('refresh', 'sm'), this.busy === 'regen' ? '生成中…' : (o.hasToken ? '重新生成' : '生成'))
      : null;
    if (!masked && !o.hasToken) {
      // 空态也要能操作：直接给「生成」按钮，否则这一块永远是死信息。
      return h('div.settings-block', {},
        h('div.settings-block-head', {},
          icon('shield', 'sm'),
          h('span.settings-block-title', { text: '联机 Token' }),
          h('span.spacer'),
          this.busy === 'regen' ? h('span.fine', { text: '生成中…' }) : regen),
        h('div.note.warn', {}, icon('warn', 'sm'), '还没有联机 Token。点右上「生成」，或用 TailScale 模式切一次也可自动生成。'),
        h('div.fine', { text: 'Token 是加入房间用的口令：本机当服务器源时，同学要凭它加入你的房间。' }));
    }
    return this.secretBlock({
      iconName: 'shield',
      title: '联机 Token',
      hint: 'Token 是加入房间用的口令，发给同学即可。每次展开都要确认一次。',
      masked: /共 ?\d+ ?位/.test(masked) || len == null ? masked : masked + '（共 ' + len + ' 位）',
      full: this.tokenFull,
      shown: this.tokenShown && !!this.tokenFull,
      keyName: 'token',
      extraButtons: [regen],
      onToggle: () => this.toggleToken(),
      note: h('div.fine', { text: '完整 Token 只在点「显示完整」并经确认后向服务端取一次；不会写进日志与地址栏。' }),
    });
  }

  tailscaleBlock(d) {
    const t = d.tailscale;
    const o = d.online || {};
    if (!t) {
      return h('div.settings-block', {},
        h('div.settings-block-head', {}, icon('signal', 'sm'), h('span.settings-block-title', { text: 'TailScale' })),
        h('div.note.warn', {}, icon('warn', 'sm'), '服务端没有返回 TailScale 状态（/api/net/admin 的 tailscale 为空）。'));
    }
    const installed = t.installed !== false;
    const cap = t.funnelCapable !== false;
    const mode = String(o.mode || 'off');
    const isServing = mode === 'tailnet' || mode === 'serve';
    const busyMode = this.busy.startsWith('mode:') ? this.busy.slice(5) : '';
    const seg = h('div.segmented.settings-modes', { role: 'group', 'aria-label': 'TailScale 暴露方式' },
      h('button', {
        'aria-pressed': String(isServing),
        disabled: !installed || !!this.busy,
        onclick: () => this.switchMode('tailnet'),
      }, busyMode === 'tailnet' ? '切换中…' : 'Serve（tailnet 内）'),
      h('button', {
        'aria-pressed': String(mode === 'funnel'),
        disabled: !installed || !cap || !!this.busy,
        title: cap ? '' : (t.funnelReason || '当前环境不支持 Funnel'),
        onclick: () => this.switchMode('funnel'),
      }, busyMode === 'funnel' ? '切换中…' : 'Funnel（公网）'),
      h('button', {
        'aria-pressed': String(mode === 'off'),
        disabled: !installed || !!this.busy,
        onclick: () => this.switchMode('off'),
      }, busyMode === 'off' ? '切换中…' : '关闭'));
    const reasons = [];
    if (!cap) {
      reasons.push('不支持 Funnel');
      reasons.push('需要 https 证书 / 已登录的 tailnet');
      if (Array.isArray(t.funnelPorts) && t.funnelPorts.length) reasons.push('端口需在允许列表（' + t.funnelPorts.join(' / ') + '）内');
    }
    return h('div.settings-block', {},
      h('div.settings-block-head', {},
        icon('signal', 'sm'),
        h('span.settings-block-title', { text: 'TailScale' }),
        h('span.spacer'),
        h('span.badge-llm' + (installed ? '.on' : '.degraded'), {}, h('span.dot')),
        h('span', { text: installed ? '已安装' : '未安装' })),
      h('dl.kv.settings-kv',
        h('dt', { text: '版本' }), h('dd', {}, h('code.settings-mono', { text: t.version || (installed ? '未知' : '—') })),
        h('dt', { text: '桌面服务' }), h('dd', { text: t.running === true ? '运行中' : t.running === false ? '未运行' : '未知' }),
        h('dt', { text: '登录状态' }), h('dd', { text: t.backendState || (t.loggedIn ? 'Running' : '未登录') }),
        h('dt', { text: '节点名' }), h('dd', {}, h('code.settings-mono', { text: t.dnsName || t.hostname || '—' })),
        h('dt', { text: 'MagicDNS' }), h('dd', {}, h('code.settings-mono', { text: t.url || (t.dnsName ? 'https://' + t.dnsName : '—') }))),
      seg,
      !cap ? h('div.note.warn', {}, icon('warn', 'sm'),
        h('div', {}, h('div', { text: 'Funnel 不可用，已禁用：' }),
          h('ul.settings-reasons', {}, ...reasons.map((x) => h('li', { text: x }))))) : null,
      Array.isArray(t.funnelPorts) && t.funnelPorts.length && cap
        ? h('div.fine', { text: 'Funnel 允许端口：' + t.funnelPorts.join('、') })
        : null,
      h('div.fine', { text: 'Serve：只有同一 tailnet 的设备能访问；Funnel：公网可访问；关闭：撤销 serve/funnel 规则。' }));
  }

  driftBar(d) {
    const drift = Array.isArray(d.drift) ? d.drift : [];
    if (!drift.length) return null;
    return h('div.settings-drift', {},
      h('div.settings-drift-head', {}, icon('warn', 'sm'), h('b', { text: '配置漂移（' + drift.length + '）' })),
      ...drift.map((x) => h('div.settings-drift-row',
        h('div.settings-drift-text',
          h('b', { text: String(x.label || x.code || '配置不一致') }),
          x.detail ? h('div.fine', { text: String(x.detail) }) : null),
        h('button.btn.sm', { disabled: !!this.busy, onclick: () => this.fixDrift(x) }, '一键修复'))));
  }

  switchPort(port) {
    this.busy = 'port';
    this.rerender();
    req('/api/net/admin/port', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
    }).then((r) => {
      if (!(r.ok && r.json && r.json.ok !== false)) {
        this.switchError = (r.json && r.json.error) || r.error || ('切换端口失败（HTTP ' + r.status + '）');
      } else if (r.json && r.json.reloadPort) {
        // 切到别的端口后本页连不上新实例：提示用手动打开
        this.switchError = '已改到 ' + port + '：请打开 http://127.0.0.1:' + port + '/';
      }
      this.busy = '';
      this.adminState = 'idle';
      return this.loadAdmin();
    }).then(() => this.rerender());
  }

  restartServer() {
    this.busy = 'restart';
    this.rerender();
    req('/api/net/admin/restart', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => {
      if (!(r.ok && r.json && r.json.ok !== false)) {
        this.switchError = (r.json && r.json.error) || r.error || ('重启失败（HTTP ' + r.status + '）');
      }
      this.busy = '';
      this.adminState = 'idle';
      return this.loadAdmin();
    }).then(() => this.rerender());
  }

  async askRegen() {
    const ok = await this.modals.confirm({
      title: '重新生成 Token？',
      text: '旧 Token 立刻失效，已经用老口令加入的房间需要重新要口令。',
      ok: '重新生成',
      tone: 'warn',
      iconName: 'shield',
    });
    if (this.modals.kind !== 'settings') this.show(this.onClose);
    if (ok) await this.regenerateToken();
  }

  viewTab(ctx) {
    const { camSeg, coneSeg, llm, on } = ctx;
    return [
      h('div.note', {}, h('span.badge-llm' + (on ? '.on' : '.degraded'), {}, h('span.dot')),
        h('span', { text: on ? 'AI 增强：已启用（本地模型生成台词与性格倾向）' : 'AI 增强：已降级为纯规则 AI' + (llm && llm.reason ? '（' + llm.reason + '）' : '') })),
      h('div.kv',
        h('dt', { text: '镜头' }), h('dd', {}, camSeg),
        h('dt', { text: '老师视野扇形' }), h('dd', {}, coneSeg),
        h('dt', { text: '网络延迟' }), h('dd', { text: this.net && this.net.latency != null ? this.net.latency + ' ms' : '—' }),
        h('dt', { text: '随机种子' }), h('dd', { text: String((this.store.game && this.store.game.seed) != null ? this.store.game.seed : '—') })),
    ];
  }

  keysTab(ctx) {
    const { hasItems } = ctx;
    return [
      h('div.section-title', {}, icon('keyboard', 'sm'), '快捷键'),
      h('dl.kv', {}, ...KEYS.flatMap(([k, v]) => [h('dt', {}, kbd(k)), h('dd', { text: v })])),
      hasItems ? h('div.section-title', {}, icon('bolt', 'sm'), '道具快捷键') : null,
      hasItems ? h('dl.kv', {}, ...ITEM_KEYS.flatMap(([k, v]) => [h('dt', {}, kbd(k)), h('dd', { text: v })])) : null,
      hasItems ? h('div.note', {}, icon('coin', 'sm'), '道具全部由服务端裁定：价格、升级与使用效果以对局内实际扣除为准。') : null,
      h('div.section-title', {}, icon('signal', 'sm'), '输入控制'),
      h('dl.kv',
        h('dt', {}, kbd('Ctrl+C / V')), h('dd', { text: '已禁用：复制、粘贴、剪切、全选在游戏内一律拦截（设置页的「复制」按钮不受影响）' }),
        h('dt', {}, kbd('输入法')), h('dd', { text: '所有输入框强制英文键盘（ime-mode: disabled），直接键入即可' }),
        h('dt', {}, kbd('联机')), h('dd', { text: '大厅顶部可切到「联机」：本机是服务器源时自动使用本机地址，否则填写服务器源 URL 与 Token' })),
    ];
  }

  buildBody() {
    const ctx = this.ctx();
    return [this.tabBar(), ...(this.tab === 'online' ? this.onlineTab() : this.tab === 'view' ? this.viewTab(ctx) : this.keysTab(ctx))];
  }

  ctx() {
    const llm = (this.store.game && this.store.game.llm) || (this.store.lobby && this.store.lobby.llm);
    const hasItems = !!(this.store.lobby && this.store.lobby.rules && this.store.lobby.rules.items);
    const on = !!(llm && llm.mode === 'llm');
    const camSeg = h('div.segmented', {},
      ...[['follow', '跟随'], ['overview', '全景']].map(([v, label]) => h('button', {
        'aria-pressed': String(this.renderer.cameraMode === v),
        onclick: () => {
          this.renderer.setCameraMode(v);
          this.rerender();
        },
      }, label)));
    const coneSeg = h('div.segmented', {},
      ...[[true, '显示'], [false, '隐藏']].map(([v, label]) => h('button', {
        'aria-pressed': String(this.renderer.showCones === v),
        onclick: () => {
          this.renderer.showCones = v;
          this.rerender();
        },
      }, label)));
    return { llm, hasItems, on, camSeg, coneSeg };
  }

  show(onClose) {
    // onClose 只在用户点「完成」时调用（它负责还原暂停/焦点）；内部重绘绝不能带它。
    this.onClose = onClose;
    if (this.adminState !== 'ok') {
      this.adminState = 'idle';
      this.loadAdmin().then(() => this.rerender());
    }
    this.modals.open('settings', {
      title: '设置',
      icon: 'settings',
      onDismiss: onClose,
      body: this.buildBody(),
      foot: [h('button.btn.primary', { onclick: () => {
        this.modals.close();
        if (onClose) onClose();
      } }, '完成')],
    });
    // ModalHost 不支持传类名：设置页信息多，打开后把弹窗加宽（只作用于当前这一个 .modal）
    const card = this.modals.current && this.modals.current.card;
    if (card) card.classList.add('settings-wide');
  }
}
