const { findDietConflict } = require('./diet');

// Fixed vocabulary (not free-form) so tags can actually be aggregated into
// "top flavors" later. Free text from Claude would fragment across
// synonyms like "tangy" vs "zesty" vs "sour".
const FLAVOR_TAGS = ['Spicy', 'Tangy', 'Sweet', 'Savory', 'Umami', 'Sour', 'Smoky', 'Creamy', 'Fresh', 'Rich', 'Herby', 'Crispy'];

const MEAT_WORDS = ['chicken', 'beef', 'pork', 'bacon', 'ham', 'turkey', 'lamb', 'steak',
  'sausage', 'meat', 'fish', 'shrimp', 'prawn', 'calamari', 'squid', 'crab', 'lobster',
  'salmon', 'tuna', 'duck', 'veal', 'goat', 'mutton', 'pepperoni', 'salami', 'prosciutto',
  'pancetta', 'chorizo', 'pastrami', 'anchovy', 'anchovies', 'oyster', 'mussel', 'clam',
  'scallop', 'eel', 'octopus', 'brisket', 'rib', 'ribs', 'gelatin', 'venison'];
const VEGAN_ONLY_WORDS = ['egg', 'cheese', 'cheesecake', 'butter', 'honey', 'dairy', 'milk',
  'yogurt', 'yoghurt', 'ghee', 'paneer'];

// Phrases that contain a blocked word but are not the animal ingredient. Removed
// before matching so "peanut butter" or "oyster mushroom" don't trip the check.
const SAFE_PHRASES = /\b(?:(?:peanut|almond|cashew|nut|apple|sunflower|seed|cocoa|shea)\s+butter|(?:coconut|almond|oat|soy|soya|cashew|rice|plant|nut)\s+milk|oyster\s+mushrooms?|(?:vegan|plant-based|non-dairy)\s+(?:egg|cheese|butter|milk|yogurt)s?|\w+-free)\b/g;

// Whole-word match with an optional plural suffix; "eggplant", "butternut" and
// "wheel" do not match "egg", "butter" or "eel".
function findBlockedWord(text, isVegan) {
  const cleaned = text.replace(SAFE_PHRASES, ' ');
  const words = isVegan ? [...MEAT_WORDS, ...VEGAN_ONLY_WORDS] : MEAT_WORDS;
  return words.find(word => new RegExp(`\\b${word}(?:e?s)?\\b`, 'i').test(cleaned));
}

// Lowercase, accent-free, punctuation-free, singular-ish word list.
function foodWords(text) {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean)
    .map(w => (w.length > 3 ? w.replace(/(?:es|s)$/, '') : w));
}
const DISH_FILLER = new Set(['the', 'their', 'a', 'an', 'with', 'and', 'of', 'in', 'on', 'for', 'or', 'to',
  'plate', 'platter', 'bowl', 'dish', 'order', 'special', 'side', 'extra', 'fresh', 'house', 'homemade', 'signature']);

// Third-party review text can smuggle contact details or ads into dish/reason.
const INJECTED = [
  [/https?:|www\.|\]\(|\b[\w-]+\.(?:com|net|org|biz|io|co|app|me|ly|info|xyz)\b/i, 'a URL or link'],
  [/[\w.+-]+@[\w-]+\.\w+/, 'an email address'],
  [/\(?\b\d{3}\)?[\s.-]+\d{3}[\s.-]+\d{4}\b|\b\d{3}[-.]\d{4}\b/, 'a phone number'],
  [/\b(?:promo|coupon|discount|voucher|referral)\s+code\b|\buse\s+code\b/i, 'a promo code'],
];

// Lenient grounding: at least half of the dish's food words (generic filler
// ignored) must appear in the chosen place's reviews. shortcut: word overlap,
// not real NLP; upgrade if wrongful rejections show up.
function dishGroundingProblem(dish, chosen) {
  if (/\bmost popular\b/i.test(dish)) return null;
  const words = foodWords(dish).filter(w => !DISH_FILLER.has(w));
  if (words.length === 0) return null;
  const seen = new Set(foodWords((Array.isArray(chosen.reviews) ? chosen.reviews : []).join(' ')));
  const hits = words.filter(w => seen.has(w)).length;
  if (hits * 2 >= words.length) return null;
  return `the dish "${dish}" is not mentioned in the reviews for this restaurant; only suggest a dish that a review for the chosen place actually names, or use a generic "their most popular item"`;
}

