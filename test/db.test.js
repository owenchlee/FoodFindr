const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
process.env.DB_PATH = path.join(os.tmpdir(), `ff-db-test-${process.pid}-${crypto.randomBytes(4).toString('hex')}.db`);
fs.rmSync(process.env.DB_PATH, { force: true });

// Seed a pre-accounts (legacy) DB shape so db.js runs its migrations on load.
const raw = new DatabaseSync(process.env.DB_PATH);
raw.exec(`
  CREATE TABLE visits (id INTEGER PRIMARY KEY AUTOINCREMENT, restaurant_name TEXT NOT NULL, dish TEXT, rating INTEGER NOT NULL, logged_at TEXT NOT NULL);
  INSERT INTO visits (restaurant_name, dish, rating, logged_at) VALUES ('Old Spot', NULL, 5, '2020-01-01T12:00:00.000Z');
  CREATE TABLE preferences (id INTEGER PRIMARY KEY CHECK (id = 1), favorite_cuisines TEXT NOT NULL, dietary_restrictions TEXT NOT NULL, spice_tolerance TEXT NOT NULL, price_tolerance INTEGER NOT NULL, updated_at TEXT NOT NULL);
  INSERT INTO preferences VALUES (1, '["thai"]', '["vegan"]', 'hot', 3, '2020-01-01T00:00:00.000Z');
  CREATE TABLE discovered_restaurants (place_id TEXT PRIMARY KEY, name TEXT NOT NULL, city TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL, first_seen_at TEXT NOT NULL);
  INSERT INTO discovered_restaurants VALUES ('p-old', 'Old Spot', 'Austin', 1, 2, '2020-01-01T00:00:00.000Z');
`);

const db = require('../server/db');
const mk = (email) => db.insertUser({ email, passwordHash: 'h' }).id;
const setDates = (userId, dates) => {
  const ids = raw.prepare('SELECT id FROM visits WHERE user_id = ? ORDER BY id').all(userId).map(r => r.id);
  ids.forEach((id, i) => raw.prepare('UPDATE visits SET logged_at = ? WHERE id = ?').run(dates[i], id));
};
const dayOffset = (n) => new Date(Date.now() - n * 86400000).toISOString();

let first;
test('first user adopts legacy visits, preferences and discovered restaurants', () => {
  assert.strictEqual(db.countUsers(), 0);
  first = mk('first@x.com');
  db.adoptLegacyData(first);
  assert.deepStrictEqual(db.listVisits(first).map(v => v.restaurant_name), ['Old Spot']);
  assert.deepStrictEqual(db.getPreferences(first), {
    favoriteCuisines: ['thai'], dietaryRestrictions: ['vegan'], spiceTolerance: 'hot', updatedAt: '2020-01-01T00:00:00.000Z'
  });
  assert.deepStrictEqual(db.getProgress(first, 'Austin'), { city: 'Austin', discovered: 1, visited: 1 });
  const legacy = raw.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%_legacy'").all();
  assert.deepStrictEqual(legacy, []);
  // Second call is a no-op once legacy tables are gone.
  db.adoptLegacyData(first);
  assert.strictEqual(db.countUsers(), 1);
});

test('users: email lookup is case-insensitive and duplicates are rejected', () => {
  const id = mk('Case@X.com');
  assert.strictEqual(db.getUserByEmail('case@x.com').id, id);
  assert.strictEqual(db.getUserByEmail('nobody@x.com'), undefined);
  assert.throws(() => mk('CASE@x.com'), /UNIQUE/);
});

test('sessions: create, read with user, delete', () => {
  const id = mk('sess@x.com');
  db.createSession({ token: 't1', userId: id, expiresAt: '2099-01-01T00:00:00.000Z' });
  assert.deepStrictEqual({ ...db.getSessionWithUser('t1') },
    // the table stores sha256(token), never the raw cookie value
    { token: require('crypto').createHash('sha256').update('t1').digest('hex'), expires_at: '2099-01-01T00:00:00.000Z', user_id: id, email: 'sess@x.com' });
  db.deleteSession('t1');
  assert.strictEqual(db.getSessionWithUser('t1'), undefined);
});

