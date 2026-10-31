// 前端引导：拉取地图 → 初始化渲染器与 UI → 连接服务端 → 启动渲染循环。

import { ACTION, MSG, PHASE, SPEEDS } from '/shared/constants.js';
import { GameStore } from './store/GameStore.js';
import { NetClient } from './net/NetClient.js';
import { SvgRenderer } from './render/SvgRenderer.js';
import { InputManager } from './input/InputManager.js';
import { hydrateIcons } from './util/dom.js';
import { ModalHost } from './ui/Modal.js';
import { Toast } from './ui/Toast.js';
import { HudPanel } from './ui/HudPanel.js';
import { Lobby } from './ui/Lobby.js';
import { PcDialog } from './ui/PcDialog.js';
import { JcDialog } from './ui/JcDialog.js';
import { ScoreDialog } from './ui/ScoreDialog.js';
import { TeacherMenu } from './ui/TeacherMenu.js';
import { GameOverPanel } from './ui/GameOverPanel.js';
import { PausePanel } from './ui/PausePanel.js';
import { SettingsPanel } from './ui/SettingsPanel.js';
import { StatsPanel } from './ui/StatsPanel.js';
import { ItemShop } from './ui/ItemShop.js';
import { ItemBar } from './ui/ItemBar.js';
import { HackPanel } from './ui/HackPanel.js';
import { NetPanel } from './ui/NetPanel.js';
import { ITEM_META, itemConfig, canUseSlot, hourglassLimit } from './ui/items.js';
import { installInputGuards } from './util/ime.js';

const $ = (id) => document.getElementById(id);
// 这些弹窗都属于「正在用电脑」，暂停时不应该被暂停面板顶掉
const PC_MODALS = new Set(['pc', 'score', 'jc']);

