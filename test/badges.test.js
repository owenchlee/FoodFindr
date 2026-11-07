const test = require('node:test');
const assert = require('node:assert');
const { computeStats, evaluateBadges } = require('../server/badges');

const noStreak = { currentStreak: 0, longestStreak: 0 };
const byId = (badges) => Object.fromEntries(badges.map(b => [b.id, b]));

test('computeStats on no visits is all zeros', () => {
  assert.deepStrictEqual(computeStats([], noStreak), {
    totalCount: 0, lowRatingCount: 0, distinctRatingCount: 0, distinctFlavorCount: 0,
    weekendCount: 0, hadComebackGap: false, currentStreak: 0, longestStreak: 0
  });
});

test('computeStats counts low ratings, distinct ratings, flavors and weekends', () => {
  const rows = [
    // 2026-11-07 is a Saturday, 2026-11-08 a Sunday, 2026-11-09 a Monday
    { rating: 1, flavor_tags: '["spicy","sweet"]', logged_at: '2026-11-07T12:00:00Z' },
    { rating: 2, flavor_tags: '["spicy"]', logged_at: '2026-11-08T12:00:00Z' },
    { rating: 2, flavor_tags: null, logged_at: '2026-11-09T12:00:00Z' },
    { rating: 5, flavor_tags: '["umami"]', logged_at: '2026-11-09T18:00:00Z' }
  ];
  const s = computeStats(rows, { currentStreak: 3, longestStreak: 4 });
  assert.strictEqual(s.totalCount, 4);
  assert.strictEqual(s.lowRatingCount, 3);
  assert.strictEqual(s.distinctRatingCount, 3);
  assert.strictEqual(s.distinctFlavorCount, 3);
  assert.strictEqual(s.weekendCount, 2);
  assert.strictEqual(s.hadComebackGap, false);
  assert.strictEqual(s.currentStreak, 3);
  assert.strictEqual(s.longestStreak, 4);
});

test('comeback gap triggers at exactly 14 days, not 13', () => {
  const at = (d) => ({ rating: 3, flavor_tags: null, logged_at: `${d}T10:00:00Z` });
  assert.strictEqual(computeStats([at('2026-01-01'), at('2026-01-14')], noStreak).hadComebackGap, false);
  assert.strictEqual(computeStats([at('2026-01-15'), at('2026-01-01')], noStreak).hadComebackGap, true);
});

test('evaluateBadges with nothing earned reports progress', () => {
  const badges = evaluateBadges(computeStats([], noStreak));
  assert.strictEqual(badges.length, 10);
  for (const b of badges) {
    assert.strictEqual(b.earned, false);
    assert.strictEqual(b.progress.current, 0);
  }
  assert.strictEqual(byId(badges).regular.progress.target, 10);
});

test('evaluateBadges earns badges at their thresholds and drops progress', () => {
  const b = byId(evaluateBadges({
    totalCount: 25, lowRatingCount: 3, distinctRatingCount: 5, distinctFlavorCount: 6,
    weekendCount: 5, hadComebackGap: true, currentStreak: 1, longestStreak: 7
  }));
  for (const badge of Object.values(b)) {
    assert.strictEqual(badge.earned, true, badge.id);
    assert.strictEqual(badge.progress, null, badge.id);
  }
});

test('evaluateBadges just below thresholds', () => {
  const b = byId(evaluateBadges({
    totalCount: 9, lowRatingCount: 2, distinctRatingCount: 4, distinctFlavorCount: 5,
    weekendCount: 4, hadComebackGap: false, currentStreak: 0, longestStreak: 6
  }));
  assert.strictEqual(b['first-bite'].earned, true);
  assert.strictEqual(b['on-a-roll'].earned, true);
  for (const id of ['regular', 'certified-foodie', 'streak-week', 'flavor-explorer',
    'honest-critic', 'range-rater', 'comeback', 'weekend-regular']) {
    assert.strictEqual(b[id].earned, false, id);
  }
  assert.deepStrictEqual(b['streak-week'].progress, { current: 6, target: 7 });
  assert.deepStrictEqual(b.comeback.progress, { current: 0, target: 1 });
});