test('visits: insert, list newest first, highlights limit, top flavors only from 4+ ratings', () => {
  const id = mk('visits@x.com');
  const v = db.insertVisit({ userId: id, restaurantName: 'A', rating: 5, flavorTags: ['spicy', 'umami'] });
  assert.strictEqual(v.dish, null);
  assert.strictEqual(v.flavor_tags, '["spicy","umami"]');
  db.insertVisit({ userId: id, restaurantName: 'B', dish: 'Noodles', rating: 4, flavorTags: ['spicy'] });
  db.insertVisit({ userId: id, restaurantName: 'C', rating: 2, flavorTags: ['sweet'] });
  db.insertVisit({ userId: id, restaurantName: 'D', rating: 5 });
  setDates(id, ['2024-01-01T10:00:00.000Z', '2024-01-02T10:00:00.000Z', '2024-01-03T10:00:00.000Z', '2024-01-04T10:00:00.000Z']);
  assert.deepStrictEqual(db.listVisits(id).map(r => r.restaurant_name), ['D', 'C', 'B', 'A']);
  assert.deepStrictEqual(db.getVisitHighlights(id, 2).map(r => r.restaurant_name), ['D', 'C']);
  assert.deepStrictEqual(db.getTopFlavors(id), [{ tag: 'spicy', count: 2 }, { tag: 'umami', count: 1 }]);
  assert.deepStrictEqual(db.getTopFlavors(id, 1), [{ tag: 'spicy', count: 2 }]);
});

test('preferences: null before save, round-trip, upsert overwrites', () => {
  const id = mk('prefs@x.com');
  assert.strictEqual(db.getPreferences(id), null);
  const saved = db.savePreferences(id, { favoriteCuisines: ['mexican'], dietaryRestrictions: [], spiceTolerance: 'mild' });
  assert.deepStrictEqual(db.getPreferences(id), saved);
  assert.deepStrictEqual(saved.favoriteCuisines, ['mexican']);
  db.savePreferences(id, { favoriteCuisines: ['indian', 'thai'], dietaryRestrictions: ['halal'], spiceTolerance: 'hot' });
  const p = db.getPreferences(id);
  assert.deepStrictEqual([p.favoriteCuisines, p.dietaryRestrictions, p.spiceTolerance], [['indian', 'thai'], ['halal'], 'hot']);
});

test('discovered restaurants: dedupe per user, progress per city, rollback on error', () => {
  const id = mk('disc@x.com');
  const r = (pid, name) => ({ id: pid, name, lat: 1, lng: 2 });
  db.recordDiscovered(id, [r('p1', 'Taco Place'), r('p2', 'Pho Spot'), r('p1', 'Taco Place')], 'Austin');
  db.recordDiscovered(id, [r('p3', 'Elsewhere')], 'Dallas');
  db.insertVisit({ userId: id, restaurantName: '  taco place ', rating: 4 });
  assert.deepStrictEqual(db.getProgress(id, 'Austin'), { city: 'Austin', discovered: 2, visited: 1 });
  assert.deepStrictEqual(db.getProgress(id, 'Dallas'), { city: 'Dallas', discovered: 1, visited: 0 });
  // A chain's locations count once as visited; curly apostrophes and inner spacing are ignored.
  db.recordDiscovered(id, [r('c1', 'Joe’s  Pizza'), r('c2', "Joe's Pizza")], 'Chainville');
  db.insertVisit({ userId: id, restaurantName: "joe's pizza", rating: 4 });
  assert.deepStrictEqual(db.getProgress(id, 'Chainville'), { city: 'Chainville', discovered: 2, visited: 1 });
  // OR IGNORE swallows constraint errors, so use an unbindable value to force a failure midway; the batch rolls back.
  assert.throws(() => db.recordDiscovered(id, [r('p4', 'Ok'), { id: 'p5', name: {}, lat: 1, lng: 2 }], 'Houston'));
  assert.strictEqual(db.getProgress(id, 'Houston').discovered, 0);
});

test('streaks: empty, same-day dedupe, longest run, current streak alive or broken', () => {
  const id = mk('streak@x.com');
  assert.deepStrictEqual(db.getStreaks(id), { currentStreak: 0, longestStreak: 0, lastVisitDate: null });
  for (let i = 0; i < 6; i++) db.insertVisit({ userId: id, restaurantName: 'S' + i, rating: 3 });
  setDates(id, ['2024-03-01T01:00:00.000Z', '2024-03-01T20:00:00.000Z', '2024-03-02T08:00:00.000Z',
    '2024-03-03T08:00:00.000Z', '2024-03-10T08:00:00.000Z', '2024-03-11T08:00:00.000Z']);
  assert.deepStrictEqual(db.getStreaks(id), { currentStreak: 0, longestStreak: 3, lastVisitDate: '2024-03-11' });
  // In LA the 01:00Z visit falls on Feb 29, making a 4-day run; a bad zone falls back to UTC.
  assert.deepStrictEqual(db.getStreaks(id, 'America/Los_Angeles'), { currentStreak: 0, longestStreak: 4, lastVisitDate: '2024-03-11' });
  assert.deepStrictEqual(db.getStreaks(id, 'Not/AZone'), db.getStreaks(id));

  const live = mk('live@x.com');
  for (let i = 0; i < 3; i++) db.insertVisit({ userId: live, restaurantName: 'L' + i, rating: 3 });
  setDates(live, [dayOffset(5), dayOffset(2), dayOffset(1)]);
  assert.deepStrictEqual([db.getStreaks(live).currentStreak, db.getStreaks(live).longestStreak], [2, 2]);
});