async function boot() {
  installInputGuards(); // 需求 1.1：全局禁复制/粘贴/剪切 + 输入框强制英文（幂等）
  hydrateIcons();
  const store = new GameStore();
  const net = new NetClient(store);
  store.map = await (await fetch('/api/map')).json();
  const renderer = new SvgRenderer($('map'), store);
  await renderer.init(store.map);

  const modals = new ModalHost($('modal-root'));
  const toast = new Toast($('toasts'));
  const leavePc = () => {
    modals.close();
    net.action(ACTION.LEAVE_PC);
  };
  const pcDialog = new PcDialog(modals, net, leavePc);
  const backToPc = () => (pcDialog.last ? pcDialog.show(pcDialog.last) : leavePc());
  const jcDialog = new JcDialog(modals, net, backToPc);
  const scoreDialog = new ScoreDialog(modals, backToPc, leavePc);
  const teacherMenu = new TeacherMenu($('teacher-menu'), store, net);
  const stats = new StatsPanel($('stats-panel'), store);
  const netPanel = new NetPanel(store);
  const lobby = new Lobby($('lobby'), store, net, netPanel);
  const settings = new SettingsPanel(modals, store, renderer, net);
  let replayCharId = null;
  const gameover = new GameOverPanel(modals, store, {
    onLobby: () => net.send(MSG.LOBBY),
    onReplay: (id) => {
      replayCharId = id;
      net.send(MSG.LOBBY);
    },
  });
  const pausePanel = new PausePanel(modals, {
    onResume: () => net.send(MSG.PAUSE, { on: false }),
    onQuit: () => confirmQuit(),
  });

  const confirmQuit = async () => {
    const ok = await modals.confirm({ title: '结束本局？', text: '将立即结算并显示排名，本局无法继续。', ok: '结束并结算', tone: 'danger', iconName: 'flag' });
    if (ok) net.send(MSG.LEAVE);
    else if (store.phase === PHASE.PAUSED) pausePanel.show(store.pausedReason);
  };

  // ---------------------------------------------------------------- 道具（需求 2.1 / 2.2）
  // 服务端下发 lobby.rules.items 之后才有道具；之前一切 UI 都优雅降级（不显示道具栏、不开商店）。
  const hackPanel = new HackPanel(modals, store, net);
  const itemBar = new ItemBar($('itembar'), store, net, {
    onNeedBuy: (itemId) => {
      toast.show(`还没有「${ITEM_META[itemId]?.name ?? itemId}」：按 B 打开道具商店`, 'info', 'coin');
      ui.toggleItemShop();
    },
    onBlocked: (itemId, lv) => {
      const cfg = itemConfig(store, itemId);
      if (itemId === 'hourglass') return toast.show(`时间沙漏每局最多用 ${hourglassLimit(Math.max(1, lv))} 次`, 'warn', 'clock');
      if (itemId === 'hackbook') return toast.show('黑客手册每局只能用一次', 'warn', 'book');
      if (!canUseSlot(store.me, itemId, cfg)) return toast.show('老师正被定格，这类道具暂时不生效', 'warn', 'warn');
      return toast.show('次数用完了：在道具商店里补充', 'warn', 'coin');
    },
    onPickTarget: () => {
      modals.close(); // 选目标前先收起可能挡着画面的面板
      startPick();
    },
    onHack: () => toast.show('正在拉取全员名单…', 'info', 'book', 1800),
  });
  const itemShop = new ItemShop(modals, store, net);

  // 「选择目标」模式：InputManager 会把指针事件让出来，这里自己命中画面里的角色。
  const pickEl = $('target-pick');
  let pickActive = false;
  const setPick = (on) => {
    pickActive = on;
    input.setFrozenPick(on);
    if (pickEl) pickEl.hidden = !on;
  };
  /** 进入「选择目标」模式（次数/持有校验已在 ItemBar.useSlot 里做过）。 */
  const startPick = () => setPick(true);
  /** 点画面选一个可见角色（优先没被定格的，其次最近的）。 */
  const pickTargetAt = (clientX, clientY) => {
    const p = renderer.toWorld(clientX, clientY);
    if (!p) return null;
    let best = null;
    let bestD = Infinity;
    for (const [id, sp] of renderer.sprites) {
      if (id === store.playerId) continue;
      if (!sp.cache?.visible) continue;
      const d = Math.hypot((sp.cache.x ?? 0) - p.x, (sp.cache.y ?? 0) - p.y);
      const reach = 90; // 世界坐标：给一点点容差，方便点中
      if (d > reach) continue;
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
    return best;
  };
  $('map').addEventListener('pointerdown', (e) => {
    if (!pickActive) return;
    const id = pickTargetAt(e.clientX, e.clientY);
    if (!id) return toast.show('没点中角色：请直接点画面里的人', 'info', 'target', 1600);
    setPick(false);
    itemBar.sendFreeze(id);
  }, true);

  const ui = {
    teacherMenu,
    get modalOpen() {
      return !!modals.kind;
    },
    escape() {
      if (pickActive) {
        setPick(false);
        return toast.show('已取消选择目标', 'info', 'target', 1400);
      }
      if (teacherMenu.open) return teacherMenu.hide();
      if (stats.open) return stats.toggle();
      if (modals.kind) return modals.dismiss();
      if (store.phase === PHASE.PLAYING) net.send(MSG.PAUSE, { on: true });
    },
    /** B：开关道具商店（未下发道具配置时只提示，不报错）。 */
    toggleItemShop() {
      if (itemShop.open) return itemShop.close();
      if (!itemShop.available) return toast.show('服务端还没有下发道具配置，暂时无法购买', 'warn', 'coin');
      if (store.phase !== PHASE.PLAYING && store.phase !== PHASE.PAUSED) return toast.show('对局开始后才能使用道具', 'info', 'coin');
      itemShop.show();
    },
    /** 1-5：使用道具栏对应槽位（真正的分流在 ItemBar.useSlot）。 */
    useItemSlot(slot) {
      if (store.phase !== PHASE.PLAYING || !store.me) return false;
      if (modals.kind) return false;
      return itemBar.useSlot(slot);
    },
    toggleStats: () => stats.toggle(),
    toggleCamera: () => toast.show(renderer.toggleCamera() === 'follow' ? '镜头：跟随玩家' : '镜头：校园全景', 'info', 'camera', 1600),
    stepSpeed(dir) {
      const cur = SPEEDS.indexOf(store.game.speedMult ?? 1);
      const next = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, cur + dir))];
      if (next !== store.game.speedMult) net.send(MSG.SET_SPEED, { mult: next });
    },
  };

  // InputManager 需要 ui 才能把 B / 1-5 转成道具操作
  const input = new InputManager({ svg: $('map'), store, net, renderer, ui });

  const hud = new HudPanel(store, renderer, {
    onSpeed: () => {
      const cur = SPEEDS.indexOf(store.game.speedMult ?? 1);
      net.send(MSG.SET_SPEED, { mult: SPEEDS[(cur + 1) % SPEEDS.length] });
    },
    onPause: () => net.send(MSG.PAUSE, { on: store.phase !== PHASE.PAUSED }),
    onSettings: () => settings.show(() => store.phase === PHASE.PAUSED && pausePanel.show(store.pausedReason)),
    onClose: () => (store.phase === PHASE.PLAYING || store.phase === PHASE.PAUSED ? confirmQuit() : null),
    onCamera: () => ui.toggleCamera(),
  });

  // ---------------------------------------------------------------- 状态订阅
  const applyPhase = () => {
    const phase = store.phase;
    $('app').dataset.phase = phase;
    lobby.show(phase === PHASE.LOBBY);
    if (phase === PHASE.LOBBY && replayCharId && store.role === 'controller') {
      const id = replayCharId;
      replayCharId = null;
      net.send(MSG.JOIN, { characterId: id });
    }
    if (phase === PHASE.PAUSED) {
      teacherMenu.hide();
      if (!modals.kind || PC_MODALS.has(modals.kind) || modals.kind === 'pause') pausePanel.show(store.pausedReason);
    } else if (modals.kind === 'pause') {
      modals.close();
    }
    if (phase === PHASE.LOBBY || phase === PHASE.PLAYING) {
      if (modals.kind === 'gameover') modals.close();
    }
    if (phase === PHASE.LOBBY) renderer.setCameraMode('follow');
    if (phase === PHASE.PLAYING && store.me?.operatingPcId && !modals.kind && pcDialog.last) pcDialog.show(pcDialog.last);
    // 本局已结束但结算面板没显示过（刷新页面 / 新开标签 / 断线重连后重新接上 ENDED 的对局）：
    // gameover 事件只会在收到 GAMEOVER 消息的那一刻派发一次，重连后不会重放，
    // 而 #lobby 只在 LOBBY 阶段显示——不补这一步玩家会停在隐藏的 lobby + 静止地图上，无路可走。
    if (phase === PHASE.ENDED && store.gameover && !modals.kind) {
      showGameOver(store.gameover);
    }
  };
  store.addEventListener('phase', applyPhase);
  store.addEventListener('lobby', () => store.phase === PHASE.LOBBY && lobby.render());
  store.addEventListener('snapshot', () => {
    renderer.ensureSprites();
    if (itemShop.open) itemShop.refresh(); // 等级/次数/价格随快照刷新
  });
  // 结算面板可能由三处触发：GAMEOVER 消息、ENDED 阶段的补放、welcome 之后的重放。
  // 统一收敛到这里，重复调用时如果面板已经开着就不再重建（幂等，避免闪一下）。
  const showGameOver = (payload) => {
    const p = payload ?? store.gameover;
    if (!p) return;
    teacherMenu.hide();
    setPick(false);
    if (modals.kind === 'gameover') return; // 已经显示了，不重复 show
    gameover.show(p);
  };
  store.addEventListener('gameover', (e) => showGameOver(e.detail));
  store.addEventListener('events', (e) => {
    renderer.playEvents(e.detail);
    for (const ev of e.detail) eventToast(ev);
    if (stats.open) stats.render();
  });

  const eventToast = (e) => {
    const me = store.playerId;
    const name = (id) => store.rosterEntry(id)?.name ?? '';
    switch (e.type) {
      case 'round_start': return toast.show(e.text, 'gold', 'flag', 5000);
      case 'jc_success': return e.actorId !== me && toast.show(`你看到 ${name(e.actorId)} 在 ${name(e.targetId)} 的电脑上 JC！`, 'warn', 'eye');
      case 'jc_victim': return toast.show(`${e.text}回自己电脑查看积分吧。`, 'danger', 'warn', 5000);
      case 'teacher_catch':
        if (e.targetId === me) return toast.show(`被${name(e.actorId)}抓到了！-${e.penalty} 分`, 'danger', 'warn', 5000);
        if (e.actorId === me) return toast.show(`抓到 ${name(e.targetId)}！工资 +${e.amount}￥`, 'ok', 'yen', 4500);
        return toast.show(e.text, 'info', 'eye');
      case 'salary_changed':
      case 'pc_kicked':
      case 'ask_cancelled':
        return e.actorId === me && toast.show(e.text, 'warn');
      case 'score_changed':
        return e.actorId === me && toast.show(e.text, e.amount >= 0 ? 'ok' : 'danger', e.amount >= 0 ? 'coin' : 'warn');
      case 'buff_gained':
        return e.actorId === me && toast.show(e.text, 'ok', 'bolt', 2500);
      case 'ask_started':
        return e.actorId === me && toast.show(`开始向${name(e.targetId)}提问：保持在老师身边，10 秒后 +分`, 'info', 'question');
      case 'inspect_clear':
        return e.actorId === me && toast.show(e.text, 'info', 'check');
      case 'eliminated':
      case 'failed':
        return toast.show(e.text, e.actorId === me ? 'danger' : 'info', 'warn', 5000);
      // ---- 道具相关事件（契约 v0.2：EVENT.ITEM_BOUGHT/ITEM_UPGRADED/ITEM_USED/FROZEN/HACK_RESULT）
      case 'item_bought':
        return e.actorId === me && toast.show(e.text || '购买成功', 'gold', 'coin');
      case 'item_upgraded':
        return e.actorId === me && toast.show(e.text || '升级成功', 'gold', 'bolt');
      case 'item_used':
        return e.actorId === me ? toast.show(e.text || '道具已生效', 'ok', 'sparkle') : null;
      case 'frozen':
        if (e.targetId === me) return toast.show(`你被${name(e.actorId)}定住了 ${Math.round((Number(e.amount) || 0) / 1000)} 秒！`, 'danger', 'clock', 5000);
        if (e.actorId === me) return toast.show(`已定格${name(e.targetId)}`, 'ok', 'clock');
        return toast.show(e.text || `${name(e.targetId)} 被定格了`, 'info', 'clock');
      case 'hack_result':
        return toast.show(e.text || (e.ok ? '入侵成功' : '入侵失败'), e.ok ? 'gold' : 'danger', 'book', 5000);
      default:
        return null;
    }
  };

  /** 道具生效后的提示（各道具的字段不同，见 server/systems/ItemSystem.js）。 */
  const itemUsedToast = (p) => {
    const label = ITEM_META[p.itemId]?.name ?? p.itemId;
    switch (p.itemId) {
      case 'freeze': return toast.show(`${label}命中！${store.rosterEntry(p.targetId)?.name ?? '目标'} 被定格 ${((Number(p.ms) || 0) / 1000).toFixed(1)} 秒`, 'ok', 'clock', 4500);
      case 'hourglass': return toast.show(`${label}：全场 ${p.affected ?? '?'} 人定格 ${((Number(p.ms) || 0) / 1000).toFixed(1)} 秒`, 'ok', 'clock', 4500);
      case 'buyoff': return toast.show(`${label}已生效：老师目击你的概率降到 ${p.seeThroughPct ?? '?'}%`, 'ok', 'eye', 5000);
      case 'password': return toast.show(`${label}已装备：别人 JC 你要先破解 ${String(p.lockMs ?? '').length ? Math.round(Number(p.lockMs) / 1000) : '?'} 秒`, 'ok', 'shield', 5000);
      default: return toast.show(`${label}已生效`, 'ok', 'sparkle');
    }
  };

  // ---------------------------------------------------------------- 服务端对话框
  net.addEventListener('dialog', (e) => {
    const p = e.detail;
    teacherMenu.hide();
    switch (p.kind) {
      case 'pc': return pcDialog.show(p);
      case 'score_view': return scoreDialog.show(p);
      case 'jc.open': return jcDialog.show(p, store.rosterEntry(store.playerId)?.username);
      case 'jc_blocked':
        if (modals.kind === 'jc') return jcDialog.setError(p.message + (p.remainingMs ? `（${Math.ceil(p.remainingMs / 1000)} 秒后可再试）` : ''));
        return toast.show(p.message, 'warn');
      case 'jc.result':
        if (p.caught) toast.show(`JC 成功 +${p.amount}，但被${p.teacherName}目击！扣除 ${p.penalty} 分`, 'danger', 'warn', 6000);
        else {
          toast.show(`JC 成功：从 ${p.targetName} 处分享到 ${p.amount} 分`, 'gold', 'sparkle', 4500);
          if (store.me?.operatingPcId) pcDialog.refreshOwnerScore(p.ownerScore);
        }
        return null;
      // ---- 道具相关 dialog（服务端 ItemSystem 的实际 kind 如下；任务书里的 'item.result' 并不存在）
      case 'hack.targets':
        setPick(false);
        return hackPanel.show(p);
      case 'hack_result':
        hackPanel.finish();
        if (p.ok) toast.show(`入侵成功：${p.delta >= 0 ? '+' : ''}${p.delta} 分已经改好了`, 'gold', 'book', 6000);
        else toast.show(`入侵失败：自己被倒扣 ${p.penalty ?? 0} 分`, 'danger', 'warn', 6000);
        if (p.expelled) toast.show('被校长发现入侵监控系统，你被开除了', 'danger', 'warn', 7000);
        return null;
      case 'item_bought':
        itemShop.refresh();
        return toast.show(`购买成功：${ITEM_META[p.itemId]?.name ?? p.itemId} Lv${p.lv}${p.uses != null ? ` · 剩余 ${p.uses} 次` : ''}`, 'gold', 'coin');
      case 'item_upgraded':
        itemShop.refresh();
        return toast.show(`升级成功：${ITEM_META[p.itemId]?.name ?? p.itemId} 升到 Lv${p.lv}`, 'gold', 'bolt', 4500);
      case 'item_used':
        itemShop.refresh();
        return itemUsedToast(p);
      case 'jc_locked':
        // 强密码：JC 表单就地显示剩余解锁秒数
        if (modals.kind === 'jc') return jcDialog.setLocked(p.remainMs);
        return toast.show(`这台电脑上了强密码，还需 ${Math.ceil((Number(p.remainMs) || 0) / 1000)} 秒才能破解`, 'warn', 'shield');
      case 'close':
        setPick(false);
        if (PC_MODALS.has(modals.kind)) modals.close();
        pcDialog.last = null;
        if (p.message && p.reason !== 'left') toast.show(p.message, p.reason === 'caught' ? 'danger' : 'warn');
        return null;
      case 'summary':
        return gameover.updateSummary(p.text);
      default:
        return null;
    }
  });
  net.addEventListener('server-error', (e) => {
    const p = e.detail;
    if (p.code === 'E_RATE' || modals.kind === 'jc') return; // JC 表单内的错误已就地显示
    // 黑客面板正在等结果：错误就地显示，别把面板关掉
    if (hackPanel.open && (p.code === 'E_ITEM' || p.code === 'E_FROZEN' || p.code === 'E_ELIMINATED')) {
      hackPanel.reject(p.message);
      return toast.show(p.message, 'danger', 'warn');
    }
    toast.show(p.message, p.code === 'E_COOLDOWN' ? 'warn' : 'danger');
  });
  // 连接提示条：只在「确实断开」时出现。握手阶段（已连上但还没收到 welcome）不算断开，
  // 之前只看 connected 布尔会让「连上但会话被别人接管」这类情况误判成正常在线。
  const setBanner = (text) => {
    const el = $('conn-banner');
    if (!el) return;
    const label = el.querySelector('span');
    if (text && label) label.textContent = text; // 只换文字，保留左侧图标
    el.hidden = !text;
    el.classList.toggle('clickable', Boolean(text));
  };
  net.addEventListener('connection', (e) => {
    if (e.detail.connected) setBanner(null);
    else setBanner('连接中断，正在重连…');
  });
  net.addEventListener('welcome', (p) => {
    lobby.show(store.phase === PHASE.LOBBY);
    if (p?.role === 'spectator') {
      setBanner('本窗口已转为观战：游戏正在另一个窗口里进行（点此可夺回控制权）');
    } else {
      setBanner(null);
    }
    // 重连/刷新后接上的若是一局已结束的对局：initialMessages 里 PHASE 在 GAMEOVER 之前，
    // 所以 applyPhase 那一刻 store.gameover 还是空的；等 GAMEOVER 落地后再补一次（幂等）。
    if (store.phase === PHASE.ENDED && store.gameover) showGameOver(store.gameover);
  });
  // 观战/被夺权：不断线，也不动画面，只把提示条亮起来，并支持一键夺回
  net.addEventListener('spectator', (e) => {
    setBanner('本窗口已转为观战：游戏正在另一个窗口里进行（点此可夺回控制权）');
    if (e.detail?.message) toast.show(e.detail.message, 'warn', 'signal');
  });
  $('conn-banner')?.addEventListener('click', () => {
    // 清掉本地会话后重连 = 以「新窗口」身份接管控制权
    try {
      sessionStorage.removeItem('jican.session');
    } catch {
      /* ignore */
    }
    setBanner(null);
    net.connect();
  });

  // ---------------------------------------------------------------- 渲染循环
  const frame = (now) => {
    renderer.frame(now);
    hud.update(now);
    input.tick(now);
    itemBar.sync(); // 道具栏随快照（等级/次数/每局次数）实时刷新
    if (teacherMenu.open && renderer.interactable?.id !== teacherMenu.targetId) teacherMenu.hide();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  lobby.show(true);
  net.connect();
  // 调试入口：地址栏加 ?debug 时在控制台暴露只读镜像，便于排查
  if (new URLSearchParams(location.search).has('debug')) window.__jican = { store, net, renderer, itemBar, itemShop, hackPanel, netPanel };
}

boot().catch((err) => {
  document.body.textContent = `启动失败：${err.message}`;
  console.error(err);
});
