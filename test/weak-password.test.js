const test = require('node:test');
const assert = require('node:assert');
const { isWeakPassword } = require('../server/lib/weak-password');

test('common and app-name passwords are weak', () => {
  for (const p of ['password', 'Password123', '12345678', 'qwerty123', 'foodfindr1', 'MyFoodFinder9', 'aaaaaaaa', '12341234', 'Welcome1!']) {
    assert.ok(isWeakPassword(p, 'a@b.com'), p);
  }
});

test('email and its name part are weak', () => {
  assert.ok(isWeakPassword('sam.reyes@example.com', 'Sam.Reyes@example.com'));
  assert.ok(isWeakPassword('samreyes', 'samreyes@example.com'));
});

test('strong passwords and passphrases pass', () => {
  for (const p of ['correct horse battery staple', 'j8Fh2kLsq', 'pizza on tuesday nights', 'Zb4!quiet-otter']) {
    assert.ok(!isWeakPassword(p, 'a@b.com'), p);
  }
});
