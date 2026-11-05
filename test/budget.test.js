const test = require('node:test');
const assert = require('node:assert');
const { totalGroupBudget, budgetPool } = require('../server/lib/budget');

test('totalGroupBudget multiplies the per-person ceiling, defaulting to tier 2', () => {
  assert.strictEqual(totalGroupBudget(4, 1), 60);
  assert.strictEqual(totalGroupBudget(2, 3), 120);
  assert.strictEqual(totalGroupBudget(3, 99), 90);
});

test('budgetPool keeps places at/under the tier and unpriced ones', () => {
  const c = [{ id: 'a', price: 1 }, { id: 'b', price: 3 }, { id: 'c', price: null }, { id: 'd', price: 2 }];
  assert.deepStrictEqual(budgetPool(c, 2).map(r => r.id), ['a', 'c', 'd']);
});

test('budgetPool falls back to all candidates when none fit', () => {
  const c = [{ id: 'a', price: 3 }, { id: 'b', price: 4 }];
  assert.strictEqual(budgetPool(c, 1), c);
});
