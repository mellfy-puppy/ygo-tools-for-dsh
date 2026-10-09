import assert from 'node:assert/strict';
import test from 'node:test';
import { formatCurrentState } from '../skill/runtime/src/tools/state-tools.js';

const TYPE_LINK_MONSTER = 0x4000021;
const link = (code, sequence, marker) => ({ code, sequence, type: TYPE_LINK_MONSTER, link_marker: marker });
const zones = (snapshot) => formatCurrentState(snapshot).fieldContext;

test('Extra Monster Zone 5 bottom-left/bottom-right points to own Main Monster Zones 0 and 2', () => {
  // Interweaving Sheep (50277355): link marker 5 = bottom-left | bottom-right.
  const context = zones({ p0: { mzone: [link(50277355, 5, 0x005)] }, p1: { mzone: [] } });
  assert.deepEqual(context.linkMonsters[0].arrows, ['左下', '右下']);
  assert.deepEqual(context.currentLinkZones, ['P0 主怪兽区0', 'P0 主怪兽区2']);
});

test('Extra Monster Zone 6 bottom arrows cover own Main Monster Zones 2-4', () => {
  const context = zones({ p0: { mzone: [link(1, 6, 0x007)] }, p1: { mzone: [] } });
  assert.deepEqual(context.currentLinkZones, ['P0 主怪兽区2', 'P0 主怪兽区3', 'P0 主怪兽区4']);
});

test('Extra Monster Zone top arrows point into the opponent Main Monster Zones', () => {
  const context = zones({ p0: { mzone: [link(1, 5, 0x1c0)] }, p1: { mzone: [] } });
  assert.deepEqual(context.currentLinkZones, ['P1 主怪兽区4', 'P1 主怪兽区3', 'P1 主怪兽区2']);
});

test('Main Monster Zone edge diagonals reach the Extra Monster Zones', () => {
  const context = zones({ p0: { mzone: [link(1, 0, 0x100), link(2, 4, 0x040)] }, p1: { mzone: [] } });
  assert.deepEqual(context.currentLinkZones, ['P0 额外怪兽区5', 'P0 额外怪兽区6']);
});

test('Opponent link monsters are resolved from their own side', () => {
  const context = zones({ p0: { mzone: [] }, p1: { mzone: [link(1, 5, 0x002)] } });
  assert.deepEqual(context.currentLinkZones, ['P1 主怪兽区1']);
});
