// 道具定义与数值换算（纯前端展示用；一切数值以服务端 config/balance.json + 快照为准）。
// 服务端 ItemSystem 是唯一的判定方：这里的定价公式只用于「事先告诉玩家要花多少钱」，
// 真正扣费金额以服务端 dialog / EVENT 里的 gold 为准。

/** 道具展示顺序与文案；配置里的缺项会自动隐藏（优雅降级）。 */
export const ITEM_ORDER = ['freeze', 'buyoff', 'password', 'hourglass', 'hackbook'];

export const ITEM_META = {
  freeze: { name: '定格手枪', icon: 'target', tone: 'info', desc: '指定一个角色定格 Lv 秒（点击画面里的角色）' },
  buyoff: { name: '买通老师', icon: 'eye', tone: 'gold', desc: '老师看到你 JC 时只有 Lv×10% 概率真正生效' },
  password: { name: '强密码', icon: 'shield', tone: 'ok', desc: '买一次永久持有：别人操作你的电脑前要先解锁 Lv 秒' },
  hourglass: { name: '时间沙漏', icon: 'clock', tone: 'warn', desc: '除你之外全场定格 Lv 秒；每局 ceil(Lv/2) 次' },
  hackbook: { name: '黑客手册', icon: 'book', tone: 'danger', desc: '增/改任意角色积分或工资，风险极高' },
};

/** 与道具无关的「最大使用次数」哨兵值，超过它视为无限次。 */
export const UNLIMITED = 1000000;

