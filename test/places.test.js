const test = require('node:test');
const assert = require('node:assert');
const { distanceInMiles, titleCase, placeToRestaurant, shapeAndFilter } = require('../server/lib/places');

const place = (o = {}) => ({
  place_id: 'p1', name: 'Taco Spot', types: ['mexican_restaurant', 'restaurant', 'food'],
  price_level: 2, rating: 4.5, geometry: { location: { lat: 40.0, lng: -75.0 } }, ...o
});

test('titleCase', () => assert.strictEqual(titleCase('thai_food'), 'Thai Food'));

test('distanceInMiles: zero, and ~69 miles per degree of latitude', () => {
  assert.strictEqual(distanceInMiles(40, -75, 40, -75), 0);
  assert.ok(Math.abs(distanceInMiles(40, -75, 41, -75) - 69) < 0.5);
});

test('placeToRestaurant maps fields the frontend reads', () => {
  assert.deepStrictEqual(placeToRestaurant(place()), {
    id: 'p1', name: 'Taco Spot', cuisine: 'Mexican Restaurant', price: 2, rating: 4.5, ratingCount: null, lat: 40, lng: -75
  });
  assert.strictEqual(placeToRestaurant(place({ user_ratings_total: 812 })).ratingCount, 812);
});

test('placeToRestaurant: cuisine hint wins, generic types fall back, missing price/rating are null', () => {
  assert.strictEqual(placeToRestaurant(place(), 'thai').cuisine, 'Thai');
  assert.strictEqual(placeToRestaurant(place({ types: ['restaurant', 'food'] })).cuisine, 'Restaurant');
  const r = placeToRestaurant(place({ price_level: undefined, rating: undefined }));
  assert.strictEqual(r.price, null);
  assert.strictEqual(r.rating, null);
  assert.strictEqual(placeToRestaurant(place({ price_level: 0 })).price, 0);
});

test('shapeAndFilter drops non-restaurants, closed places and places without geometry', () => {
  const out = shapeAndFilter([
    place({ place_id: 'ok' }),
    place({ place_id: 'hotel', types: ['lodging', 'restaurant'] }),
    place({ place_id: 'closed', business_status: 'CLOSED_PERMANENTLY' }),
    place({ place_id: 'nogeo', geometry: undefined }),
    place({ place_id: 'open', business_status: 'OPERATIONAL' })
  ], 40, -75, null, null);
  assert.deepStrictEqual(out.map(r => r.id), ['ok', 'open']);
  assert.strictEqual(out[0].distance, 0);
});

test('shapeAndFilter distance filter keeps places within maxDistance miles', () => {
  const near = place({ place_id: 'near', geometry: { location: { lat: 40.01, lng: -75 } } }); // ~0.7mi
  const far = place({ place_id: 'far', geometry: { location: { lat: 40.1, lng: -75 } } }); // ~6.9mi
  assert.deepStrictEqual(shapeAndFilter([near, far], 40, -75, null, 2).map(r => r.id), ['near']);
  assert.deepStrictEqual(shapeAndFilter([near, far], 40, -75, null, '10').map(r => r.id), ['near', 'far']);
  assert.deepStrictEqual(shapeAndFilter([near, far], 40, -75, null, 0).map(r => r.id), ['near', 'far']); // 0 = no limit
  assert.strictEqual(shapeAndFilter([far], 40, -75, null, null)[0].distance, 6.9);
});
