// 前端引导：拉取地图 → 初始化渲染器与 UI → 连接服务端 → 启动渲染循环。

import { ACTION, MSG, PHASE, SPEEDS } from '/shared/constants.js';
import { GameStore } from './store/GameStore.js';
import { NetClient } from './net/NetClient.js';
import { SvgRenderer } from './render/SvgRenderer.js';
import { InputManager } from './input/InputManager.js';
import { h, hydrateIcons, icon } from './util/dom.js';
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
import { ConfigPanel } from './ui/ConfigPanel.js';
import { LobbySettingsButton } from './ui/LobbySettingsButton.js';
import { StatsPanel } from './ui/StatsPanel.js';
import { ItemShop } from './ui/ItemShop.js';
import { ItemBar } from './ui/ItemBar.js';
import { HackPanel } from './ui/HackPanel.js';
import { NetPanel } from './ui/NetPanel.js';
import { ITEM_META, itemConfig, canUseSlot, hourglassLimit } from './ui/items.js';
import { installInputGuards, setTypingGuard } from './util/ime.js';
import { shouldGuardTyping } from './util/typing-guard.js';
import {
  ROOM_KEY,
  describeLobbyError,
  isFatalLobbyCode,
  isRoomJoinQuery,
  normalizeLobbyPlayers,
  countOnline,
  readScrubbedRoomId,
  roomBadgeText,
  roomCredentialFrom,
  roomLockNote,
  resolveSearch,
  scrubbedQuery,
  splitLobbyPlayers,
  startButtonState,
  seatRows,
  markSeatRows,
  seatSummary,
  rosterGrid,
  settingsLabel,
  settingsPatch,
  OWNER_ROOM_ACTIONS,
} from './net/roomUrl.js';

const $ = (id) => document.getElementById(id);
// 这些弹窗都属于「正在用电脑」，暂停时不应该被暂停面板顶掉
const PC_MODALS = new Set(['pc', 'score', 'jc']);

