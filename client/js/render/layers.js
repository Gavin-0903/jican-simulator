// 图层管理（自底向上）。静态层只绘制一次；动态层按帧/事件更新。

import { s } from '../util/dom.js';

export const LAYER_ORDER = [
  'bg', // L0 地板、房间底色
  'zones', // L2 增益区呼吸高亮
  'lowshadow', // 低矮遮挡物（桌子、沙发）在其身后投下的短阴影（画在家具下面）
  'walls', // L1 墙体、门、家具
  'pcs', // L3 电脑与使用状态环
  'cones', // 老师视野扇形（被遮挡部分不绘制）
  'fog', // 视野遮罩：被遮挡区域显示为黑色
  'labels', // 房间名（浮在遮罩上方，方便辨认方位）
  'actors', // L4 角色（只显示视线内的角色）
  'fx', // L5 特效
  'overlay', // L6 玩家交互提示、进度环
];

export function createLayers(svg) {
  const layers = {};
  for (const id of LAYER_ORDER) {
    const g = s('g', { id: `layer-${id}` });
    if (id !== 'overlay') g.setAttribute('pointer-events', 'none');
    svg.append(g);
    layers[id] = g;
  }
  return layers;
}
