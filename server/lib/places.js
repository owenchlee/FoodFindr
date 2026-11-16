function distanceInMiles(lat1, lng1, lat2, lng2) {
  const earthRadiusMiles = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return earthRadiusMiles * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// The legacy Places `types` array has no cuisine types, so cuisine is inferred
// from the place name (CUISINE_KEYWORDS) before falling back to types.
const EATERY_TYPES = new Set(['restaurant', 'cafe', 'bar', 'bakery', 'meal_takeaway', 'meal_delivery', 'food_court']);

// Hotels, gyms etc. with in-house dining, plus shops that text search returns.
const NON_EATERY_TYPES = new Set([
  'lodging', 'gym', 'spa', 'night_club', 'casino',
  'supermarket', 'grocery_or_supermarket', 'pharmacy', 'drugstore', 'convenience_store',
  'liquor_store', 'department_store', 'gas_station', 'shopping_mall', 'clothing_store',
  'home_goods_store', 'electronics_store', 'hardware_store', 'health'
]);

// Service styles and generic words, not cuisines.
const GENERIC_PLACE_TYPES = new Set([
  'restaurant', 'food', 'point_of_interest', 'establishment', 'store', 'meal_takeaway',
  'meal_delivery', 'bar', 'cafe', 'bakery', 'food_court', 'night_club', 'health', 'finance'
]);

// [label, regex source matched against the normalised name]. First match wins,
// so more specific entries come first.
const CUISINE_KEYWORDS = [
  ['Pizza', 'pizza|pizzeria|pizzas'],
  ['Sushi', 'sushi|sashimi|izakaya|omakase'],
  ['Ramen', 'ramen|udon|soba'],
  ['Korean BBQ', 'korean bbq|k-?bbq'],
  ['Korean', 'korean|bibimbap|kimchi|seoul'],
  ['Japanese', 'japanese|teriyaki|hibachi|teppanyaki|yakitori|tempura'],
  ['Dim Sum', 'dim sum|dumpling'],
  ['Chinese', 'chinese|szechuan|sichuan|cantonese|wok|panda|china|peking|beijing|hunan'],
  ['Vietnamese', 'vietnamese|pho|banh mi|saigon|hanoi'],
  ['Thai', 'thai|bangkok|pad thai'],
  ['Indian', 'indian|tandoor\\w*|curry|masala|biryani|punjabi|bombay|delhi|dosa|naan'],
  ['Mexican', 'mexican|taqueria|tacos?|burrito\\w*|cantina|taco|tamale\\w*|cocina|enchilada\\w*'],
  ['Greek', 'greek|gyro\\w*|souvlaki|taverna|athens'],
  ['Middle Eastern', 'shawarma|kebab|kabob|falafel|mediterranean|lebanese|persian|halal|hummus|turkish|middle eastern'],
  ['Italian', 'italian|trattoria|osteria|ristorante|pasta|italy|napoli|tuscan|roma'],
  ['French', 'french|bistro|brasserie|creperie|crepe\\w*'],
  ['Steakhouse', 'steakhouse|steak house|steaks?|chophouse|churrasco|grill house'],
  ['Seafood', 'seafood|oyster\\w*|lobster|crab|fish house|fish market|clam\\w*|shrimp'],
  ['BBQ', 'bbq|barbecue|barbeque|smokehouse|smoke house|brisket'],
  ['Burgers', 'burgers?|hamburger\\w*'],
  ['Chicken', 'chicken|wings?|fried chicken'],
  ['Sandwiches', 'sandwich\\w*|subs?|deli|hoagie\\w*'],
  ['Breakfast', 'breakfast|brunch|pancake\\w*|waffle\\w*|diner'],
  ['Vegan', 'vegan|vegetarian|plant based'],
  ['Ice Cream', 'ice cream|gelato|frozen yogurt|creamery'],
  ['Bakery', 'bakery|patisserie|donut\\w*|doughnut\\w*|bagel\\w*'],
  ['Coffee', 'coffee|espresso|roasters?|tea house|boba'],
  ['Cafe', 'cafe|cafeteria'],
  ['Caribbean', 'caribbean|jamaican|jerk'],
  ['Ethiopian', 'ethiopian|eritrean'],
  ['Spanish', 'spanish|tapas|paella'],
  ['Southern', 'southern|soul food|cajun|creole|bayou']
].map(([label, src]) => [label, new RegExp('(?:^|[^a-z0-9])(?:' + src + ')(?:$|[^a-z0-9])')]);

function normalise(name) {
  return ' ' + String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase() + ' ';
}

function titleCase(str) {
  return str.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function isEatery(place) {
  const types = place.types || [];
  return types.some(t => EATERY_TYPES.has(t)) && !types.some(t => NON_EATERY_TYPES.has(t));
}

function cuisineLabel(place) {
  const name = normalise(place.name);
  for (const [label, re] of CUISINE_KEYWORDS) if (re.test(name)) return label;
  const types = place.types || [];
  const specific = types.find(t => !GENERIC_PLACE_TYPES.has(t));
  if (specific) return titleCase(specific);
  if (!types.includes('restaurant') && !types.includes('meal_takeaway') && !types.includes('meal_delivery')) {
    if (types.includes('cafe')) return 'Cafe';
    if (types.includes('bakery')) return 'Bakery';
    if (types.includes('bar')) return 'Bar';
  }
  return 'Restaurant';
}

function placeToRestaurant(place, cuisineHint) {
  return {
    id: place.place_id,
    name: place.name,
    cuisine: cuisineHint ? titleCase(cuisineHint) : cuisineLabel(place),
    price: place.price_level != null ? place.price_level : null,
    rating: place.rating != null ? place.rating : null,
    ratingCount: place.user_ratings_total != null ? place.user_ratings_total : null,
    lat: place.geometry.location.lat,
    lng: place.geometry.location.lng,
    // null = Google gave no hours; treated as possibly open
    openNow: place.opening_hours && typeof place.opening_hours.open_now === 'boolean' ? place.opening_hours.open_now : null
  };
}

// Shared post-filter pipeline for both phase 1 and phase 2/cached responses,
// so the two can't drift and produce inconsistent markers. Price is
// deliberately NOT filtered here - it's never sent to Google either, and is
// applied entirely client-side (see applyLocalFilters in app.js) since it
// needs zero network round trips.
function shapeAndFilter(places, lat, lng, cuisine, maxDistance) {
  let results = places
    .filter(place => place.geometry && place.geometry.location)
    .filter(isEatery)
    .filter(place => !place.business_status || place.business_status === 'OPERATIONAL')
    .map(place => {
      const restaurant = placeToRestaurant(place, cuisine);
      return {
        ...restaurant,
        distance: Math.round(distanceInMiles(lat, lng, restaurant.lat, restaurant.lng) * 10) / 10
      };
    });
  if (maxDistance) {
    results = results.filter(r => r.distance <= Number(maxDistance));
  }
  return results;
}

module.exports = { distanceInMiles, titleCase, isEatery, cuisineLabel, placeToRestaurant, shapeAndFilter };
