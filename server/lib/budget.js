// Per-person dollar ceilings for each price tier. Must match the UI hint text in
// index.html: "$ under $15 · $$ under $30 · $$$ under $60, per person (approximate)".
const PRICE_TIER_MAX_USD = { 1: 15, 2: 30, 3: 60 };

function totalGroupBudget(groupSize, targetPrice) {
  const perPerson = PRICE_TIER_MAX_USD[targetPrice] || PRICE_TIER_MAX_USD[2];
  return groupSize * perPerson;
}

// Candidates at or under the price tier; unpriced places pass. Falls back to
// everything when nothing fits so the pool is never empty.
function budgetPool(candidates, targetPrice) {
  const inBudget = candidates.filter(r => r.price == null || r.price <= targetPrice);
  return inBudget.length > 0 ? inBudget : candidates;
}

module.exports = { PRICE_TIER_MAX_USD, totalGroupBudget, budgetPool };