/** 安全取整（负数与非法值一律视为 0，避免脏数据把 UI 撑坏）。 */
const clampInt = (v) => {
  const n = Math.floor(Number(v) || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * 评估 "Lv * 50" 这类价格模板（与服务端 ItemSystem.evalCost 同语义）：
 * 只允许数字、Lv、空白与 + - * / ( )。不 eval —— 配置来自可热重载的 JSON。
 * {Lv} 写法也兼容（需求书里的旧模板）。
 */
export function evalCost(expr, lv) {
  if (typeof expr === 'number') return Math.max(0, Math.round(expr));
  if (typeof expr !== 'string') return 0;
  let t = expr.trim().replace(/\{Lv\}/g, 'Lv');
  // 隐式乘法归一：'50 Lv' / '5(' / ')Lv' → 显式 '*'
  t = t.replace(/(\d)\s*(?=[A-Za-z(])/g, '$1*').replace(/\)\s*(?=[\dA-Za-z(])/g, ')*');
  const tokens = t.match(/\d+(?:\.\d+)?|Lv|[+\-*/()]/g) ?? [];
  if (!tokens.length) return 0;
  let i = 0;
  const unary = () => {
    const tok = tokens[i++];
    if (tok === '-') return -unary();
    if (tok === '(') {
      const v = sum();
      if (tokens[i] === ')') i++;
      return v;
    }
    if (tok === 'Lv') return lv;
    return Number(tok) || 0;
  };
  const product = () => {
    let v = unary();
    while (tokens[i] === '*' || tokens[i] === '/') {
      const op = tokens[i++];
      const r = unary();
      v = op === '*' ? v * r : r === 0 ? 0 : v / r;
    }
    return v;
  };
  const sum = () => {
    let v = product();
    while (tokens[i] === '+' || tokens[i] === '-') {
      const op = tokens[i++];
      const r = product();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const v = sum();
  return Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;
}

/** 把配置里的价格模板展开成数字：Lv → 当前等级。 */
export function priceOf(template, level, base = 0) {
  if (typeof template === 'number') return template;
  const v = evalCost(template, Math.max(0, Math.floor(Number(level) || 0)));
  return v || base;
}

/** 下级升级价格（配置里都写作 Lv，代表「当前等级」；与服务端 upgrade 一致）。 */
export function upgradePriceOf(cfg, level) {
  if (!cfg) return 0;
  return priceOf(cfg.upLevelPrice, level, 0);
}

/** 「购买使用次数」价格（仅 freeze 有 perUsePrice）。 */
export function usePriceOf(cfg, level) {
  if (!cfg?.perUsePrice) return 0;
  return priceOf(cfg.perUsePrice, Math.max(1, level), 0);
}

/** 从快照里取某道具的 { lv, uses }。 */
export function slotState(me, itemId) {
  const it = me?.items?.[itemId];
  return { lv: clampInt(it?.lv), uses: clampInt(it?.uses) };
}

/** 时间沙漏每局可用次数：ceil(Lv/2)（与服务端 hourglassMaxPerRound 一致）。 */
export function hourglassLimit(lv) {
  return Math.max(1, Math.ceil(clampInt(lv) / 2));
}

/** 展示用的描述补上当前等级给出的实际效果（全部按服务端公式）。 */
export function effectText(itemId, lv, cfg = null) {
  const L = clampInt(lv);
  switch (itemId) {
    case 'freeze':
      return L ? `定格 ${Math.round(((cfg?.freezeMsPerLevel ?? 1000) * L) / 100) / 10} 秒` : '定格 0 秒（先购买）';
    case 'buyoff':
      return L ? `老师只有 ${Math.max(0, 100 - (cfg?.seeThroughPctPerLevel ?? 10) * L)}% 概率看穿` : '未持有';
    case 'password':
      return L ? `别人操作你的电脑前需解锁 ${Math.round(((cfg?.lockMsPerLevel ?? 1000) * L) / 100) / 10} 秒` : '未持有';
    case 'hourglass':
      return L ? `除你外全员定格 ${Math.round(((cfg?.freezeMsPerLevel ?? 1000) * L) / 100) / 10} 秒 · 每局 ${hourglassLimit(L)} 次` : '未持有';
    case 'hackbook':
      return `失败 ${hackFailPct(cfg, L)}% · 被开除 ${hackExpelPct(cfg, L)}%`;
    default:
      return '';
  }
}

/** 黑客失败概率（与服务端 hackFailPct 一致）。 */
export function hackFailPct(cfg, lv) {
  const v = (cfg?.failPctBase ?? 100) - (cfg?.failPctPerLevel ?? 10) * clampInt(lv);
  return Math.max(0, Math.min(100, Number(v) || 0));
}

/** 黑客被开除概率（与服务端 hackExpelPct 一致）。 */
export function hackExpelPct(cfg, lv) {
  const v = (cfg?.expelPctBase ?? 100) - (cfg?.expelPctPerLevel ?? 8) * clampInt(lv);
  return Math.max(0, Math.min(100, Number(v) || 0));
}

/** 使用次数展示（无限次显示 ∞）。 */
export function usesText(uses, maxUses) {
  const u = clampInt(uses);
  if (u >= maxUses || u >= UNLIMITED) return '∞';
  return String(u);
}

/** 道具栏可用性：次数 > 0，且没触及「每局次数上限」。 */
export function canUseSlot(me, itemId, cfg = null) {
  const { lv, uses } = slotState(me, itemId);
  if (lv <= 0 || uses <= 0) return false;
  const used = clampInt(me?.itemRoundCount?.[itemId]);
  if (itemId === 'hourglass') return used < hourglassLimit(lv);
  if (itemId === 'hackbook') return used < Math.max(1, Math.floor(Number(cfg?.maxPerRound) || 1));
  if (itemId === 'buyoff' || itemId === 'password') return true; // 被动持有，反复使用只是提示
  return true;
}

/** 从大厅规则里读道具配置；读不到（服务端还没下发）时返回 null，UI 应隐藏商店与道具栏。 */
export function itemsConfig(store) {
  const items = store?.lobby?.rules?.items;
  if (!items || typeof items !== 'object') return null;
  const keys = ITEM_ORDER.filter((k) => items[k]);
  if (!keys.length) return null;
  return { items, keys };
}

/** 某道具的配置；读不到返回 null。 */
export function itemConfig(store, itemId) {
  const items = itemsConfig(store)?.items;
  return items?.[itemId] ?? null;
}
