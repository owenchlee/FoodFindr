const test = require('node:test');
const assert = require('node:assert');
const { isValidRecommendation } = require('../server/lib/validate');

const candidates = [{ place_id: 'p1', reviews: ['great vegan tacos here'] }, { place_id: 'p2', reviews: [] }];
const good = (o = {}) => ({
  place_id: 'p1', dish_suggestion: 'Mushroom tacos', reason: 'Reviewers love the tacos.',
  flavor_tags: ['Spicy', 'Fresh', 'Crispy'], ...o
});
const withNote = (o) => good({ dietary_note: 'ok', ...o });

test('accepts a well-formed recommendation', () => {
  assert.strictEqual(isValidRecommendation(good(), candidates, []), null);
});

test('rejects non-objects, unknown place ids, empty dish, markup in reason', () => {
  assert.match(isValidRecommendation(null, candidates, []), /valid object/);
  assert.match(isValidRecommendation(good({ place_id: 'zzz' }), candidates, []), /place_id/);
  assert.match(isValidRecommendation(good({ dish_suggestion: '  ' }), candidates, []), /dish_suggestion/);
  assert.match(isValidRecommendation(good({ reason: 'x </reason>' }), candidates, []), /reason/);
});

test('rejects bad flavor tags', () => {
  assert.match(isValidRecommendation(good({ flavor_tags: ['Spicy', 'Fresh'] }), candidates, []), /flavor_tags/);
  assert.match(isValidRecommendation(good({ flavor_tags: ['Spicy', 'Fresh', 'Zesty'] }), candidates, []), /flavor_tags/);
});

test('dietary restrictions require dietary_note', () => {
  assert.match(isValidRecommendation(good(), candidates, ['gluten-free']), /dietary_note/);
  assert.strictEqual(isValidRecommendation(withNote(), candidates, ['gluten-free']), null);
});

test("diet label in dish name must be grounded in that restaurant's reviews", () => {
  assert.match(isValidRecommendation(withNote({ place_id: 'p2', dish_suggestion: 'Vegan tacos' }), candidates, ['vegan']), /claims "vegan"/);
  assert.strictEqual(isValidRecommendation(withNote({ dish_suggestion: 'Vegan tacos' }), candidates, ['vegan']), null);
});

test('vegan/vegetarian rejects meat in dish name or shared items, other restrictions unaffected', () => {
  assert.match(isValidRecommendation(withNote({ dish_suggestion: 'Chicken tacos' }), candidates, ['Vegetarian']), /chicken/);
  assert.match(isValidRecommendation(withNote({ shared_items: ['Bacon fries'] }), candidates, ['vegan']), /bacon/);
  assert.strictEqual(isValidRecommendation(withNote({ dish_suggestion: 'Chicken tacos' }), candidates, ['gluten-free']), null);
});

test('meat words match on word boundaries', () => {
  assert.strictEqual(isValidRecommendation(withNote({ dish_suggestion: 'Hamachi-free salad' }), candidates, ['vegan']), null);
  assert.strictEqual(isValidRecommendation(withNote({ dish_suggestion: 'Shamrock salad' }), candidates, ['vegan']), null);
});

const dish = (name, diet) => isValidRecommendation(withNote({ dish_suggestion: name }), candidates, [diet]);

test('extended blocklist catches cured meat, shellfish and other animal products', () => {
  for (const name of ['Pepperoni pizza', 'Salami sandwich', 'Prosciutto flatbread', 'Anchovies toast', 'Fried oysters',
    'Mussels marinara', 'Clam chowder', 'Seared scallops', 'Unagi eel bowl', 'Smoked brisket', 'BBQ ribs', 'Gelatin dessert']) {
    assert.ok(dish(name, 'vegetarian'), `vegetarian should reject ${name}`);
    assert.ok(dish(name, 'vegan'), `vegan should reject ${name}`);
  }
});

test('dairy, egg and honey are blocked for vegan only', () => {
  for (const name of ['Cheese pizza', 'Fried eggs', 'Butter naan', 'Honey glazed carrots', 'Dairy bowl', 'Mac and cheese']) {
    assert.ok(dish(name, 'vegan'), `vegan should reject ${name}`);
  }
  assert.strictEqual(dish('Cheese pizza', 'vegetarian'), null);
  assert.strictEqual(dish('Fried eggs', 'Vegetarian'), null);
});

test('no false positives on lookalike or plant-based dishes', () => {
  for (const name of ['Eggplant parmesan-style bake', 'Peanut butter noodles', 'Butternut squash soup', 'Buffalo cauliflower',
    'Coconut milk curry', 'Oyster mushroom tacos', 'Wheel of falafel', 'Honeydew salad', 'Almond milk latte', 'Gluten-free pasta', 'Vegan cheese pizza']) {
    assert.strictEqual(dish(name, 'vegan'), null, `vegan should allow ${name}`);
  }
});
