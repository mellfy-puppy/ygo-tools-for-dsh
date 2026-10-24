import assert from 'node:assert/strict';
import test from 'node:test';
import { formatCurrentState } from '../skill/runtime/src/tools/state-tools.js';

const POS_FACEUP_ATTACK = 0x1, POS_FACEUP_DEFENSE = 0x4, POS_FACEDOWN_DEFENSE = 0x8;
const TYPE_LINK_MONSTER = 0x4000021;
const monster = (code, sequence, position, attack, defense, baseAttack = attack, baseDefense = defense, type = 0x21) =>
  ({ code, sequence, position, type, attack, defense, baseAttack, baseDefense });
const state = (p0, p1 = []) => formatCurrentState({ p0Zones: { mzone: p0 }, p1Zones: { mzone: p1 } });

test('own monsters show current ATK/DEF, position and the original value when changed', () => {
  const s = state([monster(22420202, 0, POS_FACEUP_DEFENSE, 1000, 0, 2000, 0)]);
  const [delta] = s.player.monsterDetails;
  assert.equal(delta.position, '表侧守备表示');
  assert.equal(delta.attack, 1000);
  assert.equal(delta.baseAttack, 2000);
  assert.match(delta.summary, /P0 主怪兽区0 .* 表侧守备表示 攻1000（原本2000） \/ 守0$/);
  // The plain name list stays for existing consumers.
  assert.equal(s.player.monsters.length, 1);
});

test('unchanged stats are shown once and own face-down monsters still show stats', () => {
  const s = state([monster(1, 2, POS_FACEUP_ATTACK, 1800, 1500), monster(2, 3, POS_FACEDOWN_DEFENSE, 1200, 900)]);
  assert.match(s.player.monsterDetails[0].summary, /表侧攻击表示 攻1800 \/ 守1500$/);
  assert.match(s.player.monsterDetails[1].summary, /里侧守备表示 攻1200 \/ 守900$/);
});

test('opponent face-down monsters do not reveal ATK/DEF', () => {
  const s = state([], [monster(3, 1, POS_FACEDOWN_DEFENSE, 2500, 2100)]);
  const [hidden] = s.opponent.monsterDetails;
  assert.equal(hidden.attack, null);
  assert.equal(hidden.defense, null);
  assert.equal(hidden.zone, 'P1 主怪兽区1');
  assert.match(hidden.summary, /攻守不可见/);
});

test('link monsters have no DEF and "?" stats are shown as ?', () => {
  const s = state([monster(4, 5, POS_FACEUP_ATTACK, 1500, 0, 1500, 0, TYPE_LINK_MONSTER), monster(5, 0, POS_FACEUP_ATTACK, -2, -2)]);
  assert.equal(s.player.monsterDetails[0].defense, null);
  assert.match(s.player.monsterDetails[0].summary, /攻1500$/);
  assert.match(s.player.monsterDetails[1].summary, /攻\? \/ 守\?$/);
});

test('backends that only report card codes still list monsters without inventing stats', () => {
  const s = formatCurrentState({ p0: { mzone: [{ code: 77235086 }] }, p1: { mzone: [] } });
  const [detail] = s.player.monsterDetails;
  assert.equal(detail.attack, null);
  assert.equal(detail.position, null);
  assert.equal(detail.zone, 'P0 主怪兽区0');
});