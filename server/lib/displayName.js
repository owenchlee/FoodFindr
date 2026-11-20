// Friend-facing names. Never derived from the email: the privacy policy says
// group members don't see it.
const MAX_LEN = 30;

// Returns the cleaned name, or null when the input is not an acceptable name.
function cleanDisplayName(input) {
  if (typeof input !== 'string' || /[<>]/.test(input)) return null;
  // Control, bidi and zero-width format characters are dropped.
  const name = input
    .replace(/[\u0000-\u001F\u007F-\u009F­​-‏‪-‮⁠-⁯﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return name.length >= 1 && name.length <= MAX_LEN ? name : null;
}

// Unique per user and contains nothing from the email.
function publicDisplayName(row) {
  return row.display_name || `Foodie #${row.id}`;
}

module.exports = { cleanDisplayName, publicDisplayName, MAX_LEN };
