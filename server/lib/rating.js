// Bayesian-shrunk star rating: a 5.0 from 4 reviews should not beat a 4.7 from
// 2,000. Pulls each rating toward PRIOR_MEAN with the weight of PRIOR_WEIGHT
// phantom reviews. Without a review count (older client payloads) the raw
// rating is used, so ranking degrades to the old behavior instead of breaking.
const PRIOR_MEAN = 4.2;
const PRIOR_WEIGHT = 50;

function shrunkRating(r) {
  if (r.rating == null) return 0;
  const n = r.ratingCount;
  if (!Number.isFinite(n) || n < 0) return r.rating;
  return (r.rating * n + PRIOR_MEAN * PRIOR_WEIGHT) / (n + PRIOR_WEIGHT);
}

module.exports = { shrunkRating, PRIOR_MEAN, PRIOR_WEIGHT };
