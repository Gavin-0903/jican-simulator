import test from 'node:test';
import assert from 'node:assert/strict';

import { GUARDED_PHASES, shouldGuardTyping } from '../../client/js/util/typing-guard.js';
import { PHASE } from '../../shared/constants.js';

test('shouldGuardTyping: 只有对局中（PLAYING / PAUSED）为真', () => {
  assert.equal(shouldGuardTyping(PHASE.PLAYING), true);
  assert.equal(shouldGuardTyping(PHASE.PAUSED), true);
  assert.equal(shouldGuardTyping(PHASE.LOBBY), false);
  assert.equal(shouldGuardTyping(PHASE.ENDED), false);
});

test('shouldGuardTyping: 空值与未知阶段一律放行（不能因为状态还没到就锁死剪贴板）', () => {
  for (const v of [undefined, null, '', 'connecting', 'unknown', 0, false]) {
    assert.equal(shouldGuardTyping(v), false, `phase=${String(v)} 应该放行`);
  }
});

test('GUARDED_PHASES: 恰好是 PLAYING 与 PAUSED，不包含大厅/结算', () => {
  assert.deepEqual([...GUARDED_PHASES], [PHASE.PLAYING, PHASE.PAUSED]);
  assert.equal(GUARDED_PHASES.includes(PHASE.LOBBY), false);
  assert.equal(GUARDED_PHASES.includes(PHASE.ENDED), false);
});

test('GUARDED_PHASES 是冻结的只读常量（防止运行时被改坏）', () => {
  assert.equal(Object.isFrozen(GUARDED_PHASES), true);
});
