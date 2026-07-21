const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { computeStats, evaluateBadges } = require('./badges');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'foodfindr.db');
// node:sqlite creates the DB file itself but not its parent directory —
// matters on hosts like Azure App Service where DB_PATH points at a
// subfolder (e.g. /home/data/foodfindr.db) that won't exist on first run.
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    restaurant_name TEXT NOT NULL,
    dish TEXT,
    rating INTEGER NOT NULL,
    logged_at TEXT NOT NULL
  )
`);

const visitColumns = db.prepare('PRAGMA table_info(visits)').all();
if (!visitColumns.some(col => col.name === 'flavor_tags')) {
  db.exec('ALTER TABLE visits ADD COLUMN flavor_tags TEXT');
}
// Nullable: pre-account rows land here with no owner until the first signup
// claims them (see adoptLegacyData) — every new insert always sets it.
if (!visitColumns.some(col => col.name === 'user_id')) {
  db.exec('ALTER TABLE visits ADD COLUMN user_id INTEGER REFERENCES users(id)');
}

// `preferences` used to be a single global row enforced by CHECK (id = 1).
// That shape can't become multi-user in place (SQLite can't drop a CHECK or
// re-key a table with ALTER TABLE) — detect the old shape once, preserve it
// under a `_legacy` name for adoptLegacyData to claim, then (re)create the
// real per-user table.
const prefsColumns = db.prepare('PRAGMA table_info(preferences)').all();
if (prefsColumns.length > 0 && !prefsColumns.some(col => col.name === 'user_id')) {
  db.exec('ALTER TABLE preferences RENAME TO preferences_legacy');
}
db.exec(`
  CREATE TABLE IF NOT EXISTS preferences (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    favorite_cuisines TEXT NOT NULL DEFAULT '[]',
    dietary_restrictions TEXT NOT NULL DEFAULT '[]',
    spice_tolerance TEXT NOT NULL DEFAULT 'medium',
    price_tolerance INTEGER NOT NULL DEFAULT 2,
    updated_at TEXT NOT NULL
  )
`);

// Same story as `preferences`: `discovered_restaurants` used to key on
// place_id alone; per-user tracking needs a composite (user_id, place_id) key.
const discoveredColumns = db.prepare('PRAGMA table_info(discovered_restaurants)').all();
if (discoveredColumns.length > 0 && !discoveredColumns.some(col => col.name === 'user_id')) {
  db.exec('ALTER TABLE discovered_restaurants RENAME TO discovered_restaurants_legacy');
}
db.exec(`
  CREATE TABLE IF NOT EXISTS discovered_restaurants (
    user_id INTEGER NOT NULL REFERENCES users(id),
    place_id TEXT NOT NULL,
    name TEXT NOT NULL,
    city TEXT NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    first_seen_at TEXT NOT NULL,
    PRIMARY KEY (user_id, place_id)
  )
`);

function countUsers() {
  return db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
}

function insertUser({ email, passwordHash }) {
  return db.prepare(`
    INSERT INTO users (email, password_hash, created_at)
    VALUES (?, ?, ?)
    RETURNING id, email, created_at
  `).get(email, passwordHash, new Date().toISOString());
}

function getUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(email);
}

function getUserById(id) {
  return db.prepare('SELECT id, email, created_at FROM users WHERE id = ?').get(id);
}

function createSession({ token, userId, expiresAt }) {
  db.prepare(`
    INSERT INTO sessions (token, user_id, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(token, userId, new Date().toISOString(), expiresAt);
}

function getSessionWithUser(token) {
  return db.prepare(`
    SELECT s.token, s.expires_at, u.id AS user_id, u.email
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
  `).get(token);
}

function deleteSession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

