const test = require('node:test');
const assert = require('node:assert');
const { findDietConflict } = require('../server/lib/diet');

const refused = [
  ['Gluten-Free', 'Spaghetti bolognese'], ['Dairy-Free', 'Butter chicken'],
  ['Nut-Free', 'Pad thai with peanuts'], ['Halal', 'Prosciutto flatbread'], ['Kosher', 'Shrimp scampi'],
  ['Shellfish-Free', 'Crab cakes'],
];
const accepted = [
  ['Nut-Free', 'Butternut squash soup'], ['Nut-Free', 'Nutmeg spiced rice'], ['Dairy-Free', 'Peanut butter rice bowl'],
  ['Dairy-Free', 'Oat milk oatmeal'], ['Kosher', 'Falafel plate'],
  ['Kosher', 'Brisket sandwich'], ['Shellfish-Free', 'Fish tacos'],
];

test('forbidden dishes are refused', () => {
  for (const [r, d] of refused) assert.ok(findDietConflict(d, [r]), `${r}: ${d}`);
});
test('compliant dishes are accepted', () => {
  for (const [r, d] of accepted) assert.strictEqual(findDietConflict(d, [r]), null, `${r}: ${d}`);
});
