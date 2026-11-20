// Offline "too guessable" check (NIST SP 800-63B: block common and context-specific passwords).
// Kept apart from isValidPassword so existing accounts and signup() keep working.
const COMMON = new Set([
  'password', 'passw0rd', 'p@ssw0rd', 'passw0rd1', 'letmein1', 'trustno1', 'iloveyou', 'sunshine', 'princess',
  'football', 'baseball', 'superman', 'starwars', 'whatever', 'jennifer', 'computer', 'internet', 'michael1',
  'monkey123', 'dragon12', 'shadow12', 'master123', 'admin123', 'administrator', 'changeme', 'letmein123',
  'qwertyui', 'qwertyuiop', 'qwerty12', 'qwerty123', 'qwerty1234', 'asdfghjk', 'asdfghjkl', 'asdf1234',
  'zxcvbnm1', 'zxcvbnm123', 'abc12345', 'abcd1234', 'abcdefgh', 'abcdefghi', 'abc123456', '1q2w3e4r',
  '1qaz2wsx', 'zaq12wsx', '1q2w3e4r5t', '12345678', '123456789', '1234567890', '12345678910', '87654321',
  '987654321', '9876543210', '11223344', '123321123', '147258369', '123qweasd', 'qazwsxedc'
]);
// Common stems with optional digits / trailing punctuation: password123, Welcome1!, iloveyou2.
const STEM = /^(password|passw0rd|p@ssw0rd|welcome|letmein|iloveyou|qwerty|admin|login|monkey|dragon|football)[0-9]*[!@#$.]?$/;
// foodfindr / foodfinder anywhere, ignoring case.
const APP = /food\s*find(r|er)/;

// True when `password` is too easy to guess. `email` adds the context-specific checks.
function isWeakPassword(password, email) {
  const p = String(password).toLowerCase();
  if (COMMON.has(p) || STEM.test(p) || APP.test(p)) return true;
  if (/^(.+?)\1+$/.test(p)) return true; // aaaaaaaa, abababab, 12341234
  if (typeof email === 'string' && email) {
    const e = email.trim().toLowerCase();
    if (p === e || p === e.split('@')[0]) return true;
  }
  return false;
}

const WEAK_MESSAGE = 'That password is too easy to guess. Pick something less common.';

module.exports = { isWeakPassword, WEAK_MESSAGE };
