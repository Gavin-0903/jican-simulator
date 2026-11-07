// 平台探测：区分「移动端 / 电脑端」以及 Windows / macOS / Linux / iOS / Android。
// 移动端会启用虚拟摇杆和右侧技能按钮（client/js/input/MobileControls.js）；
// 桌面端的交互与快捷键完全不变。网址带 ?mobile=1 / ?desktop=1 可强制指定，方便调试。

let cached = null;

const OS_LABEL = {
  ios: 'iOS / iPadOS',
  android: 'Android',
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
  chromeos: 'ChromeOS',
  other: '未知系统',
};

function readForced() {
  try {
    const params = new URLSearchParams(location.search);
    const m = params.get('mobile');
    const d = params.get('desktop');
    if (m === '1' || m === 'true') return 'mobile';
    if (d === '1' || d === 'true') return 'desktop';
    return '';
  } catch (err) {
    return '';
  }
}

function detectOS(ua, touchPoints) {
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  if (/Windows Phone|IEMobile/i.test(ua)) return 'windows';
  if (/Windows/i.test(ua)) return 'windows';
  if (/CrOS/i.test(ua)) return 'chromeos';
  if (/Macintosh|Mac OS X/i.test(ua)) {
    // iPadOS 13+ 默认发桌面版 UA（Macintosh），只能靠多点触控点数区分。
    if (touchPoints > 1) return 'ios';
    return 'macos';
  }
  if (/Linux|X11/i.test(ua)) return 'linux';
  return 'other';
}

/** 纯函数：根据 navigator / screen 推断设备。测试时也可显式传入假的 nav 对象。 */
export function detectPlatform(nav) {
  const n = nav || (typeof navigator !== 'undefined' ? navigator : {});
  const ua = String(n.userAgent || '');
  const touchPoints = Number(n.maxTouchPoints) || 0;
  let coarse = false;
  let hoverNone = false;
  try {
    if (typeof matchMedia === 'function') {
      coarse = matchMedia('(pointer: coarse)').matches;
      hoverNone = matchMedia('(hover: none)').matches;
    }
  } catch (err) {
    // 极老的浏览器没有 matchMedia：按 UA 判断即可
  }
  const os = detectOS(ua, touchPoints);
  const osLabel = OS_LABEL[os] || OS_LABEL.other;
  const uaMobile = /Android|iPhone|iPad|iPod|Mobile|Mobi|Windows Phone|webOS|BlackBerry|Opera Mini|IEMobile|Kindle|Silk/i.test(ua);
  const uadMobile = !!(n.userAgentData && n.userAgentData.mobile);
  let mobile = os === 'ios' || os === 'android' || uaMobile || uadMobile;
  const forced = readForced();
  if (forced === 'mobile') mobile = true;
  else if (forced === 'desktop') mobile = false;
  const touch = touchPoints > 0 || coarse || hoverNone;
  return {
    mobile,
    kind: mobile ? 'mobile' : 'desktop',
    kindLabel: mobile ? '移动端' : '电脑端',
    touch,
    os,
    osLabel,
    label: (mobile ? '移动端' : '电脑端') + '（' + osLabel + '）',
    forced,
    coarse,
    hoverNone,
  };
}

/** 进程内缓存：同一页面只探测一次，避免各处判断不一致。 */
export function platformInfo() {
  if (!cached) cached = detectPlatform();
  return cached;
}

/** 在 <html> 上打标记（CSS 用 .is-mobile / .is-desktop 分流），并挂到 window 便于调试。 */
export function applyPlatform() {
  const info = platformInfo();
  if (typeof document !== 'undefined' && document.documentElement) {
    const root = document.documentElement;
    root.classList.toggle('is-mobile', info.mobile);
    root.classList.toggle('is-desktop', !info.mobile);
    root.classList.toggle('is-touch', info.touch);
    root.dataset.platform = info.os;
    root.dataset.device = info.kind;
  }
  if (typeof globalThis !== 'undefined') globalThis.__JICAN_PLATFORM__ = info;
  return info;
}
