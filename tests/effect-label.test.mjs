import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createCardTextRuntime } = require('../skill/runtime/combo-simulator.cjs');
const cardsDb = fileURLToPath(new URL('../skill/resources/lib/cards.cdb', import.meta.url));
const HAND = 0x02, GRAVE = 0x10;
const METEONIS = 22398665; // 流星辉巧群: ① has no 发动/才能/场合 keyword, ② is a graveyard effect

test('activation from hand is labelled with the effect that can be used from hand', async () => {
  const { cardText, db } = await createCardTextRuntime(cardsDb);
  try {
    const fromHand = cardText.getEffectDetails(METEONIS, METEONIS * 16, { location: HAND });
    assert.equal(fromHand.marker, '①');
    assert.match(fromHand.text, /仪式召唤/);
    const fromGrave = cardText.getEffectDetails(METEONIS, METEONIS * 16 + 1, { location: GRAVE });
    assert.equal(fromGrave.marker, '②');
    assert.match(fromGrave.text, /墓地存在/);
  } finally {
    db.close();
  }
});

test('a graveyard-only effect is never offered as the label for a hand activation', async () => {
  const { cardText, db } = await createCardTextRuntime(cardsDb);
  try {
    const details = cardText.getEffectDetails(METEONIS, METEONIS * 16, { location: HAND });
    assert.doesNotMatch(details.text, /这张卡在墓地存在/);
  } finally {
    db.close();
  }
});
test('zone decides between effects when the script string is shared, wrong or only names the result', async () => {
  const { cardText, db } = await createCardTextRuntime(cardsDb);
  const REMOVED = 0x20;
  const at = (id, index, location) => cardText.getEffectDetails(id, id * 16 + index, { location }).marker;
  try {
    // 交叉调试瓢虫: both effects use Stringid(9097866,0) "特殊召唤"; the graveyard one is ②.
    assert.equal(at(9097866, 0, HAND), '①');
    assert.equal(at(9097866, 0, GRAVE), '②');
    // 天启之蔷薇钟: the script gives the Activate Stringid 1 ("特殊召唤") by mistake; from hand it is still ①.
    assert.equal(at(80196387, 1, HAND), '①');
    // 晴天气 锈红: "除外的这张卡特殊召唤" is the banished ②, not the graveyard ①.
    assert.equal(at(54895237, 1, REMOVED), '②');
    assert.equal(at(54895237, 0, GRAVE), '①');
  } finally {
    db.close();
  }
});