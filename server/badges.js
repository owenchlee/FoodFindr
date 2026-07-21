const REGULAR_TARGET = 10;
const CERTIFIED_FOODIE_TARGET = 25;
const ON_A_ROLL_TARGET = 3;
const STREAK_WEEK_TARGET = 7;
const FLAVOR_EXPLORER_TARGET = 6;
const HONEST_CRITIC_TARGET = 3;
const WEEKEND_REGULAR_TARGET = 5;
const COMEBACK_GAP_DAYS = 14;

function uniqueSortedUTCDays(timestamps) {
  const days = new Set(timestamps.map(ts => ts.slice(0, 10)));
  return Array.from(days).sort();
}

// `rows` is [{ rating, flavor_tags, logged_at }] for one user; `streaks` is
// the result of db.js's getStreaks(userId) for the same user.
function computeStats(rows, streaks) {
  const lowRatingCount = rows.filter(r => r.rating <= 2).length;
  const distinctRatingCount = new Set(rows.map(r => r.rating)).size;

  const flavorSet = new Set();
  for (const row of rows) {
    if (!row.flavor_tags) continue;
    for (const tag of JSON.parse(row.flavor_tags)) flavorSet.add(tag);
  }

  const weekendCount = rows.filter(r => {
    const day = new Date(r.logged_at).getUTCDay();
    return day === 0 || day === 6;
  }).length;

  const days = uniqueSortedUTCDays(rows.map(r => r.logged_at));
  let hadComebackGap = false;
  for (let i = 1; i < days.length; i++) {
    const gapDays = (Date.parse(`${days[i]}T00:00:00Z`) - Date.parse(`${days[i - 1]}T00:00:00Z`)) / 86400000;
    if (gapDays >= COMEBACK_GAP_DAYS) {
      hadComebackGap = true;
      break;
    }
  }

  return {
    totalCount: rows.length,
    lowRatingCount,
    distinctRatingCount,
    distinctFlavorCount: flavorSet.size,
    weekendCount,
    hadComebackGap,
    currentStreak: streaks.currentStreak,
    longestStreak: streaks.longestStreak
  };
}

function badge(id, name, description, earned, progress) {
  return { id, name, description, earned, progress: earned ? null : progress };
}

function evaluateBadges(stats) {
  return [
    badge('first-bite', 'First Bite', 'Log your first visit.',
      stats.totalCount >= 1, { current: Math.min(stats.totalCount, 1), target: 1 }),

    badge('regular', 'Regular', `Log ${REGULAR_TARGET} visits.`,
      stats.totalCount >= REGULAR_TARGET, { current: stats.totalCount, target: REGULAR_TARGET }),

    badge('certified-foodie', 'Certified Foodie', `Log ${CERTIFIED_FOODIE_TARGET} visits.`,
      stats.totalCount >= CERTIFIED_FOODIE_TARGET, { current: stats.totalCount, target: CERTIFIED_FOODIE_TARGET }),

    badge('on-a-roll', 'On a Roll', `Reach a ${ON_A_ROLL_TARGET}-day visit streak.`,
      stats.longestStreak >= ON_A_ROLL_TARGET, { current: stats.longestStreak, target: ON_A_ROLL_TARGET }),

    badge('streak-week', 'Streak Week', `Reach a ${STREAK_WEEK_TARGET}-day visit streak.`,
      stats.longestStreak >= STREAK_WEEK_TARGET, { current: stats.longestStreak, target: STREAK_WEEK_TARGET }),

    badge('flavor-explorer', 'Flavor Explorer', `Use ${FLAVOR_EXPLORER_TARGET} different flavor tags across your visits.`,
      stats.distinctFlavorCount >= FLAVOR_EXPLORER_TARGET, { current: stats.distinctFlavorCount, target: FLAVOR_EXPLORER_TARGET }),

    badge('honest-critic', 'Honest Critic', `Log ${HONEST_CRITIC_TARGET} visits rated 2 stars or lower.`,
      stats.lowRatingCount >= HONEST_CRITIC_TARGET, { current: stats.lowRatingCount, target: HONEST_CRITIC_TARGET }),

    badge('range-rater', 'Range Rater', 'Log at least one visit at every rating, 1 through 5.',
      stats.distinctRatingCount >= 5, { current: stats.distinctRatingCount, target: 5 }),

    badge('comeback', 'Comeback', `Log a visit at least ${COMEBACK_GAP_DAYS} days after your previous one.`,
      stats.hadComebackGap, { current: stats.hadComebackGap ? 1 : 0, target: 1 }),

    badge('weekend-regular', 'Weekend Regular', `Log ${WEEKEND_REGULAR_TARGET} visits on a Saturday or Sunday.`,
      stats.weekendCount >= WEEKEND_REGULAR_TARGET, { current: stats.weekendCount, target: WEEKEND_REGULAR_TARGET })
  ];
}

module.exports = { computeStats, evaluateBadges };
