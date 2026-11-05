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

// Words Places' `types` array uses that aren't useful as a displayed "cuisine"
const GENERIC_PLACE_TYPES = new Set(['restaurant', 'food', 'point_of_interest', 'establishment']);

// Venues (hotels, gyms, spas) that carry a "restaurant" type just because they
// have in-house dining, not because they are one. Filter these out.
const NON_RESTAURANT_TYPES = new Set(['lodging', 'gym', 'spa', 'night_club', 'casino']);

function titleCase(str) {
  return str.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function placeToRestaurant(place, cuisineHint) {
  const specificType = place.types && place.types.find(t => !GENERIC_PLACE_TYPES.has(t));
  return {
    id: place.place_id,
    name: place.name,
    cuisine: cuisineHint ? titleCase(cuisineHint) : (specificType ? titleCase(specificType) : 'Restaurant'),
    price: place.price_level != null ? place.price_level : null,
    rating: place.rating != null ? place.rating : null,
    lat: place.geometry.location.lat,
    lng: place.geometry.location.lng
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
    .filter(place => !(place.types || []).some(t => NON_RESTAURANT_TYPES.has(t)))
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

module.exports = { distanceInMiles, titleCase, placeToRestaurant, shapeAndFilter };
