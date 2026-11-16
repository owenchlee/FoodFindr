const test = require('node:test');
const assert = require('node:assert');
const { computeStats, localDay, safeZone } = require('../server/badges');

test('localDay follows the zone calendar', () => {
  assert.strictEqual(localDay('2026-11-10T03:00:00.000Z', 'America/Los_Angeles'), '2026-11-09');
  assert.strictEqual(localDay('2026-11-10T03:00:00.000Z', 'UTC'), '2026-11-10');
  assert.strictEqual(localDay('2026-11-09T20:00:00.000Z', 'Pacific/Auckland'), '2026-11-10');
});

test('safeZone falls back to UTC', () => {
  assert.strictEqual(safeZone(undefined), 'UTC');
  assert.strictEqual(safeZone('Not/AZone'), 'UTC');
  assert.strictEqual(safeZone('Asia/Tokyo'), 'Asia/Tokyo');
});

test('weekend badge count uses local day', () => {
  // Sat 2026-11-07 23:30 in LA is Sunday 07:30 UTC; Sun 2026-11-08 23:30 LA is Monday UTC
  const rows = [{ rating: 3, flavor_tags: null, logged_at: '2026-11-08T07:30:00.000Z' },
                { rating: 3, flavor_tags: null, logged_at: '2026-11-09T07:30:00.000Z' }];
  const st = { currentStreak: 0, longestStreak: 0 };
  assert.strictEqual(computeStats(rows, st, 'America/Los_Angeles').weekendCount, 2);
  assert.strictEqual(computeStats(rows, st, 'UTC').weekendCount, 1);
});