// Returns null when valid, or a short human-readable reason string when not -
// the reason doubles as the corrective text sent back to Claude on retry (see
// askClaudeForRecommendation), so keep each one specific enough to act on.
function isValidRecommendation(input, candidates, dietaryRestrictions) {
  if (!input || typeof input !== 'object') return 'the response was not a valid object';
  if (typeof input.place_id !== 'string' || !candidates.some(c => c.place_id === input.place_id)) {
    return 'place_id must exactly match one of the candidates provided';
  }
  if (typeof input.dish_suggestion !== 'string' || !input.dish_suggestion.trim()) {
    return 'dish_suggestion was missing or empty';
  }
  if (typeof input.reason !== 'string' || !input.reason.trim() || /<\/?\w+[^>]*>/.test(input.reason)) {
    return 'reason was missing, empty, or contained stray markup like </reason> or <parameter>';
  }
  if (!Array.isArray(input.flavor_tags) || input.flavor_tags.length !== 3 || !input.flavor_tags.every(tag => FLAVOR_TAGS.includes(tag))) {
    return `flavor_tags must be exactly 3 values from: ${FLAVOR_TAGS.join(', ')}`;
  }
  for (const [re, what] of INJECTED) {
    if (re.test(input.dish_suggestion) || re.test(input.reason)) {
      return `dish_suggestion and reason must not contain ${what}; write plain text about the food only`;
    }
  }
  if (dietaryRestrictions && dietaryRestrictions.length > 0) {
    // A required field under strict:true can't be silently omitted the way a
    // regex-sniffed sentence in `reason` could - this replaces that check.
    if (typeof input.dietary_note !== 'string' || !input.dietary_note.trim()) {
      return 'dietary_note is required here and must state whether the dish is confirmed compliant with the stated dietary restriction(s), or that it could not be confirmed';
    }

    // The dish name itself must not assert a diet label ("Vegan tacos") unless a
    // review for that exact restaurant actually used that word. Otherwise the name
    // alone (more prominent in the UI than the full reason) can mislead someone
    // skimming past a hedge buried in the reason text.
    const dietLabels = ['vegan', 'vegetarian', 'plant-based', 'plant based', 'dairy-free', 'dairy free'];
    const dishText = [input.dish_suggestion, ...(Array.isArray(input.shared_items) ? input.shared_items : [])]
      .join(' ').toLowerCase();
    const namedLabels = dietLabels.filter(label => dishText.includes(label));
    if (namedLabels.length > 0) {
      const chosen = candidates.find(c => c.place_id === input.place_id);
      const reviewText = (chosen && Array.isArray(chosen.reviews) ? chosen.reviews.join(' ') : '').toLowerCase();
      const groundedInReviews = namedLabels.some(label => reviewText.includes(label));
      if (!groundedInReviews) {
        return `the dish name claims "${namedLabels[0]}" but no review for this restaurant used that word; only claim a diet label in the dish name if a review for it actually says so`;
      }
    }

    // Naming a dish with an obvious meat/seafood ingredient for a vegan or
    // vegetarian restriction is unsafe even with a hedge in the reason text,
    // since the dish name is what someone skimming will actually trust.
    const needsMeatCheck = dietaryRestrictions.some(r => /vegan|vegetarian/i.test(r));
    if (needsMeatCheck) {
      const isVegan = dietaryRestrictions.some(r => /vegan/i.test(r));
      const found = findBlockedWord(dishText, isVegan);
      if (found) {
        return `the dish name/shared items mention "${found}", which conflicts with a vegan/vegetarian restriction; pick a candidate whose reviews support a compliant dish instead`;
      }
    }
    // The other chips (gluten, dairy, nut, halal, kosher, shellfish).
    const dietConflict = findDietConflict(dishText, dietaryRestrictions);
    if (dietConflict) return dietConflict;
  }
  // After the diet checks so their more specific messages win. Sharing groups
  // list several items, so the single-dish length cap and grounding skip them.
  const isShared = Array.isArray(input.shared_items) && input.shared_items.length > 0;
  if (!isShared) {
    if (input.dish_suggestion.length > 90) return 'dish_suggestion must be a short dish name (under 90 characters), not a description; put details in reason';
    const problem = dishGroundingProblem(input.dish_suggestion, candidates.find(c => c.place_id === input.place_id));
    if (problem) return problem;
  }
  return null;
}

module.exports = { FLAVOR_TAGS, isValidRecommendation };
