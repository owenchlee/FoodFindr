const { shrunkRating } = require('./rating');
const normName = require('./normName');

// Chips are coarser than card labels: a chip also covers these labels.
const CUISINE_FAMILY = {
  japanese: ['sushi', 'ramen'],
  italian: ['pizza'],
  chinese: ['dim sum'],
  american: ['burgers', 'bbq', 'steakhouse', 'southern'],
  mediterranean: ['greek', 'middle eastern'],
};

// "Surprise Me" should actually surprise: asking Claude to pick the single
// "best" restaurant from the same top-8-by-rating list every time reliably
// returns the same winner call after call, since nothing about the prompt or
// candidate set changes between clicks. Sampling randomly from a wider
// top-rated slice means each click genuinely can land on a different (still
// good) restaurant, instead of relying on the model to invent variety on its
// own, which isn't a reliable way to get it.
// Gentle weight in (0.1, 1.1]: nearest places count most, farthest least.
// Candidates without a distance (older clients) get a neutral 1.
function nearness(r, maxDist, p = 3) {
  if (!(maxDist > 0) || typeof r.distance !== 'number') return 1;
  return 0.03 + (1 - r.distance / maxDist) ** p;
}

function pickRandomTopPool(restaurants, poolSize) {
  // Rank by rating minus a small distance penalty so the candidate slice leans near.
  const far = Math.max(0, ...restaurants.map(r => r.distance || 0));
  const score = r => shrunkRating(r) - (far > 0 && typeof r.distance === 'number' ? 0.4 * r.distance / far : 0);
  const topN = restaurants
    .slice()
    .sort((a, b) => score(b) - score(a))
    .slice(0, Math.max(poolSize * 2, 15));

  // Weighted shuffle (Efraimidis-Spirakis): nearer places sort earlier on average.
  const maxDist = Math.max(0, ...topN.map(r => r.distance || 0));
  return topN
    .map(r => ({ r, k: Math.random() ** (1 / nearness(r, maxDist, 3.4)) }))
    .sort((a, b) => b.k - a.k)
    .slice(0, poolSize)
    .map(x => x.r);
}

// Instant Surprise Me pick, made here instead of by Claude so the restaurant
// is on screen in one round trip rather than after Claude's ~2s time to
// first token. Weighted random over the top-rated places: higher rating,
// a favorite cuisine, and not having been there recently all raise the odds,
// so repeated taps still vary. Places whose reviews are already cached (from
// /api/prewarm or an earlier pick) but give Claude nothing to name a dish
// from are made unlikely, since the old Claude-picks-from-8 path avoided them.
// getCachedReviews is injected so this module stays free of server state.
function chooseInstantPick(restaurants, favoriteCuisines, recentNames, getCachedReviews = () => null, recentPickIds = []) {
  const justPicked = new Set(recentPickIds);
  const favorites = favoriteCuisines.map(c => c.toLowerCase());
  const recent = new Set(recentNames.map(normName));
  // Rank by rating minus a small distance penalty so the top-15 slice leans near.
  const far = Math.max(0, ...restaurants.map(r => r.distance || 0));
  const score = r => shrunkRating(r) - (far > 0 && typeof r.distance === 'number' ? 0.4 * r.distance / far : 0);
  const top = restaurants
    .slice()
    .sort((a, b) => score(b) - score(a))
    .slice(0, 15);
  const maxDist = Math.max(0, ...top.map(r => r.distance || 0));
  const weights = top.map(r => {
    let w = Math.max(0.3, (shrunkRating(r) || 3.5) - 3.4) ** 2 * nearness(r, maxDist, 5);
    const cuisine = (r.cuisine || '').toLowerCase();
    if (cuisine && favorites.some(f => cuisine.includes(f) || f.includes(cuisine) || (CUISINE_FAMILY[f] || []).includes(cuisine))) w *= 2.5;
    if (recent.has(normName(r.name))) w *= 0.15;
    const cached = getCachedReviews(r.id);
    if (cached && cached.reviews.join(' ').length < 200) w *= 0.1;
    // Shown on the last few taps: strongly avoid, but stay possible so a
    // tiny result set still gets an answer.
    if (justPicked.has(r.id)) w *= 0.001;
    return w;
  });
  let roll = Math.random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < top.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return top[i];
  }
  return top[top.length - 1];
}

module.exports = { pickRandomTopPool, chooseInstantPick };
