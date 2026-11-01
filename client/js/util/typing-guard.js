// 「游戏内输入管控」的阶段口径：只有真的进了对局才禁用复制粘贴 / 强制英文输入。
// 单独成文件是为了能被 node --test 直接测（ime.js 顶层用了 window/document，只能在浏览器里跑）。
// 注意：这里用相对路径导入，浏览器端也走同一份相对解析（client/js/util → /shared/constants.js）。

import { PHASE } from '../../../shared/constants.js';

/** 对局中的两个阶段（暂停也算在对局里：暂停面板背后就是游戏画面，粘贴没有意义）。 */
export const GUARDED_PHASES = Object.freeze([PHASE.PLAYING, PHASE.PAUSED]);

/**
 * 现在是否应该拦截复制粘贴 / 强制英文键盘。
 * @param {string} phase 当前阶段（store.phase）
 * @returns {boolean} true = 游戏内，禁用；false = 大厅 / 结算 / 未知，放行
 */
export function shouldGuardTyping(phase) {
  return GUARDED_PHASES.includes(String(phase || ''));
}
