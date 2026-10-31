// JC 对话框：输入「自己的用户名」与分享数量 x（x ≤ 对方积分），服务端校验后转移积分。

import { MSG } from '/shared/constants.js';
import { h, icon, kbd } from '../util/dom.js';
import { forceEnglishInput } from '../util/ime.js';

export class JcDialog {
  constructor(modals, net, onBack) {
    this.modals = modals;
    this.net = net;
    this.onBack = onBack;
    this.error = null;
    this.lock = null;      // { el, until }：强密码锁定倒计时
    this.lockTimer = 0;
    this.lockedUntil = 0;  // performance.now() 时刻，> now 表示仍在破解中
  }

  show(p, myUsername) {
    const user = h('input.input', { id: 'jc-username', autocomplete: 'off', spellcheck: false, placeholder: '例如 s1-07', 'aria-label': '你的用户名' });
    const amount = h('input.input', { id: 'jc-amount', type: 'number', min: 1, max: Math.max(1, p.ownerScore), step: 1, inputmode: 'numeric', placeholder: `1 ~ ${p.ownerScore}`, 'aria-label': '分享数量' });
    this.error = h('div.form-error', { role: 'alert' });
    clearInterval(this.lockTimer);
    const submit = () => {
      if (this.locked()) return this.setError('这台电脑的强密码正在破解中，请等倒计时结束再提交');
      const raw = amount.value.trim();
      const n = raw === '' ? null : Number(raw);
      user.classList.toggle('invalid', !user.value.trim());
      amount.classList.toggle('invalid', !Number.isInteger(n) || n <= 0);
      if (!user.value.trim()) return this.setError('请输入你自己的用户名');
      if (!Number.isInteger(n) || n <= 0) return this.setError('数量必须是正整数');
      this.setError('');
      this.net.send(MSG.JC_COMMIT, { selfUsername: user.value.trim(), amount: n });
    };
    const onKey = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
    };
    user.addEventListener('keydown', onKey);
    amount.addEventListener('keydown', onKey);
    forceEnglishInput(user);
    forceEnglishInput(amount);
    // 强密码道具：服务端 dialog kind:'jc_locked' 或快照 me.unlockRemainMs 会让表单进入「破解中」状态
    this.lock = h('div.jc-lock', { hidden: true }, icon('shield', 'sm'), h('span.jc-lock-text'));
    // 刚打开表单时就带着解锁倒计时（快照里已有 unlockRemainMs，不必等下一次报错）
    const preRemain = Math.max(0, Number(p.unlockRemainMs) || 0);
    if (preRemain > 0) setTimeout(() => this.setLocked(preRemain), 0);
    this.modals.open('jc', {
      title: 'JC —— 分享积分',
      sub: `目标：${p.ownerName} 的电脑`,
      icon: 'target',
      tone: 'danger',
      onDismiss: () => this.onBack(),
      body: [
        h('div.kv', {}, h('dt', { text: '对方当前积分' }), h('dd', { text: String(p.ownerScore) }), h('dt', { text: '你的用户名' }), h('dd', { text: myUsername ?? '—' })),
        h('div.field', {}, h('label', { for: 'jc-username' }, h('span', { text: '你的用户名' }), h('span', { text: '积分会分享到这个账号' })), user),
        h('div.field', {}, h('label', { for: 'jc-amount' }, h('span', { text: '分享数量 x' }), h('span', { text: `≤ ${p.ownerScore}` })), amount),
        this.lock,
        this.error,
        h('div.note.warn', {}, icon('eye', 'sm'), h('span', { text: '提交的一瞬间若在老师视野内且未被遮挡，可能被目击并扣除相应积分。' })),
      ],
      foot: [
        h('button.btn.ghost', { onclick: () => this.onBack() }, '返回', kbd('Esc')),
        h('div.spacer'),
        h('button.btn.danger', { onclick: submit }, icon('target', 'sm'), '确认分享', kbd('Enter')),
      ],
    });
    setTimeout(() => user.focus(), 40);
  }

  setError(text) {
    if (this.error) this.error.textContent = text ?? '';
  }

  /** 强密码道具：服务端要求先解锁 remainMs 毫秒，期间表单锁定并显示倒计时。 */
  setLocked(remainMs) {
    const ms = Math.max(0, Number(remainMs) || 0);
    this.lockedUntil = performance.now() + ms;
    if (!this.lock) return;
    this.lock.hidden = false;
    clearInterval(this.lockTimer);
    const tick = () => {
      const left = this.lockedUntil - performance.now();
      if (left <= 0) {
        clearInterval(this.lockTimer);
        this.lock.hidden = true;
        this.lockedUntil = 0;
        if (this.error) this.error.textContent = '';
        return;
      }
      const text = this.lock.querySelector('.jc-lock-text');
      if (text) text.textContent = `这台电脑上了强密码：破解中，还需 ${(left / 1000).toFixed(1)} 秒`;
    };
    tick();
    this.lockTimer = setInterval(tick, 100);
  }

  /** 是否仍在破解中。 */
  locked() {
    return this.lockedUntil > performance.now();
  }
}