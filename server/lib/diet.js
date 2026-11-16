'use strict';
// Server-side guard: forbidden ingredients per dietary chip. Terms are regex
// fragments matched case-insensitively on word boundaries with an optional
// plural, so 'nut' never hits butternut/nutmeg and 'egg' never hits eggplant.
// Vegan/Vegetarian are checked by findBlockedWord in validate.js, not here.
// shortcut: keyword matching on the dish name only, no ingredient data; upgrade if menus become available.

const SHELLFISH = ['shellfish', 'seafood', 'shrimp', 'prawn', 'crab', 'lobster', 'oyster', 'clam', 'mussel', 'scallop',
  'crawfish', 'crayfish', 'langoustine', 'cockle', 'abalone', 'calamari', 'squid', 'octopus', 'cuttlefish', 'escargot'];
const PORK = ['pork', 'spare rib', 'bacon', 'ham', 'pepperoni', 'prosciutto', 'salami', 'chorizo', 'pancetta', 'mortadella',
  'carnitas', 'lard', 'hot dog', 'chicharron', 'guanciale', 'bologna', 'al pastor', 'spam'];
const DAIRY = ['cheese', 'cheesecake', 'cheeseburger', 'cheddar', 'mozzarella', 'parmesan', 'parmigiana', 'feta', 'ricotta',
  'burrata', 'paneer', 'halloumi', 'brie', 'gouda', 'mascarpone', 'queso', 'gruyere', 'provolone', 'gorgonzola',
  'butter', 'buttermilk', 'ghee', 'cream', 'creamy', 'milk', 'yogurt', 'yoghurt', 'custard', 'whey', 'gelato',
  'alfredo', 'bechamel', 'tzatziki', 'labneh', 'raita', 'tiramisu', 'latte', 'milkshake', 'carbonara', 'fondue'];
const NUTS = ['nut', 'peanut', 'almond', 'walnut', 'pecan', 'cashew', 'pistachio', 'hazelnut', 'macadamia',
  'pine nut', 'brazil nut', 'nutella', 'praline', 'marzipan', 'satay', 'pesto', 'pad thai', 'kung pao', 'baklava', 'gianduja'];
const GLUTEN = ['wheat', 'bread', 'toast', 'bun', 'sandwich', 'burger', 'pizza', 'pasta', 'spaghetti', 'lasagna',
  'lasagne', 'chicken parm(?:esan|igiana)?', 'ravioli', 'noodle', 'ramen', 'udon', 'pancake', 'waffle', 'bagel', 'croissant', 'naan', 'pita',
  'couscous', 'seitan', 'barley', 'rye', 'flour', 'dumpling', 'gnocchi', 'cake', 'cookie', 'pastry', 'panini',
  'burrito', 'crouton', 'tempura', 'schnitzel', 'breaded', 'battered', 'fettuccine', 'linguine', 'penne',
  'macaroni', 'calzone', 'focaccia', 'baguette', 'brioche', 'wrap', 'pierogi', 'empanada', 'samosa', 'gyoza'];
const KOSHER_ONLY = ['catfish', 'swordfish', 'shark', 'eel', 'cheeseburger', 'cheesesteak', 'chicken parmesan',
  'chicken parmigiana', 'chicken parm', 'rabbit', 'alligator', 'frog'];
const ALCOHOL = ['wine', 'beer', 'rum', 'whiskey', 'bourbon', 'vodka', 'sake', 'liquor', 'alcohol', 'cocktail', 'mirin'];

// Phrases that contain a trigger word but are fine; removed before matching.
const SAFE = /\b(?:(?:coconut|almond|oat|soy|soya|cashew|rice|hemp|pea) (?:milk(?: latte)?|cream|yogurt|cheese)|(?:peanut|almond|cashew|sunflower|soy|cocoa|shea|apple) butter|(?:gluten[- ]free|rice|glass|sweet potato|buckwheat|soba) (?:noodle|noodles|bread|pasta|pizza|bun|buns|wrap|wraps)|(?:cream of tartar|cocoa butter|coconut aminos)|(?:wine|rice|apple cider|balsamic) vinegar|(?:ginger|root) beer|beer-?free|egg-?free|dairy-?free|nut-?free)\b/gi;

const RULES = {
  'Gluten-Free': { label: 'gluten-free', terms: GLUTEN },
  'Dairy-Free': { label: 'dairy-free', terms: DAIRY },
  'Nut-Free': { label: 'nut-free', terms: NUTS },
  Halal: { label: 'halal', terms: [...PORK, ...ALCOHOL] },
  Kosher: { label: 'kosher', terms: [...PORK, ...SHELLFISH, ...KOSHER_ONLY] },
  'Shellfish-Free': { label: 'shellfish-free', terms: SHELLFISH },
};

for (const rule of Object.values(RULES)) {
  rule.re = new RegExp(`\\b(${rule.terms.join('|')})(?:e?s)?\\b`, 'i');
}

// Returns a corrective reason string for the first conflict, or null.
function findDietConflict(dishText, restrictions) {
  for (const r of restrictions || []) {
    // Nut-Free must still refuse nut milks/butters, so only strip the explicit label there.
    const text = String(dishText).replace(r === 'Nut-Free' ? /nut-?free/gi : SAFE, ' ');
    const rule = RULES[r] || Object.entries(RULES).find(([k]) => k.toLowerCase() === String(r).toLowerCase())?.[1];
    const m = rule && rule.re.exec(text);
    if (m) {
      return `the dish name/shared items mention "${m[1].toLowerCase()}", which conflicts with a ${rule.label} restriction; pick a candidate whose reviews support a compliant dish instead`;
    }
  }
  return null;
}

module.exports = { findDietConflict };
