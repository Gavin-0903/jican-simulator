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

const $ = (id) => document.getElementById(id);
const PC_MODALS = new Set(['pc', 'score', 'jc']);

async function boot() {
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
  const lobby = new Lobby($('lobby'), store, net);
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

  const ui = {
    teacherMenu,
    get modalOpen() {
      return !!modals.kind;
    },
    escape() {
      if (teacherMenu.open) return teacherMenu.hide();
      if (stats.open) return stats.toggle();
      if (modals.kind) return modals.dismiss();
      if (store.phase === PHASE.PLAYING) net.send(MSG.PAUSE, { on: true });
    },
    toggleStats: () => stats.toggle(),
    toggleCamera: () => toast.show(renderer.toggleCamera() === 'follow' ? '镜头：跟随玩家' : '镜头：校园全景', 'info', 'camera', 1600),
    stepSpeed(dir) {
      const cur = SPEEDS.indexOf(store.game.speedMult ?? 1);
      const next = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, cur + dir))];
      if (next !== store.game.speedMult) net.send(MSG.SET_SPEED, { mult: next });
    },
  };

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
  const input = new InputManager({ svg: $('map'), store, net, renderer, ui });

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
  };
  store.addEventListener('phase', applyPhase);
  store.addEventListener('lobby', () => store.phase === PHASE.LOBBY && lobby.render());
  store.addEventListener('snapshot', () => renderer.ensureSprites());
  store.addEventListener('gameover', (e) => {
    teacherMenu.hide();
    gameover.show(e.detail);
  });
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
      default:
        return null;
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
      case 'close':
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
    toast.show(p.message, p.code === 'E_COOLDOWN' ? 'warn' : 'danger');
  });
  net.addEventListener('connection', (e) => {
    $('conn-banner').hidden = e.detail.connected;
  });
  net.addEventListener('welcome', () => {
    lobby.show(store.phase === PHASE.LOBBY);
  });

  // ---------------------------------------------------------------- 渲染循环
  const frame = (now) => {
    renderer.frame(now);
    hud.update(now);
    input.tick(now);
    if (teacherMenu.open && renderer.interactable?.id !== teacherMenu.targetId) teacherMenu.hide();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  lobby.show(true);
  net.connect();
  // 调试入口：地址栏加 ?debug 时在控制台暴露只读镜像，便于排查
  if (new URLSearchParams(location.search).has('debug')) window.__jican = { store, net, renderer };
}

boot().catch((err) => {
  document.body.textContent = `启动失败：${err.message}`;
  console.error(err);
});
