// 模板台词（LLM 降级时的兜底结果，与 LLM 输出同结构）。

export const LINES = {
  ask: ['{teacher}，这道题我想了一晚上……', '老师，能再讲一遍吗？', '这个公式我总记混……', '{teacher}，我有个问题！'],
  answer: ['你看，这里先移项。', '问得好，思路是对的。', '回去把错题整理一下。', '下次上课我再讲一遍。'],
  flatter: ['{teacher}今天的板书太好看了！', '老师讲得比网课还清楚！', '{teacher}，给您带了杯热水~', '全班最喜欢您的课！'],
  flatter_reject: ['少来这套，回去写作业。', '心思用在学习上。', '马屁拍得太明显了。'],
  catch: ['{student}，你在干什么！', '别人的电脑不能乱动！', '{student}，跟我去趟办公室。'],
  caught: ['我、我只是路过……', '老师我错了……', '完了完了……'],
  warn: ['{student}，别在别人座位边转悠。', '回自己座位去！'],
  patrol: ['都认真点，我看着呢。', '谁的屏幕还亮着？', '保持安静。'],
  chat: ['听说厕所能加速？', '今天谁被 JC 了？', '感觉老师在盯着我……', '你积分多少？不告诉你~', '聊天室真舒服。'],
  idle: ['好无聊啊……', '去哪转转呢', '感觉有人在看我', '饿了……'],
  victim: ['我的分呢？？', '谁动了我的电脑！'],
};

const SITUATIONS = {
  ask: (v) => `你在办公室向${v.teacher ?? '老师'}请教问题`,
  answer: (v) => `学生${v.student ?? ''}向你请教问题，你在解答`,
  flatter: (v) => `你在讨好${v.teacher ?? '老师'}，想让老师给你加分`,
  flatter_reject: (v) => `学生${v.student ?? ''}拍你马屁但被你识破了`,
  catch: (v) => `你当场抓到学生${v.student ?? ''}在动别人的电脑`,
  caught: (v) => `你被${v.teacher ?? '老师'}抓到在动别人的电脑`,
  warn: (v) => `你发现学生${v.student ?? ''}在别人座位附近鬼鬼祟祟`,
  patrol: () => '你在巡视机房',
  chat: () => '你在聊天室和同学闲聊',
  idle: () => '你在校园里闲逛',
  victim: () => '你发现自己的积分少了',
};

export function situationOf(kind, vars) {
  return (SITUATIONS[kind] ?? SITUATIONS.idle)(vars || {});
}

export function renderLine(kind, vars, rng) {
  const list = LINES[kind] ?? LINES.idle;
  const tpl = list[Math.floor(rng.next() * list.length)];
  return tpl.replace(/\{(\w+)\}/g, (_, k) => String(vars?.[k] ?? ''));
}

export function summaryTemplate(state, ranking) {
  const s = state.stats;
  const top = ranking.students[0];
  const richest = ranking.teachers[0];
  const parts = [`本局共发生 ${s.jc} 次 JC，转移积分 ${s.jcAmount} 分，老师抓获 ${s.catches} 次。`];
  if (top) parts.push(`学生第一名是 ${top.name}（${top.score} 分）。`);
  if (richest) parts.push(`工资最高的是 ${richest.name}（${richest.score}￥）。`);
  if (s.eliminations) parts.push(`有 ${s.eliminations} 名学生被淘汰。`);
  return parts.join('');
}