test('getBadges evaluates stats from the user visits', () => {
  const id = mk('badges@x.com');
  const before = db.getBadges(id);
  assert.ok(Array.isArray(before) && before.length > 0);
  assert.ok(before.every(b => !b.earned));
  db.insertVisit({ userId: id, restaurantName: 'X', rating: 5, flavorTags: ['spicy'] });
  assert.ok(db.getBadges(id).some(b => b.earned));
});

test('leaderboard orders by visits then longest streak then id', () => {
  const a = mk('lb-a@x.com'), b = mk('lb-b@x.com'), c = mk('lb-c@x.com');
  const g = db.createGroup(a, 'LB');
  db.joinGroupByCode(b, g.code);
  db.joinGroupByCode(c, g.code);
  db.insertVisit({ userId: b, restaurantName: 'Q', rating: 3 });
  const rows = db.getLeaderboardStats(a);
  assert.deepStrictEqual(rows.map(r => r.userId), [b, a, c]);
  assert.deepStrictEqual(rows[0], { userId: b, email: 'lb-b@x.com', visitCount: 1, currentStreak: 1, longestStreak: 1 });
});

test('groups: create, join case-insensitively, idempotent join, members, leave and auto-delete', () => {
  const owner = mk('g-owner@x.com'), friend = mk('g-friend@x.com');
  const g = db.createGroup(owner, 'Dinner');
  assert.match(g.code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.strictEqual(db.joinGroupByCode(friend, 'nope00'), null);
  assert.strictEqual(db.joinGroupByCode(friend, g.code.toLowerCase()).id, g.id);
  db.joinGroupByCode(friend, g.code);
  assert.deepStrictEqual(db.getGroupMemberIds(g.id).sort(), [owner, friend].sort());
  assert.deepStrictEqual(db.getGroupMembers(g.id).map(m => m.email).sort(), ['g-friend@x.com', 'g-owner@x.com']);
  assert.deepStrictEqual(db.listUserGroups(friend).map(r => ({ ...r })), [{ id: g.id, name: 'Dinner', code: g.code, member_count: 2 }]);
  assert.ok(db.isGroupMember(g.id, friend));
  db.leaveGroup(g.id, friend);
  assert.ok(!db.isGroupMember(g.id, friend));
  assert.strictEqual(db.listUserGroups(owner)[0].member_count, 1);
  db.leaveGroup(g.id, owner);
  assert.deepStrictEqual(db.listUserGroups(owner), []);
  assert.strictEqual(db.joinGroupByCode(friend, g.code), null);
});

test('deleteUser erases the account and its data, hands shared groups on, drops solo groups', () => {
  const gone = mk('del-me@x.com'), stay = mk('del-stay@x.com');
  const shared = db.createGroup(gone, 'Shared');
  db.joinGroupByCode(stay, shared.code);
  const solo = db.createGroup(gone, 'Solo');
  db.insertVisit({ userId: gone, restaurantName: 'X', rating: 3 });
  db.createSession({ token: 'del-t', userId: gone, expiresAt: '2099-01-01T00:00:00.000Z' });
  db.deleteUser(gone);
  assert.strictEqual(db.getUserById(gone), undefined);
  assert.strictEqual(db.getSessionWithUser('del-t'), undefined);
  assert.strictEqual(db.listVisits(gone).length, 0);
  assert.deepStrictEqual(db.getGroupMemberIds(shared.id), [stay]);
  assert.strictEqual(db.joinGroupByCode(stay, solo.code), null);
});

test('exportUserData returns only this user\'s data and never secrets', () => {
  const id = mk('export@x.com'), other = mk('export-other@x.com');
  db.insertVisit({ userId: id, restaurantName: 'Mine', rating: 5, flavorTags: ['Spicy'] });
  db.insertVisit({ userId: other, restaurantName: 'Theirs', rating: 2 });
  const out = db.exportUserData(id);
  assert.strictEqual(out.user.email, 'export@x.com');
  assert.deepStrictEqual(out.visits.map(v => [v.restaurant_name, v.flavor_tags]), [['Mine', ['Spicy']]]);
  assert.ok(!JSON.stringify(out).includes('password'));
});
