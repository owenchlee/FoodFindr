const test = require('node:test');
const assert = require('node:assert');
const { pickRandomTopPool, chooseInstantPick } = require('../server/lib/pick');

const mk = (n, rating, extra = {}) => ({ id: `id${n}`, name: `R${n}`, cuisine: 'Thai', rating, ...extra });
const many = (n) => Array.from({ length: n }, (_, i) => mk(i, 5 - i * 0.05));
const share = (fn, n = 2000) => { let hits = 0; for (let i = 0; i < n; i++) if (fn()) hits++; return hits / n; };

test('pickRandomTopPool returns poolSize distinct restaurants from the top slice only', () => {
  const rs = many(40);
  for (let k = 0; k < 20; k++) {
    const pool = pickRandomTopPool(rs, 8);
    assert.strictEqual(pool.length, 8);
    assert.strictEqual(new Set(pool.map(r => r.id)).size, 8);
    // top slice is max(poolSize*2, 15) = 16 entries: id0..id15
    assert.ok(pool.every(r => Number(r.id.slice(2)) < 16));
  }
});

test('pickRandomTopPool does not mutate input and handles short lists', () => {
  const rs = [mk(1, 3), mk(2, 5)];
  assert.strictEqual(pickRandomTopPool(rs, 8).length, 2);
  assert.deepStrictEqual(rs.map(r => r.id), ['id1', 'id2']);
});

test('chooseInstantPick returns a member of the top 15 only', () => {
  const rs = many(40);
  for (let k = 0; k < 50; k++) {
    assert.ok(Number(chooseInstantPick(rs, [], []).id.slice(2)) < 15);
  }
});

test('chooseInstantPick: single candidate, and null ratings do not crash', () => {
  assert.strictEqual(chooseInstantPick([mk(1, null)], [], []).id, 'id1');
});

test('chooseInstantPick down-weights recently visited places', () => {
  const rs = [mk(1, 4.5, { name: 'Seen' }), mk(2, 4.5, { name: 'New' })];
  assert.ok(share(() => chooseInstantPick(rs, [], ['seen']).id === 'id1') < 0.25);
});

test('chooseInstantPick down-weights places whose cached reviews are thin', () => {
  const rs = [mk(1, 4.5), mk(2, 4.5)];
  const thin = (id) => (id === 'id1' ? { reviews: ['ok'] } : null);
  assert.ok(share(() => chooseInstantPick(rs, [], [], thin).id === 'id1') < 0.2);
});

test('chooseInstantPick up-weights favorite cuisines', () => {
  const rs = [mk(1, 4.5, { cuisine: 'Italian' }), mk(2, 4.5, { cuisine: 'Thai' })];
  assert.ok(share(() => chooseInstantPick(rs, ['italian'], []).id === 'id1') > 0.6);
});

test('chooseInstantPick avoids just-shown places but still answers with one candidate', () => {
  const rs = [mk(1, 4.5), mk(2, 4.5)];
  assert.ok(share(() => chooseInstantPick(rs, [], [], () => null, ['id1']).id === 'id1') < 0.05);
  assert.strictEqual(chooseInstantPick([mk(1, 4.5)], [], [], () => null, ['id1']).id, 'id1');
});
