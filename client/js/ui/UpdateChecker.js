// 自动更新（前端）：开局问一句「要不要更新」，同意后显示下载进度，下完自动拉起安装程序。
// 服务端负责真正的下载与安装（/api/update/*，只对本机开放），这里只做交互。
import { h } from '../util/dom.js';

const DISMISS_KEY = 'jican.update.dismissed';
const CHECKED_KEY = 'jican.update.checkedAt';
const CHECK_TTL_MS = 10 * 60_000;

const readSession = (key) => {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
};
const writeSession = (key, value) => {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* 隐私模式：忽略 */
  }
};

const json = async (url) => {
  const res = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
};

const progressBar = (percent) => {
  const inner = h('div', {
    style: 'height:100%;width:' + (percent ?? 0) + '%;border-radius:999px;background:linear-gradient(90deg,#4ea1ff,#7bd0ff);transition:width .25s ease',
  });
  const outer = h('div', {
    style: 'height:8px;border-radius:999px;background:rgba(255,255,255,.12);overflow:hidden;margin:10px 0 6px',
  }, inner);
  return { outer, inner };
};

const fmtSize = (n) => {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
  if (v >= 1024) return (v / 1024).toFixed(0) + ' KB';
  return v + ' B';
};

/**
 * @param {{modals: import('./Modal.js').ModalHost, toast: import('./Toast.js').Toast, force?: boolean}} opts
 */
export async function checkForUpdates({ modals, toast, force = false }) {
  let info;
  try {
    info = await json('/api/update/check' + (force ? '?force=1' : ''));
  } catch {
    return; // 检查更新失败就静默——开局弹一个"连不上更新服务器"的框只会烦人
  }
  if (!info || !info.enabled) return;
  writeSession(CHECKED_KEY, String(Date.now()));
  if (!info.updateAvailable) return;
  if (!force && readSession(DISMISS_KEY) === String(info.remoteVersion)) return;

  const notes = Array.isArray(info.notes) ? info.notes : [];
  const body = [
    h('div.summary-text', {}, [
      h('div', { text: '当前版本：v' + (info.localVersion || '未知') }),
      h('div', { text: '最新版本：' + (info.remoteVersion || '未知') + (info.releasedAt ? '（' + info.releasedAt + '）' : '') }),
      info.headline ? h('div', { text: info.headline }) : null,
    ].filter(Boolean)),
    notes.length ? h('ul.update-notes', { style: 'margin:10px 0 0;padding-left:20px;line-height:1.7' }, ...notes.map((n) => h('li', { text: String(n) }))) : null,
  ];

  const dismiss = () => {
    writeSession(DISMISS_KEY, String(info.remoteVersion));
    modals.close();
  };

  let started = false;
  const start = async () => {
    if (started) return;
    started = true;
    try {
      await json('/api/update/download');
    } catch {
      /* 起不来就让轮询去报错 */
    }
    showProgress();
  };

  const retry = () => {
    started = true;
    void start();
  };

  modals.open('update', {
    title: '发现新版本 ' + (info.remoteVersion || ''),
    sub: '要现在更新吗？',
    icon: 'download',
    tone: 'gold',
    wide: true,
    body,
    dismissable: true,
    onDismiss: () => writeSession(DISMISS_KEY, String(info.remoteVersion)),
    foot: [
      h('button.btn.ghost', { onclick: dismiss, text: '稍后再说' }),
      h('button.btn.primary', { onclick: () => void start(), text: '立即更新' }),
    ],
  });

  async function showProgress() {
    const pct = h('div', { text: '0%' });
    const line = h('div.summary-text', { text: '正在下载安装包…' });
    const bar = progressBar(0);
    modals.open('update', {
      title: '正在更新到 ' + (info.remoteVersion || ''),
      sub: '下载完成后会自动打开安装程序',
      icon: 'download',
      tone: 'info',
      wide: true,
      dismissable: false,
      body: [line, bar.outer, pct],
      foot: [],
    });
    let stopped = false;
    const stop = () => {
      stopped = true;
    };
    // 服务端退出（开始安装）后接口会连不上，最多再轮询几轮就收手
    let failures = 0;
    const tick = async () => {
      if (stopped) return;
      let st;
      try {
        st = await json('/api/update/status');
        failures = 0;
      } catch (err) {
        failures += 1;
        if (failures >= 10) {
          stop();
          return;
        }
        setTimeout(tick, 800);
        return;
      }
      if (stopped) return;
      const phase = st && st.phase;
      if (phase === 'error') {
        line.textContent = (st && st.error) || '下载失败';
        pct.textContent = '';
        modals.setBody('update', [
          line,
          h('div', { style: 'margin-top:12px' }, h('button.btn.primary', { onclick: retry, text: '重试' })),
        ]);
        stop();
        return;
      }
      const percent = typeof st.percent === 'number' ? st.percent : null;
      bar.inner.style.width = (percent ?? 0) + '%';
      pct.textContent =
        (percent === null ? fmtSize(st.received) : percent + '%') +
        (st.total ? ' / ' + fmtSize(st.total) : '') +
        (st.speed ? ' · ' + st.speed + ' KB/s' : '');
      if (phase === 'ready') {
        stop();
        line.textContent = '下载完成，正在启动安装程序…';
        pct.textContent = '';
        try {
          await json('/api/update/install');
        } catch (err) {
          line.textContent = '启动安装程序失败：' + (err && err.message ? err.message : err);
          return;
        }
        modals.open('update', {
          title: '正在启动安装程序',
          sub: '游戏即将自动退出，请按安装向导完成更新',
          icon: 'download',
          tone: 'ok',
          dismissable: false,
          body: [h('div.summary-text', { text: '安装程序打开后，游戏会自动关闭。安装完成后再从桌面/开始菜单启动即可。' })],
          foot: [],
        });
        return;
      }
      setTimeout(tick, 800);
    };
    setTimeout(tick, 600);
  }
}
