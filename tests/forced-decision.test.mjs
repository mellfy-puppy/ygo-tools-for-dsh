import assert from 'node:assert/strict';
import test from 'node:test';
import { forcedDecisionAction } from '../skill/backend/ygopro2-duel.mjs';

const pass = { label: '不连锁', kind: 'other', response: new Uint8Array([0xff, 0xff, 0xff, 0xff]) };
const chain = { label: '连锁发动[光子栗子]', kind: 'chain', response: new Uint8Array([0, 0, 0, 0]) };

test('a chain window whose only option is "不连锁" is answered automatically', () => {
  assert.equal(forcedDecisionAction({ actions: [pass] }), pass);
});

test('any real choice stays with the model', () => {
  assert.equal(forcedDecisionAction({ actions: [chain, pass] }), null, 'chain vs pass is a real choice');
  assert.equal(forcedDecisionAction({ actions: [] }), null);
  assert.equal(forcedDecisionAction({ terminal: true, actions: [pass] }), null);
  assert.equal(forcedDecisionAction({ factorizedSelection: true, actions: [pass] }), null, 'factorized selections need selectionIndexes');
  assert.equal(forcedDecisionAction({ actions: [{ label: 'card', kind: 'factorized_select_card_candidate', response: new Uint8Array([0]) }] }), null);
  assert.equal(forcedDecisionAction({ actions: [{ label: 'no bytes', kind: 'other' }] }), null, 'an action without a protocol response is never sent');
});

test('a single forced chain (no pass option) is also answered', () => {
  assert.equal(forcedDecisionAction({ actions: [chain] }), chain);
});
