const test = require('node:test');
const assert = require('node:assert');
const { cleanDisplayName, publicDisplayName } = require('../server/lib/displayName');

test('fallback name is unique per user and leaks nothing from the email', () => {
  const a = publicDisplayName({ id: 4, display_name: null, email: 'jane.doe.1987@gmail.com' });
  const b = publicDisplayName({ id: 5, display_name: null, email: 'kaimakoa42@yahoo.com' });
  assert.notStrictEqual(a, b);
  assert.ok(!/@|jane|doe|1987|kaimakoa/i.test(a + b));
  assert.strictEqual(publicDisplayName({ id: 4, display_name: 'Jay' }), 'Jay');
});

test('cleanDisplayName trims, strips markup/control/bidi, and rejects bad input', () => {
  assert.strictEqual(cleanDisplayName('  Jay  '), 'Jay');
  assert.strictEqual(cleanDisplayName('<b>Jay</b>'), null);
  assert.strictEqual(cleanDisplayName('Ja‮y\u0007'), 'Jay');
  assert.strictEqual(cleanDisplayName(''), null);
  assert.strictEqual(cleanDisplayName('   '), null);
  assert.strictEqual(cleanDisplayName('x'.repeat(31)), null);
  assert.strictEqual(cleanDisplayName({}), null);
  assert.strictEqual(cleanDisplayName(null), null);
});
