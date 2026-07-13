const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, 'foodfindr.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    restaurant_name TEXT NOT NULL,
    dish TEXT,
    rating INTEGER NOT NULL,
    logged_at TEXT NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS preferences (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    favorite_cuisines TEXT NOT NULL DEFAULT '[]',
    dietary_restrictions TEXT NOT NULL DEFAULT '[]',
    spice_tolerance TEXT NOT NULL DEFAULT 'medium',
    price_tolerance INTEGER NOT NULL DEFAULT 2,
    updated_at TEXT NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS discovered_restaurants (
    place_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    city TEXT NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    first_seen_at TEXT NOT NULL
  )
`);

function insertVisit({ restaurantName, dish, rating }) {
  return db.prepare(`
    INSERT INTO visits (restaurant_name, dish, rating, logged_at)
    VALUES (?, ?, ?, ?)
    RETURNING *
  `).get(restaurantName, dish ?? null, rating, new Date().toISOString());
}

function listVisits() {
  return db.prepare(
    'SELECT * FROM visits ORDER BY logged_at DESC, id DESC LIMIT 50'
  ).all();
}

function getVisitHighlights(limit = 5) {
  return db.prepare(
    'SELECT * FROM visits ORDER BY logged_at DESC, id DESC LIMIT ?'
  ).all(limit);
}

function shapePreferences(row) {
  if (!row) return null;
  return {
    favoriteCuisines: JSON.parse(row.favorite_cuisines),
    dietaryRestrictions: JSON.parse(row.dietary_restrictions),
    spiceTolerance: row.spice_tolerance,
    priceTolerance: row.price_tolerance,
    updatedAt: row.updated_at
  };
}

function getPreferences() {
  return shapePreferences(db.prepare('SELECT * FROM preferences WHERE id = 1').get());
}

function savePreferences({ favoriteCuisines, dietaryRestrictions, spiceTolerance, priceTolerance }) {
  const row = db.prepare(`
    INSERT INTO preferences (id, favorite_cuisines, dietary_restrictions, spice_tolerance, price_tolerance, updated_at)
    VALUES (1, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      favorite_cuisines = excluded.favorite_cuisines,
      dietary_restrictions = excluded.dietary_restrictions,
      spice_tolerance = excluded.spice_tolerance,
      price_tolerance = excluded.price_tolerance,
      updated_at = excluded.updated_at
    RETURNING *
  `).get(
    JSON.stringify(favoriteCuisines),
    JSON.stringify(dietaryRestrictions),
    spiceTolerance,
    priceTolerance,
    new Date().toISOString()
  );

  return shapePreferences(row);
}

function recordDiscovered(restaurants, city) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO discovered_restaurants (place_id, name, city, lat, lng, first_seen_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const now = new Date().toISOString();
  for (const r of restaurants) {
    insert.run(r.id, r.name, city, r.lat, r.lng, now);
  }
}

function getProgress(city) {
  const discovered = db.prepare(
    'SELECT COUNT(*) AS count FROM discovered_restaurants WHERE city = ?'
  ).get(city).count;

  const visited = db.prepare(`
    SELECT COUNT(*) AS count FROM discovered_restaurants d
    WHERE d.city = ?
    AND EXISTS (
      SELECT 1 FROM visits v
      WHERE LOWER(TRIM(v.restaurant_name)) = LOWER(TRIM(d.name))
    )
  `).get(city).count;

  return { city, discovered, visited };
}

module.exports = {
  insertVisit, listVisits, getVisitHighlights,
  getPreferences, savePreferences,
  recordDiscovered, getProgress
};
