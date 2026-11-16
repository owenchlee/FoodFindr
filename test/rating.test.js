const test = require('node:test');
const assert = require('node:assert');
const { shrunkRating } = require('../server/lib/rating');
const { pickRandomTopPool, chooseInstantPick } = require('../server/lib/pick');

const r = (id, rating, ratingCount) => ({ id, name: id, cuisine: 'Thai', rating, ratingCount });
const tiny = r('tiny', 5.0, 4);
const solid = r('solid', 4.7, 2000);

test('shrunkRating: 5.0 with 4 reviews ranks below 4.7 with 2,000', () => {
  assert.ok(shrunkRating(tiny) < shrunkRating(solid));
});

test('shrunkRating: converges to raw rating with many reviews, raw when count unknown, 0 when unrated', () => {
  assert.ok(Math.abs(shrunkRating(r('a', 4.8, 1e6)) - 4.8) < 0.01);
  assert.strictEqual(shrunkRating(r('a', 4.8, null)), 4.8);
  assert.strictEqual(shrunkRating(r('a', null, 10)), 0);
});

test('pickRandomTopPool drops the 4-review 5.0 when the top slice is full of established places', () => {
  const rs = [tiny, ...Array.from({ length: 30 }, (_, i) => r(`s${i}`, 4.6, 1000 + i))];
  for (let k = 0; k < 30; k++) {
    // slice is 16: tiny's shrunk ~4.23 sits below every 4.6 / 1000+ place
    assert.ok(!pickRandomTopPool(rs, 8).some(x => x.id === 'tiny'));
  }
});

test('chooseInstantPick prefers the established place over the tiny-sample 5.0', () => {
  let tinyHits = 0;
  for (let i = 0; i < 2000; i++) if (chooseInstantPick([tiny, solid], [], []).id === 'tiny') tinyHits++;
  assert.ok(tinyHits / 2000 < 0.4, `tiny picked ${tinyHits}/2000`);
});
