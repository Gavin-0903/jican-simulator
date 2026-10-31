import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage } from '../../server/net/Protocol.js';

const env = (type, payload, extra = {}) => JSON.stringify({ v: 1, type, seq: 1, ts: 0, payload, ...extra });

test('合法消息通过校验', () => {
  for (const [type, payload] of [
    ['hello', { clientVersion: '0.1.0', sessionId: null, lastSeq: 3 }],
    ['join', { characterId: 's1-01', role: 'student', seed: 123 }],
    ['join', { resume: true }],
    ['input.move', { dir: { x: 0.71, y: -0.71 }, face: 1.2 }],
    ['input.action', { kind: 'enterPc', pcId: 'pc-c1-02' }],
    ['jc.commit', { selfUsername: 's1-01', amount: 20 }],
    ['set.speed', { mult: 2 }],
    ['pause', { on: true }],
    ['ping', {}],
  ]) {
    const r = parseMessage(env(type, payload));
    assert.equal(r.ok, true, `${type}: ${r.message}`);
  }
});

test('非法消息被拒绝并给出错误码', () => {
  const cases = [
    ['not json', 'E_BADMSG'],
    [JSON.stringify({ v: 2, type: 'ping', payload: {} }), 'E_PROTO'],
    [env('hack', {}), 'E_BADMSG'],
    [env('input.move', { dir: { x: 5, y: 0 } }), 'E_BADMSG'],
    [env('input.move', { dir: { x: 0, y: 0 }, extra: 1 }), 'E_BADMSG'],
    [env('input.action', { kind: 'deleteEverything' }), 'E_BADMSG'],
    [env('set.speed', { mult: 10 }), 'E_BADMSG'],
    [env('jc.commit', { selfUsername: 'x'.repeat(100), amount: 1 }), 'E_BADMSG'],
    [env('join', { seed: -1 }), 'E_BADMSG'],
  ];
  for (const [raw, code] of cases) {
    const r = parseMessage(raw);
    assert.equal(r.ok, false, raw);
    assert.equal(r.code, code, raw);
  }
  assert.equal(parseMessage('x'.repeat(5000), 4096).code, 'E_BADMSG');
});