async function boot() {
  // 需求 1.1：进对局后才禁复制/粘贴/剪切 + 强制英文键盘；大厅与结算页放行（见 applyPhase 里的 setTypingGuard）
  installInputGuards();
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
  // 需求（v0.10，用户原话 m03001）：「新的联机窗口去掉单机/联机按钮，因为那是联机窗口肯定是联机」。
  // 判据只看地址栏：带 type=create|join + token + id 的完整进房参数，或者被擦成 ?room=<房间号> 之后刷新
  // ——这两种都是"游戏窗口/联机房间页"，那页必然是联机，再给一个"切回单机"的按钮只会点出一具空壳
  // （单机要自己发 MSG.JOIN，房间页的 NetClient 已经挂在 /lobby 上了）。普通本机页面照旧显示切换。
  const roomPage = isRoomJoinQuery(location.search) || Boolean(readScrubbedRoomId(location.search));
  const netPanel = new NetPanel(store, { roomPage });
  const lobby = new Lobby($('lobby'), store, net, netPanel);
  const settings = new SettingsPanel(modals, store, renderer, net);
  // 首页（大厅）显眼的「设置」入口：点开服务端配置面板（编辑 config.json 全部配置项）
  const configPanel = new ConfigPanel(modals, {
    onSaved: () => toast.show('配置已保存并生效', 'info', 'check', 2000),
  });
  const lobbySettingsBtn = new LobbySettingsButton(null, { onOpen: () => configPanel.show() });
  lobby.settingsSlot = () => {
    const slot = h('div.lobby-settings-slot');
    lobbySettingsBtn.host = slot;
    lobbySettingsBtn.render();
    lobbySettingsBtn.show(store.phase === PHASE.LOBBY);
    return slot;
  };
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
    // 需求 1.1：只有对局中（PLAYING / PAUSED）才拦复制粘贴、强制英文键盘；
    // 大厅要填房间号/服务器地址、设置页要复制 ID 密钥与 Token、结算页要复制成绩——这些阶段一律放行。
    setTypingGuard(shouldGuardTyping(phase));
    lobby.show(phase === PHASE.LOBBY);
    lobbySettingsBtn.show(phase === PHASE.LOBBY); // 首页设置入口只在 LOBBY 可见
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
    // 鉴权被拒（联机房间参数不对）不是"断线"：横幅上已经有具体原因了，别用"正在重连"覆盖掉
    if (e.detail?.fatal) return;
    if (e.detail.connected) setBanner(null);
    else setBanner('连接中断，正在重连…');
  });
  net.addEventListener('welcome', (e) => {
    const p = e.detail;
    lobby.show(store.phase === PHASE.LOBBY);
    if (p?.role === 'spectator' && !p?.room) {
      // 单机/被夺权：另一个窗口在玩，本窗口只是旁看
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
    // 房间页（有房间上下文）的观战是正常身份：提示"这局已经开始，你只是旁观"，
    // 不给「点此夺回」——点下去会把会话清掉、重连，反而把自己踢出房间。
    if (inRoomPage()) {
      setBanner(e.detail?.message || '当前是观战：这局已经开始，你看不到操作权（关掉游戏窗口可在高级里「再次打开游戏窗口」）');
    } else {
      setBanner('本窗口已转为观战：游戏正在另一个窗口里进行（点此可夺回控制权）');
    }
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

  // ---------------------------------------------------------------- 联机进房（v0.3）
  // 三条线在这里汇合：
  //   ① 通道：NetClient.connect() 自己挑 /lobby 还是 /ws（判定在 net/roomUrl.js）；
  //   ② 地址栏：welcome.room 到手后只留 ?room=<id>，token/id/invcode 撤出 URL 存进 sessionStorage；
  //   ③ HUD：右侧一枚「房间 123456 · 在线 n」徽章，点开是玩家列表（房主 + 观战者）。
  // 观战者从头到尾只读：他连的是 /lobby 的 spectator 座位，NetClient.send() 会把操作类指令拦在本地。
  const roomState = {
    roomId: '', // 房间号（6 位）；'' = 单机/还没握手
    seat: null, // welcome.room.seat：true 才是房主（唯一能开局的人）
    players: null, // 玩家列表；null = 还没到（徽章上不显示"在线 0"骗人）
    open: false, // 玩家列表是否展开（点击徽章切换；显式展开过就不再被"服务端推送"自动弹开）
    error: '', // 进房失败的原因（显示在连接横幅上）
    started: false, // 房间是否已开局（开局后房间锁定，不再接受新成员）
    pendingCount: 0, // 还没审批的入房申请数（服务端 room 视图里的 pendingCount）
    busy: '', // 正在进行的房间操作：'start' | 'kick' | 'approve' | 'reject' | 'seat' | 'settings' | ''
    fromPoll: false, // 当前 players 是"轮询兜底"来的（推送优先，轮询只补推送没覆盖到的空档）
    seats: {}, // 房间视图里的座位表 {username: characterId}（服务端 RoomManager 的 seats Map 序列化）
    settings: null, // 房间参数 {durationMs, targetScore}；null/字段 null = 用配置默认值
    username: '', // welcome.room.username：我在房间里的用户名（座位表据此判断"我"是哪一行）
    style: '', // 开头像卡上的"你是谁"（由 welcome.room 带的 username/seat 拼）
    isOwner: false, // welcome.room.isOwner：房主身份（≠ 有没有座位角色），管理权唯一判据
  };
  const isSeat = () => roomState.seat === true;
  /**
   * 我是不是这间房的房主（管理权：开局 / 踢人 / 审批 / 房间参数）。
   * 与 isSeat()（"我现在有没有座位角色"）是两件事：座位制下房主没选角色之前 seat=false，
   * 但他依然是房主，必须能看到并点自己的座位、能改参数、能开局。
   */
  const isOwner = () => roomState.isOwner === true;
  /** 当前这间房的名单，按 splitLobbyPlayers 分成 {owner, spectators, pending}。 */
  const roomMembers = () => splitLobbyPlayers(normalizeLobbyPlayers(roomState.players, roomState.roomId));
  /**
   * 这个窗口是不是"游戏窗口"（= 有房间上下文）。
   *
   * 判据：路由按房间参数打开的那一页（NetPanel 的 roomPage），或者服务端已经给了房间快照。
   * 房间页里的一切都该由房间座位表说了算：大厅的「单机 · 你要扮演谁 / 开始游戏」不该画
   * （同一份 idKey 开的第二个窗口也会连进同一个座位，那些入口点下去只有 E_STATE）。
   */
  const inRoomPage = () => Boolean(netPanel?.roomPage) || Boolean(roomState.roomId) || Boolean(net.room?.id);
  /** 服务端给我自己起的房间内用户名（座位表里"我"就是这一行；缺省时退回凭据/玩家列表）。 */
  const myRoomName = () => roomState.username || net.room?.username || roomCredential().username || '';

  // ---------------------------------------------------------------- 座位表（v0.9）
  // 用户诉求：「联机窗口干掉人物选择，改成每个玩家选自己的座位」。
  // 判定（谁坐哪儿、我能不能点、还差谁）全在 net/roomUrl.js 的纯函数里（有单测钉住），
  // 这里只负责把结果画成 DOM、以及在点下去时发一条 /api/lobby/room/seat。
  const rosterOf = () => (Array.isArray(store.lobby?.roster) ? store.lobby.roster : []);
  /** 当前玩家列表 → 已标记"是不是我/我能不能点"的座位行；成员列表还没到时不拿待审批的人凑数。 */
  const seatRowsNow = () => {
    const { owner, spectators } = roomMembers();
    const members = [...(owner ? [owner] : []), ...spectators];
    // 「我是房主」要看服务端身份（welcome.room.isOwner），不能看 roomState.seat：
    // 座位制下 seat 只在「房主挑好角色之后」才变 true，房主挑角色之前会被当成观战者，
    // 连自己那一行都点不动 —— 那正是他现在最需要点的东西。房间管理权仍只看 isOwner()。
    return markSeatRows(seatRows(members, roomState.seats, rosterOf()), myRoomName(), {
      seat: isOwner(),
      started: roomState.started === true,
    });
  };

  /** 房间凭据（sessionStorage 里的 jican.room）：房主操作的 body 要带 id，房间号也以它为准。 */
  const readRoomCredential = () => {
    try {
      const raw = sessionStorage.getItem(ROOM_KEY);
      if (!raw) return null;
      const v = JSON.parse(raw);
      return v && typeof v === 'object' ? v : null;
    } catch {
      return null;
    }
  };
  const roomCredential = () => readRoomCredential() ?? {};

  /** 只留 ?room=<id>：用 replaceState 而不是 pushState，免得"后退"退回到带 token 的地址。 */
  const scrubAddressBar = (roomId) => {
    try {
      const url = new URL(location.href);
      const qs = scrubbedQuery(roomId);
      const next = url.pathname + qs + url.hash;
      if (url.search !== qs) history.replaceState(history.state, '', next);
    } catch {
      /* 老浏览器 / file:// 下 replaceState 可能抛：擦不掉不影响游戏，忽略 */
    }
  };

  /** 徽章挂在 .hud-actions 里（LOBBY 阶段整条 HUD 会被 layout.css 隐藏，正好不挡大厅）。 */
  const roomBadgeEl = h('button.btn.sm.lob-badge', {
    type: 'button',
    hidden: true,
    title: '房间与在线玩家',
    'aria-haspopup': 'true',
    'aria-expanded': 'false',
    onclick: () => {
      roomState.open = !roomState.open;
      renderRoomUi();
    },
  });
  const hudActions = document.querySelector('.hud-actions');
  if (hudActions) hudActions.insertBefore(roomBadgeEl, hudActions.firstChild);
  const roomPanelEl = h('div.card.lob-panel', { hidden: true, role: 'dialog', 'aria-label': '房间玩家' });
  $('stage')?.append(roomPanelEl);

  // ---------------------------------------------------------------- 房主操作（v0.4）
  /**
   * 调一条房间接口。四条路由的形状是统一的：POST /api/lobby/room/<action> + body {roomid,id[,username]}。
   * 为什么要 id：服务端鉴权唯一判据就是"body.id 是不是这间房的 ownerId"（见 LobbyHttp.js:539-541），
   * 所以 id 只能从 sessionStorage 的房间凭据里取，不能从地址栏（地址栏已经被擦成只剩 ?room=）。
   */
  const roomAction = async (action, extra = {}) => {
    const cred = roomCredential();
    const roomid = roomState.roomId || cred.roomid || '';
    if (!roomid) return { ok: false, code: 'NO_ROOM', error: '还没有进入房间' };
    if (!cred.id) return { ok: false, code: 'NO_ID', error: '房间凭据已丢失：请回大厅重新进房' };
    roomState.busy = action;
    // 只重画面板，不重画整个 HUD：renderRoomUi() 会顺手把 syncPlayersPoll() 叫起来，
    // 这里没必要为了"按钮变 disabled"去动徽章与轮询开关。
    renderPlayersPanel();
    try {
      const r = await fetch(`/api/lobby/room/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-jican-client': 'web' },
        body: JSON.stringify({ roomid, id: cred.id, ...extra }),
      });
      const body = await r.json().catch(() => ({}));
      if (body && body.ok) return body;
      return { ok: false, status: r.status, code: body?.code ?? 'INTERNAL', error: body?.error ?? '操作失败' };
    } catch (err) {
      return { ok: false, code: 'NETWORK', error: '连不上服务器：' + String(err && err.message ? err.message : err) };
    } finally {
      roomState.busy = '';
    }
  };

  /** 开局成功后统一收尾：锁房 + 弹窗 + 重画（/api/lobby/room/start 会顺手 broadcastPlayers）。 */
  const onRoomStarted = () => {
    roomState.started = true;
    roomState.pendingCount = 0;
    renderRoomUi();
    toast.show('已开始游戏，房间不再接受新成员', 'gold', 'flag', 5000);
  };

  /**
   * 房主的「开始游戏」：只发 POST /api/lobby/room/start，绝不自己补发 MSG.JOIN。
   * 为什么：真正落座的动作是座位行里的「选座」（POST /api/lobby/room/seat）→ 服务端 characters 表被写入；
   * startRoom 只负责读 characters 并调 controller.startRound。所以还有人没座位时服务端会回 400 NO_CHARACTER
   * —— 这里如实把"还差谁"指出来，不锁房，也不为了绕过它再发一次 JOIN（那会把同一局开两次）。
   */
  const doStartGame = async () => {
    if (roomState.busy) return;
    const out = await roomAction('start');
    if (out.ok) return onRoomStarted();
    if (out.code === 'NO_CHARACTER') {
      const { unseated } = seatSummary(seatRowsNow());
      toast.show(unseated.length ? `还有人没选座位：${unseated.join('、')}（选完才能开始）` : '还有人没选座位，选完才能开始', 'warn', 'target', 5000);
      return;
    }
    toast.show(out.error || '开始游戏失败', 'danger', 'warn', 5000);
    renderRoomUi();
  };

  /**
   * 「清除房间」（v0.11）：房主主动把当前房间停掉并删除。
   *
   * 和「退出」不是一回事：退出只是让人走，房间还在；清除是这间房从服务器上消失，
   * 房间号立刻失效，别人的窗口会收到拉取失败 → 退回大厅。
   * 这是不可撤销的动作（房间里的人都会被请出去），所以先用 confirm 拦一道，
   * 而且是「开局中也允许」——用户要的正是"停止当前房间"。
   */
  const doCloseRoom = async () => {
    if (roomState.busy) return;
    const id = roomState.roomId || roomCredential().roomid || '';
    const yes = window.confirm(`确定要清除房间 ${id} 吗？\n\n这会停止当前这一局并删除房间，房间里的所有人都会被请回大厅，且无法撤销。`);
    if (!yes) return;
    const out = await roomAction('close');
    if (!out.ok) {
      toast.show(out.error || '清除房间失败', 'danger', 'warn', 5000);
      renderRoomUi();
      return;
    }
    // 服务端已经把房间删了：本地也把房间状态清干净，别让徽章继续挂着一个不存在的房间号。
    try {
      sessionStorage.removeItem(ROOM_KEY);
    } catch {
      /* 隐私模式下 sessionStorage 可能不可用：不影响主流程 */
    }
    roomState.roomId = '';
    roomState.players = null;
    roomState.seats = {};
    roomState.started = false;
    roomState.isOwner = false;
    roomState.seat = false;
    roomState.username = '';
    roomState.open = false;
    roomState.pendingCount = 0;
    roomState.error = '';
    scrubAddressBar('');
    renderRoomUi();
    toast.show(`已清除房间 ${id}：这一局已停止，房间号作废`, 'ok', 'trash', 6000);
    // 回到大厅（不刷新页面：本地已经清干净了，刷新反而会去连一条已经不存在的房间）
    if (net.send) net.send(MSG.LOBBY);
  };

  /**
   * 一次房主行内操作（同意 / 拒绝 / 踢出）。
   * 服务端成功后会 broadcastPlayers()，所以这里不自己改本地列表 —— 只等推送 + 轮询把结果带回来；
   * 唯一的动作是重画一次：把 roomState.busy 清掉，否则按钮会永远停在"处理中"。
   */
  const doRoomOp = async (action, p) => {
    if (roomState.busy) return;
    const out = await roomAction(action, { username: p.username });
    if (!out.ok) toast.show(out.error || '操作失败', 'danger', 'warn', 4500);
    else if (action === 'approve') toast.show(`已同意 ${p.username} 进入房间`, 'ok', 'check', 3200);
    else if (action === 'reject') toast.show(`已拒绝 ${p.username} 的入房申请`, 'info', 'door', 3200);
    else if (action === 'kick') toast.show(`已把 ${p.username} 请出房间`, 'ok', 'exit', 3200);
    // 成功的状态变化由服务端 broadcastPlayers() 推回来（事件里会重画），这里只负责把按钮解锁
    renderPlayersPanel();
  };

  /**
   * 选座位：POST /api/lobby/room/seat {roomid, id, username, characterId}。
   *
   * 三条规则（与 server RoomManager.claimSeat:276 一对一）：
   *   ① 房主能传任何 username（指派）；非房主只能传自己 —— 所以普通成员这里直接把服务端给的
   *      房间内用户名写进去，压根不给"改别人"的机会；
   *   ② characterId 传 '' = 让座（不选角色），不是"保持原样"；
   *   ③ 开局后一律 403 ROOM_STARTED，前端已经不渲染按钮了，这里再拦一次省一次 400 往返。
   */
  const doSeatOp = async (username, characterId) => {
    if (roomState.busy) return;
    // 谁也没坐成的时候必须回滚，所以先留住旧表（乐观更新会覆盖 roomState.seats）
    const prevSeats = { ...roomState.seats };
    // 别在开局后再去改座：服务端照样回 403，这里先说清楚，省一次往返
    if (roomState.started) return toast.show('已经开局了，座位锁定', 'warn', 'shield', 3600);
    const who = String(username || '').trim();
    if (!who) return toast.show('不知道给谁选座位：玩家列表还没到', 'warn', 'warn', 3600);
    const cid = String(characterId ?? '');
    // 乐观更新：把这一行先画成新座位，点下去立刻有反馈（服务端会 broadcastPlayers 把真值推回来）
    roomState.seats = { ...roomState.seats, [who]: cid };
    renderPlayersPanel();
    const out = await roomAction('seat', { username: who, characterId: cid });
    if (!out.ok) {
      // 回滚：SEAT_TAKEN / NOT_MEMBER / ROOM_STARTED 都会落到这里，别让界面停在"看起来坐上了"
      roomState.seats = prevSeats;
      toast.show(out.error || '选座失败', 'danger', 'warn', 4600);
    } else {
      // 服务端把整间房的最新视图放在 out.room 里（LobbyHttp.js:604 直接回 rooms.view(out.room)），
      // 所以响应里一定带着服务端认定的座位表 —— 用它覆盖乐观值，别信本地那份。
      adoptRoomView(out.room);
      // 名字一律从人物表反查：seatRows 里的 charName 是上一次快照的，可能还没来得及跟着变。
      const roster = rosterOf().find((e) => e.id === cid);
      toast.show(cid ? `${who} 坐在 ${roster?.name ?? cid}` : `${who} 让出了座位`, 'ok', 'check', 2600);
    }
    renderRoomUi();
  };

  /** 服务端返回的 room 视图（seats / settings / started / pendingCount）就地合并进 roomState。 */
  const adoptRoomView = (view) => {
    if (!view || typeof view !== 'object') return;
    if (view.seats && typeof view.seats === 'object') roomState.seats = { ...view.seats };
    if (view.settings && typeof view.settings === 'object') roomState.settings = { ...view.settings };
    if (typeof view.started === 'boolean') roomState.started = view.started;
    if (Number.isFinite(Number(view.pendingCount))) roomState.pendingCount = Number(view.pendingCount);
  };

  /**
   * 房主改单局参数（时长 / 目标分）：POST /api/lobby/room/settings。
   * 校验先在本地做（settingsPatch），错话由前端说清楚，别等服务器 400 再打一行红字。
   */
  const doSettingsSave = async (minutes, targetScore) => {
    if (roomState.busy) return;
    const patch = settingsPatch({ minutes, targetScore });
    if (!patch.ok) return toast.show(patch.error, 'warn', 'warn', 4200);
    if (!Object.keys(patch.body).length) return; // 两个框都空着 = 什么都没改，别白跑一趟
    const out = await roomAction('settings', patch.body);
    if (out.ok) {
      if (out.room) adoptRoomView(out.room);
      toast.show('房间参数已更新', 'ok', 'check', 2600);
    } else {
      toast.show(out.error || '保存房间参数失败', 'danger', 'warn', 4600);
    }
    renderRoomUi();
  };

  /** 弹窗里"我"是谁：判定的是被指派的那一行（房主给自己选座时就是自己）。 */
  const myNameForSeats = (row) => (row?.isMe ? myRoomName() : row?.username ?? '');

  /**
   * 选座弹窗（用 ModalHost，和别的面板同一套外壳与 Esc/遮罩关闭）。
   * 关掉时不刷新座位表 —— 弹窗本来就没抢焦点，刷新反而会把刚打开的面板卷回顶部。
   */
  const openSeatPicker = (row) => {
    if (!row) return;
    const grid = rosterGrid(rosterOf(), { locked: roomState.started === true, seats: roomState.seats, me: myNameForSeats(row) });
    const pick = (c) => {
      modals.close();
      doSeatOp(row.username, c.id);
    };
    const card = modals.open('seat', {
      title: row.isMe ? (row.characterId ? '换一个座位' : '选你自己的座位') : `给 ${row.username} 指派座位`,
      sub: row.isMe
        ? (row.characterId ? '点别的角色就换过去；已被别人坐的格子会显示是谁、不能点' : '选完就在这一局里扮演他；房主随时能改')
        : '房主可以替任何人换座位；已被别人坐的格子会显示是谁、不能点',
      icon: 'user',
      dismissable: true,
      body: [
        ...(grid.length
          ? grid.map((g) => h('div.seat-group', {},
            h('div.lob-sec-title', { text: g.title }),
            h('div.seat-grid', {}, ...g.chars.map((c) => h(`button.seat-chip${c.isMine ? '.is-mine' : ''}`, {
              type: 'button',
              'aria-pressed': String(c.isMine),
              disabled: c.disabled,
              title: c.disabled ? (c.takenBy ? `${c.takenBy} 已经坐了` : '已开局，座位锁定') : `${c.classLabel} · ${c.username || '—'}`,
              style: { '--c': c.role === 'teacher' ? 'var(--accent-teacher)' : `var(--class-${c.classId || 1})` },
              onclick: () => pick(c),
            }, h('span.seat-name', { text: c.name }), h('span.seat-sub', { text: c.takenBy ? `${c.takenBy} 已坐` : c.isMine ? '你坐着' : c.classLabel }))))))
          : [h('div.note', {}, icon('warn', 'sm'), '人物表还没到（服务端配置未读取），请稍后重试')]),
        h('div.lob-foot', { text: '「选座」只决定这一局谁扮演谁；退出房间不会清掉座位。' }),
      ],
      foot: [
        h('button.btn.ghost', { type: 'button', onclick: () => { modals.close(); } }, '取消'),
        ...(row.characterId
          ? [h('button.btn.sm.lob-op.is-danger', { type: 'button', onclick: () => { modals.close(); doSeatOp(row.username, ''); } }, row.isMe ? '放弃座位' : '清空他的座位')]
          : []),
      ],
    });
    return card;
  };

  /**
   * 进房后自动弹选座（用户原话：「不应该是加入房间时，自动弹窗让你选择吗？」）。
   * 之前只画一行「未选座位」，用户要自己找到那一行再点，新窗口第一眼看起来就是"没选座位"。
   * 现在欢迎帧一落定就弹一次；已经有座位 / 已开局 / 已有别的弹窗 都不弹。
   * force=true 来自房间页顶部「选座 / 换座位」按钮：那是用户主动点的，允许换座时再弹。
   */
  let seatPrompted = false;
  const popSeatPicker = (force = false) => {
    if (modals.kind) return false;
    if (roomState.started === true) {
      if (force) toast.show('已经开局了，座位锁定', 'warn', 'shield', 3600);
      return false;
    }
    if (!force && (seatPrompted || roomState.seat === true)) return false;
    const me = myRoomName();
    if (!me) return false;
    const mine = seatRowsNow().find((r) => r.isMe);
    const row = mine || { username: me, isMe: true, canPick: true, characterId: '' };
    if (row.canPick !== true) return false;
    seatPrompted = true;
    openSeatPicker(row);
    return true;
  };
  // 房间页（独立窗口）顶部只画房间数据，选座入口走这个回调（见 NetPanel 的 roomPage 分支）。
  if (netPanel) netPanel.onPickSeat = () => { popSeatPicker(true); };

  /**
   * 入房申请的"实时缺口"补丁：房主同意之前，申请人拿到的只是一条 ws 的「等待房主同意」，
   * 他没有 seat，服务端的 playerList（含 role:'pending'）只有在有人连上/断开或调四条房间接口时才广播。
   * 也就是说房主静静开着面板时，门口等了谁都收不到推送 —— 所以面板打开期间每 3 秒拉一次兜底。
   * 推送优先：轮询结果只覆盖"没有推送/推送更旧"的窗口，两边合并时以推送到的快照为准。
   */
  const PLAYERS_POLL_MS = 3000;
  let playersPollTimer = null;
  const stopPlayersPoll = () => {
    if (playersPollTimer !== null) {
      clearInterval(playersPollTimer);
      playersPollTimer = null;
    }
  };
  const pollPlayers = async () => {
    const cred = roomCredential();
    const roomid = roomState.roomId || cred.roomid || '';
    if (!roomid) return;
    try {
      const r = await fetch(`/api/lobby/players?roomid=${encodeURIComponent(roomid)}`, { headers: { 'x-jican-client': 'web' } });
      const body = await r.json().catch(() => ({}));
      if (!body || body.ok !== true || !Array.isArray(body.players)) return;
      // 推送在这期间到过（roomState.fromPoll 被重置成 false 且 players 非空）就不覆盖，免得轮询打断推送
      if (!roomState.fromPoll && roomState.players !== null) return;
      roomState.players = body.players;
      roomState.pendingCount = countPending(body.players);
      renderRoomUi();
    } catch {
      /* 轮询是兜底，失败就等下一轮；不要把错误刷到用户屏幕上 */
    }
  };
  const countPending = (players) => splitLobbyPlayers(normalizeLobbyPlayers(players, roomState.roomId)).pending.length;
  const syncPlayersPoll = () => {
    // 只有"在房间里 + 面板展开 + 是房主"才需要补这个缺口：观战者看到的 pending 对自己没意义
    const need = roomState.open && Boolean(roomState.roomId) && (isOwner() || isSeat());
    if (need && playersPollTimer === null) {
      pollPlayers();
      playersPollTimer = setInterval(pollPlayers, PLAYERS_POLL_MS);
    } else if (!need) {
      stopPlayersPoll();
    }
  };
  window.addEventListener('beforeunload', stopPlayersPoll);

  /**
   * 一行座位（v0.9 的重心）：左边是谁，右边坐的是哪个角色。
   *
   * 三种角色在这个行里各有各的说法：
   *   我自己 —— 座位那一格可点（"未选座位"三个字本身就是按钮），选完就变成角色名；
   *   别人 · 我是房主 —— 座位格也能点，点开是"指派"；
   *   别人 · 我是观战者 —— 纯文本，一个可点的东西都没有（服务端也会 403，前端别白给预期）。
   * 房主自己那行没有「踢出」；开局后座位格全部只读，踢人也一起收掉。
   */
  const seatRow = (row, busy) => {
    const locked = roomState.started === true;
    // busy 是「房间正忙」；座位操作自己 busy='seat' 时也不能再点（防连点）。但 busy 是字符串，
    // 传进 disabled 会让任何真值都把按钮锁死 —— 这里统一算成布尔值。
    const editable = row.canPick && !locked && !busy;
    const seatEl = h(`button.lob-seat${row.characterId ? '.is-set' : '.is-empty'}`, {
      type: 'button',
      disabled: !editable,
      title: editable
        ? row.isMe ? '点这里选自己的座位' : `给 ${row.username} 指派座位`
        : locked ? '已开局，座位锁定' : '只有房主能改别人的座位',
      style: row.charRole === 'teacher' ? { '--c': 'var(--accent-teacher)' } : {},
      onclick: () => openSeatPicker(row),
    },
      h('span.lob-seat-dot'),
      h('span.lob-seat-name', { text: row.characterId ? row.charName : '未选座位' }),
      h('span.lob-seat-tag', { text: row.characterId ? (row.charRole === 'teacher' ? '老师' : '学生') : '点这里选' }));
    const isOwner = row.isOwner;
    const canKick = !row.isOwner && isOwner() && !locked;
    return h(`li.lob-row${isOwner ? '.is-owner' : ''}${row.isMe ? '.is-me' : ''}${editable ? '.is-editable' : ''}`, {},
      h(`span.lob-dot${row.online ? '.on' : ''}`, { title: row.online ? '在线' : '离线' }),
      h('span.lob-name', { text: row.username }),
      h('span.lob-role', { text: isOwner ? '房主' : row.isMe ? '你' : '观战' }),
      seatEl,
      canKick
        ? h('button.btn.icon.sm.lob-op', {
          type: 'button', title: `把 ${row.username} 请出房间`,
          disabled: roomState.busy === 'kick',
          onclick: () => doRoomOp('kick', row),
        }, icon('exit', 'sm'))
        : null);
  };

  /**
   * 房主的「房间参数」区：单局时长 / 目标分。
   * 两个输入框都空着 = 什么都没改（settingsPatch 返回空 body，doSettingsSave 直接不请求），
   * 所以"恢复默认"不需要额外按钮：清空两个框再点保存即可。
   */
  const settingsForm = (busy) => {
    const cur = roomState.settings ?? {};
    const def = store.lobby?.round ?? {};
    const minutes = Number.isFinite(Number(cur.durationMs)) && Number(cur.durationMs) > 0
      ? String(Math.round(Number(cur.durationMs) / 60000))
      : '';
    const score = Number.isFinite(Number(cur.targetScore)) && Number(cur.targetScore) > 0 ? String(Math.round(Number(cur.targetScore))) : '';
    const mLimit = h('input.input.lob-num', { type: 'number', min: '0.5', max: '240', step: '0.5', value: minutes, placeholder: String(Math.round(Number(def.durationMs ?? 0) / 60000) || 10), 'aria-label': '单局时长（分钟）' });
    const sLimit = h('input.input.lob-num', { type: 'number', min: '0', max: '1000000', step: '10', value: score, placeholder: String(def.targetScore ?? 0), 'aria-label': '目标分（0 = 不限）' });
    const disabled = roomState.started === true || Boolean(busy);
    return h('div.lob-sec.lob-settings', {},
      h('div.lob-sec-title', {}, '房间参数', h('span.lob-sec-hint', { text: settingsLabel(roomState.settings, { durationMs: def.durationMs, targetScore: def.targetScore }) })),
      h('div.lob-param-row', {},
        h('label.lob-param', {}, h('span.lob-param-label', { text: '单局（分钟）' }), mLimit),
        h('label.lob-param', {}, h('span.lob-param-label', { text: '目标分（0 不限）' }), sLimit),
        h('button.btn.sm.lob-param-save', {
          type: 'button',
          disabled,
          title: disabled ? '已开局，参数锁定' : '保存后从下一局开始生效',
          onclick: () => doSettingsSave(mLimit.value, sLimit.value),
        }, busy === 'settings' ? '保存中…' : '保存')),
      h('div.lob-foot', { text: '两个框都留空 = 不修改；清空再保存就回到配置默认值。' }));
  };

  /** 一行入房申请（仅房主可见）：名字 + 同意 + 踢出（拒绝）。 */
  const requestRow = (p) => h('li.lob-req', {},
    h('span.lob-req-name', { text: p.username }),
    h('span.lob-req-tag', { text: '申请入房' }),
    h('div.lob-req-ops', {},
      h('button.btn.sm.lob-op', {
        type: 'button', title: `同意 ${p.username} 进入房间`,
        disabled: Boolean(roomState.busy),
        onclick: () => doRoomOp('approve', p),
      }, '同意'),
      h('button.btn.sm.lob-op.is-danger', {
        type: 'button', title: `拒绝 ${p.username} 的申请`,
        disabled: Boolean(roomState.busy),
        onclick: () => doRoomOp('reject', p),
      }, '踢出')));

  const renderPlayersPanel = () => {
    if (!roomState.open || !roomState.roomId) {
      roomPanelEl.hidden = true;
      roomBadgeEl.setAttribute('aria-expanded', 'false');
      return null;
    }
    const list = normalizeLobbyPlayers(roomState.players, roomState.roomId);
    const groups = splitLobbyPlayers(list);
    // 管理权（开局/踢人/审批/参数）看房主身份；"我有没有座位角色"只影响观战提示与轮询。
    const canManage = isOwner();
    const seat = isSeat();
    // 待审批的人不算"在房间里的人"：他们还没鉴权通过，混进成员列表会让人以为房间里多了个人
    const members = [...(groups.owner ? [groups.owner] : []), ...groups.spectators];
    const emptyRow = [h('li.lob-empty', { text: roomState.players === null ? '正在拉取玩家列表…' : '房间里只有你一个人' })];
    const st = startButtonState({ seat: canManage, started: roomState.started }, Boolean(roomState.busy));
    const locks = roomLockNote(roomState.started, groups.pending.length);
    // 座位表：谁坐哪儿 + 还差谁没坐。房主开局前要能一眼看出"还差 2 个人没选座位"。
    const seats = seatRowsNow();
    const sum = seatSummary(seats);
    const busy = roomState.busy;
    // 座位表为空（玩家列表还没到）时退回占位行 —— 光秃秃一个空 <ul> 会让人以为功能坏了
    const seatRowsEls = seats.length ? seats.map((r) => seatRow(r, busy)) : emptyRow;
    roomPanelEl.hidden = false;
    roomBadgeEl.setAttribute('aria-expanded', 'true');
    roomPanelEl.replaceChildren(
      h('div.lob-head', {},
        h('div', {}, h('div.lob-title', { text: `房间 ${roomState.roomId}` }),
          h('div.lob-sub', {
            text: `${countOnline(list)} 人在线 · ${canManage ? (roomState.started ? '你是房主 · 已开局' : '你是房主（可以开始游戏）') : seat ? '你是玩家（只看不操作）' : '你是观战者（先选座位）'}`,
          })),
        h('button.btn.icon.sm', { type: 'button', title: '收起', onclick: () => { roomState.open = false; renderRoomUi(); } }, icon('close', 'sm'))),
      // ① 座位表：每一行 = 一个成员，右边是他坐的角色（房主/自己可点）
      h('div.lob-sec', {},
        h('div.lob-sec-title', {}, '座位',
          seats.length
            ? h('span.lob-sec-hint', { text: sum.unseated.length ? `还差 ${sum.unseated.length} 人没选座位` : '全员已就座' })
            : null),
        h('ul.lob-list.lob-seats', {}, ...seatRowsEls)),
      // ② 房间参数（仅房主；开局后只读）
      ...(canManage && !roomState.started ? [settingsForm(busy)] : []),
      // ② 开始游戏：房主可点，观战者 disabled（文案「等待房主开始」）
      // 注意：条件子节点必须靠 ...[] 展开来省略 —— replaceChildren 是原生方法，不会像 h() 那样跳过 null，
      // 传进去的 null 会被当成字符串「null」插进 DOM（已实测复现）。
      h('div.lob-start', {},
        h('button.btn.primary.sm.lob-start-btn', {
          type: 'button', disabled: st.disabled, onclick: doStartGame,
        }, st.text),
        ...(st.locked ? [h('span.lob-lock', { text: '已开局' })] : [])),
      ...(locks ? [h('div.lob-lockline', { text: locks })] : []),
      // ③ 入房申请区（仅房主可见；观战者连这个区块都不该看到）
      // 同样必须用 ...[] 展开：replaceChildren 会把 null 当字符串插进 DOM。
      ...(canManage
        ? [h('div.lob-reqbox', {},
          h('div.lob-sec-title', { text: `入房申请${groups.pending.length ? ` · ${groups.pending.length}` : ''}` }),
          groups.pending.length
            ? h('ul.lob-reqlist', {}, ...groups.pending.map(requestRow))
            : h('div.lob-req-empty', { text: '暂无入房申请' }))]
        : []),
      // ④ 清除房间（仅房主）：停止当前这一局并把房间从服务器上删掉。
      // 放在最下面、用 danger 样式，和上面的日常操作拉开距离——它不可撤销。
      ...(canManage
        ? [h('div.lob-danger', {},
          h('button.btn.danger.sm.lob-close-btn', {
            type: 'button',
            disabled: roomState.busy === 'close',
            title: '停止当前房间并删除（房间号作废，房间里的所有人都会回大厅）',
            onclick: doCloseRoom,
          }, roomState.busy === 'close' ? '正在清除…' : '清除房间'))]
        : []),
      h('div.lob-foot', {
        text: canManage
          ? '座位可以随时改；被开局锁死后要等这一局结束。有人申请进房时这里才看得到申请。'
          : '点自己那一行选座位就能进游戏；开始游戏与房间参数只归房主。',
      }),
    );
    // 面板显隐决定轮询开关（收起就停，别在后台空转）
    syncPlayersPoll();
    return roomPanelEl;
  };

  /** 一次完整重画：徽章 → 面板（面板内部顺带同步轮询开关）。 */
  const renderRoomUi = () => {
    const text = roomBadgeText({ roomId: roomState.roomId, players: roomState.players, isSpectator: net.role === 'spectator' });
    roomBadgeEl.hidden = !text;
    if (text) roomBadgeEl.replaceChildren(icon('door', 'sm'), h('span', { text }));
    roomBadgeEl.classList.toggle('is-spectator', net.role === 'spectator' && Boolean(text));
    roomBadgeEl.setAttribute('aria-expanded', String(roomState.open && Boolean(text)));
    renderPlayersPanel();
    // 座位自愈（v0.10）：握手那一刻服务端按座位表算 seat，玩家可能是「先连进房间、之后才选座位」，
    // 也可能开局后座位表才补齐 —— 一旦我这一行真有角色而本地 seat 还是 false，
    // 就把服务端推来的座位认下来（这跟"我是不是房主"是两件事，别混）。
    if (roomState.seat !== true && myRoomName()) {
      const mine = seatRowsNow().find((r) => r.isMe && r.characterId);
      if (mine) roomState.seat = true;
    }
  };

  /**
   * 进房成功：擦地址栏 + 落 sessionStorage + 更新徽章。
   * 只在 welcome.room 存在时动作（单机 /ws 的 welcome 没有 room，一切保持原样）。
   */
  const adoptRoom = (welcome) => {
    const cred = roomCredentialFrom(welcome, net.search);
    if (!cred) return;
    roomState.roomId = cred.roomid;
    roomState.seat = welcome?.room?.seat === true;
    roomState.isOwner = welcome?.room?.isOwner === true;
    roomState.error = '';
    // 先写 sessionStorage 再擦地址栏：万一 replaceState 抛了，刷新也还能靠 sessionStorage 接回来
    net.setRoomCredential(cred);
    scrubAddressBar(cred.roomid);
    // 重连用的 query 必须仍是**完整**进房参数（type/token/id/roomid/invcode/username）。
    // 曾经这里写成 scrubbedQuery(roomid)（= 只留 ?room=…），结果是：地址栏干净了，但之后每次
    // 断线重连 buildConnectionUrl 都判定「不是进房 query」→ 退回单机 /ws。单机通道里 welcome 不带 room，
    // 且它的 role 由「首个连接=控制端」老规则决定：只要服务端还有一条连接活着（比如另一窗口、
    // 或上一个还没关闭的 socket），新连上来的就直接是 spectator，于是界面显示「观战中」、开不了战斗。
    // token/id 本来就已经在 sessionStorage 里了，重连带它们不额外泄露（地址栏仍然是 ?room=…）。
    net.search = resolveSearch({ search: '', stored: readRoomCredential() }).search || scrubbedQuery(cred.roomid);
    roomState.players = Array.isArray(welcome?.players) ? welcome.players : null;
    // 房主一进房就把房间视图展开：用户第一眼要看到"都有谁"，而不是自己去点徽章。
    // 观战者的面板没有按钮，展开只会挡住画面，所以不自动开。
    if (roomState.isOwner) roomState.open = true;
    roomState.started = welcome?.room?.started === true;
    roomState.pendingCount = Number(welcome?.room?.pendingCount) || 0;
    roomState.fromPoll = false;
    // 座位制（v0.9）：welcome.room 里带 seats / settings，房间内用户名决定座位表里"我"是哪一行
    roomState.username = String(welcome?.room?.username ?? cred.username ?? '');
    adoptRoomView(welcome?.room);
    renderRoomUi();
    // 横幅优先级：进房成功 > 夺权提示。房间里的观战者是正常座位，本窗口不是"被抢了控制权"。
    setBanner(null);
    if (!roomState.isOwner) toast.show('你已进入房间：选完座位，等房主开始游戏就能操作', 'warn', 'eye', 4500);
    // 进房即弹选座：等一拍让 welcome 带的座位表 / 玩家列表先落进 roomState，
    // 这样弹窗里「谁已经坐了哪个角色」才是准的（用户原话：「加入房间时自动弹窗让你选择」）。
    if (!roomState.started && roomState.seat !== true) setTimeout(() => popSeatPicker(), 400);
  };

  /**
   * 连不上 / 被拒时的诊断，分三层，从最准往下退：
   *   ① GET /api/net/room/check?<和 /lobby 一样的 query>：只校验不建房，回真实 400/404/501 + code，
   *      文案由 describeLobbyError(status, code) 的 7 个 code 映射表直接给（不靠状态码猜）；
   *   ② 接口不可用（老后端 / 网络断）时退回 GET /api/net/room?roomid= 只判断"房间在不在"；
   *   ③ 都问不出来就用 describeLobbyError(0, closeReason) 的 close(1006) 兜底文案。
   * 返回值：{ text, fatal }。fatal=false 表示"参数本身没问题，是网络/限流，可以继续重连"。
   */
  const diagnoseLobby = async (detail) => {
    const roomId = roomState.roomId || readScrubbedRoomId(location.search);
    const fallback = describeLobbyError(0, detail?.reason ?? '', { roomId });
    const body = await net.checkRoom();
    if (body?.ok) {
      // 探测说参数没问题，但房间号确实查不到（room:null）——最常见的原因是房主点了「清除房间」。
      // /api/net/room/check 是"预探测"：对不存在的房间号它答的是"这组参数可以用来建房"，
      // 所以这里必须补一次存在性判断，否则房主清除房间后，其他人只会看到"网络不稳定，正在重连"，
      // 永远挂着重连、也不会跳回大厅。
      if (roomId && !body.room) {
        return { text: describeLobbyError(404, 'ROOM_NOT_FOUND', { roomId }), fatal: true, notFound: true };
      }
      // 探测说参数没问题 → 不是改链接能解决的（网络抖动/限流），别把"进房失败"钉在用户脸上
      return { text: '网络不稳定，正在重新连接房间…', fatal: false };
    }
    if (body && body.code) {
      return { text: describeLobbyError(body.status, body.code, { roomId: body.room?.id ?? roomId }), fatal: isFatalLobbyCode(body.code) };
    }
    if (roomId) {
      try {
        const r = await fetch(`/api/net/room?roomid=${encodeURIComponent(roomId)}`);
        const j = await r.json().catch(() => ({}));
        if (j && j.ok === false) return { text: describeLobbyError(404, 'ROOM_NOT_FOUND', { roomId }), fatal: true, notFound: true };
      } catch {
        /* 接口也没有：走最后一句兜底 */
      }
    }
    return { text: fallback, fatal: true };
  };

  net.addEventListener('welcome', (e) => adoptRoom(e.detail));
  net.addEventListener('players', (e) => {
    // 推送优先：服务端每次成员变化都会广播，拿到推送就把"这一轮是轮询来的"标记清掉，
    // 免得下一次 3 秒轮询把服务端更旧的快照盖回去。
    roomState.players = Array.isArray(e.detail) ? e.detail : net.players;
    roomState.fromPoll = false;
    roomState.pendingCount = countPending(roomState.players);
    renderRoomUi();
  });
  // 鉴权被拒（服务端在 upgrade 阶段回 4xx）：停下来，把原因钉在横幅上，别再自动重连打服务器
  net.addEventListener('lobby-rejected', async (e) => {
    if (roomState.error) return;
    roomState.error = '正在核对房间信息…';
    setBanner(roomState.error);
    const reason = await diagnoseLobby(e.detail);
    if (!reason.fatal) {
      // 只是网络/限流：横幅交给 NetClient 的'connection'事件，别钉一句"进房失败"
      roomState.error = '';
      renderRoomUi();
      return;
    }
    roomState.error = `进房失败：${reason.text}`;
    setBanner(roomState.error);
    // 房间已经没了（最常见：房主点了「清除房间」）：把本地房间凭据一起丢掉，地址栏也擦干净，
    // 否则下次刷新还会拿着这个作废的房间号去连，横幅永远停在这句红字上。
    if (reason.notFound) {
      try {
        sessionStorage.removeItem(ROOM_KEY);
      } catch {
        /* 隐私模式：忽略 */
      }
      roomState.roomId = '';
      roomState.isOwner = false;
      roomState.seat = false;
      scrubAddressBar('');
    }
    renderRoomUi();
  });

  // 断线重连期间徽章会短暂骗人（连的还是 /lobby，但 players 是上一轮的快照），
  // 这里把"正在连"和"真的在房里"分开：没 welcomed 就先把列表标成待更新。
  net.addEventListener('reconnecting', () => {
    if (!roomState.roomId) return;
    roomState.players = net.players.length ? net.players : roomState.players;
    renderRoomUi();
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
  // 地址栏被擦成 ?room=123456 之后刷新：完整凭据还在 sessionStorage 里，NetClient 构造函数里
  // 的 resolveSearch 已经把它接回来了。这里只把房间号同步给 UI，好让徽章在 welcome 之前就有话说。
  const restoredRoomId = readScrubbedRoomId(location.search) || net.roomId;
  if (restoredRoomId) roomState.roomId = restoredRoomId;
  renderRoomUi();
  net.connect();
  /**
   * 独立窗口（NetPanel 用 window.open 打开的那个主游戏页）拿到房间凭据后立刻把房间面板展开：
   * 用户刚进屋第一眼要看到的是"都有谁"，而不是一个需要自己去点的徽章。
   * 只在真房主身上自动展开（观战者的面板没按钮，展开反而挡住画面）。
   * 只做一次：后续用户手动收起就不再自动弹开。
   */
  if (roomCredential().id) {
    const openOnJoin = () => {
      if (roomState.open) return;
      roomState.open = isOwner();
      renderRoomUi();
    };
    net.addEventListener('welcome', openOnJoin, { once: true });
    // welcome 可能已经在这之前就到了（NetClient 连接极快 / 页面被浏览器缓存），
    // 那时 once 监听器永远等不到第二次 welcome，面板就一直藏着。这里补一次直接判定。
    if (roomState.isOwner) openOnJoin();
  }
  // 调试入口：地址栏加 ?debug 时在控制台暴露只读镜像，便于排查
  if (new URLSearchParams(location.search).has('debug')) window.__jican = { store, net, renderer, itemBar, itemShop, hackPanel, netPanel };
}

boot().catch((err) => {
  document.body.textContent = `启动失败：${err.message}`;
  console.error(err);
});