// The account that adopts pre-existing (unowned) data must be the very first
// one ever created — call this right after inserting that first user.
function adoptLegacyData(userId) {
  db.prepare('UPDATE visits SET user_id = ? WHERE user_id IS NULL').run(userId);

  const legacyPrefsTable = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'preferences_legacy'"
  ).get();
  if (legacyPrefsTable) {
    const legacyRow = db.prepare('SELECT * FROM preferences_legacy WHERE id = 1').get();
    if (legacyRow) {
      db.prepare(`
        INSERT INTO preferences (user_id, favorite_cuisines, dietary_restrictions, spice_tolerance, price_tolerance, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        userId,
        legacyRow.favorite_cuisines,
        legacyRow.dietary_restrictions,
        legacyRow.spice_tolerance,
        legacyRow.price_tolerance,
        legacyRow.updated_at
      );
    }
    db.exec('DROP TABLE preferences_legacy');
  }

  const legacyDiscoveredTable = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'discovered_restaurants_legacy'"
  ).get();
  if (legacyDiscoveredTable) {
    db.prepare(`
      INSERT OR IGNORE INTO discovered_restaurants (user_id, place_id, name, city, lat, lng, first_seen_at)
      SELECT ?, place_id, name, city, lat, lng, first_seen_at FROM discovered_restaurants_legacy
    `).run(userId);
    db.exec('DROP TABLE discovered_restaurants_legacy');
  }
}

function insertVisit({ userId, restaurantName, dish, rating, flavorTags }) {
  return db.prepare(`
    INSERT INTO visits (restaurant_name, dish, rating, logged_at, flavor_tags, user_id)
    VALUES (?, ?, ?, ?, ?, ?)
    RETURNING *
  `).get(restaurantName, dish ?? null, rating, new Date().toISOString(), JSON.stringify(flavorTags || []), userId);
}

function getTopFlavors(userId, limit = 3) {
  const rows = db.prepare(
    "SELECT flavor_tags FROM visits WHERE user_id = ? AND rating >= 4 AND flavor_tags IS NOT NULL AND flavor_tags != '[]'"
  ).all(userId);

  const counts = new Map();
  for (const row of rows) {
    for (const tag of JSON.parse(row.flavor_tags)) {
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function listVisits(userId) {
  return db.prepare(
    'SELECT * FROM visits WHERE user_id = ? ORDER BY logged_at DESC, id DESC LIMIT 50'
  ).all(userId);
}

function getVisitHighlights(userId, limit = 5) {
  return db.prepare(
    'SELECT * FROM visits WHERE user_id = ? ORDER BY logged_at DESC, id DESC LIMIT ?'
  ).all(userId, limit);
}

function shapePreferences(row) {
  if (!row) return null;
  return {
    favoriteCuisines: JSON.parse(row.favorite_cuisines),
    dietaryRestrictions: JSON.parse(row.dietary_restrictions),
    spiceTolerance: row.spice_tolerance,
    updatedAt: row.updated_at
  };
}

function getPreferences(userId) {
  return shapePreferences(db.prepare('SELECT * FROM preferences WHERE user_id = ?').get(userId));
}

function savePreferences(userId, { favoriteCuisines, dietaryRestrictions, spiceTolerance }) {
  const row = db.prepare(`
    INSERT INTO preferences (user_id, favorite_cuisines, dietary_restrictions, spice_tolerance, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      favorite_cuisines = excluded.favorite_cuisines,
      dietary_restrictions = excluded.dietary_restrictions,
      spice_tolerance = excluded.spice_tolerance,
      updated_at = excluded.updated_at
    RETURNING *
  `).get(
    userId,
    JSON.stringify(favoriteCuisines),
    JSON.stringify(dietaryRestrictions),
    spiceTolerance,
    new Date().toISOString()
  );

  return shapePreferences(row);
}

function recordDiscovered(userId, restaurants, city) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO discovered_restaurants (user_id, place_id, name, city, lat, lng, first_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const now = new Date().toISOString();
  for (const r of restaurants) {
    insert.run(userId, r.id, r.name, city, r.lat, r.lng, now);
  }
}

// Streaks are computed from UTC calendar days (not per-user local time) —
// a deliberate simplification. Two visits logged the same UTC day only
// count once, so back-to-back logging in one sitting can't inflate a streak.
function getStreaks(userId) {
  const rows = db.prepare('SELECT logged_at FROM visits WHERE user_id = ? ORDER BY logged_at ASC').all(userId);
  if (rows.length === 0) {
    return { currentStreak: 0, longestStreak: 0, lastVisitDate: null };
  }

  const dayStrings = [];
  const seenDays = new Set();
  for (const row of rows) {
    const day = row.logged_at.slice(0, 10);
    if (!seenDays.has(day)) {
      seenDays.add(day);
      dayStrings.push(day);
    }
  }

  const days = dayStrings.map(d => Date.parse(`${d}T00:00:00Z`));

  let longestStreak = 1;
  let run = 1;
  for (let i = 1; i < days.length; i++) {
    run = (days[i] - days[i - 1] === 86400000) ? run + 1 : 1;
    longestStreak = Math.max(longestStreak, run);
  }

  const now = new Date();
  const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const lastDay = days[days.length - 1];
  const gapFromToday = (todayUTC - lastDay) / 86400000;

  let currentStreak = 0;
  if (gapFromToday <= 1) {
    currentStreak = 1;
    for (let i = days.length - 1; i > 0; i--) {
      if (days[i] - days[i - 1] === 86400000) currentStreak++;
      else break;
    }
  }

  return { currentStreak, longestStreak, lastVisitDate: dayStrings[dayStrings.length - 1] };
}

function getBadges(userId) {
  const rows = db.prepare(
    'SELECT rating, flavor_tags, logged_at FROM visits WHERE user_id = ? ORDER BY logged_at ASC'
  ).all(userId);
  return evaluateBadges(computeStats(rows, getStreaks(userId)));
}

// All registered users, even ones with zero visits — for a small friend
// group, seeing "you're at 0, a friend's at 12" is itself a nudge, and
// hiding inactive accounts would just look like the leaderboard is broken.
function getLeaderboardStats() {
  const users = db.prepare('SELECT id, email FROM users ORDER BY id ASC').all();
  const visitCountRows = db.prepare(
    'SELECT user_id, COUNT(*) AS count FROM visits WHERE user_id IS NOT NULL GROUP BY user_id'
  ).all();
  const visitCounts = new Map(visitCountRows.map(r => [r.user_id, r.count]));

  return users
    .map(u => {
      const streaks = getStreaks(u.id);
      return {
        userId: u.id,
        email: u.email,
        visitCount: visitCounts.get(u.id) || 0,
        currentStreak: streaks.currentStreak,
        longestStreak: streaks.longestStreak
      };
    })
    .sort((a, b) => b.visitCount - a.visitCount || b.longestStreak - a.longestStreak || a.userId - b.userId);
}

function getProgress(userId, city) {
  const discovered = db.prepare(
    'SELECT COUNT(*) AS count FROM discovered_restaurants WHERE user_id = ? AND city = ?'
  ).get(userId, city).count;

  const visited = db.prepare(`
    SELECT COUNT(*) AS count FROM discovered_restaurants d
    WHERE d.user_id = ? AND d.city = ?
    AND EXISTS (
      SELECT 1 FROM visits v
      WHERE v.user_id = d.user_id AND LOWER(TRIM(v.restaurant_name)) = LOWER(TRIM(d.name))
    )
  `).get(userId, city).count;

  return { city, discovered, visited };
}

module.exports = {
  countUsers, insertUser, getUserByEmail, getUserById,
  createSession, getSessionWithUser, deleteSession, adoptLegacyData,
  insertVisit, listVisits, getVisitHighlights, getTopFlavors,
  getPreferences, savePreferences,
  recordDiscovered, getProgress,
  getStreaks, getBadges, getLeaderboardStats
};
