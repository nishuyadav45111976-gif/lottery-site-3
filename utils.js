const crypto = require('crypto');

// Hash a password with a random salt using Node's built-in scrypt (no extra
// dependency needed). Returns "salt:hash", both hex-encoded.
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

// Compare a plain-text password against a "salt:hash" string produced by
// hashPassword(). Uses a constant-time comparison to avoid timing attacks.
function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const hashBuffer = Buffer.from(hash, 'hex');
  const candidateBuffer = crypto.scryptSync(password, salt, 64);
  if (hashBuffer.length !== candidateBuffer.length) return false;
  return crypto.timingSafeEqual(hashBuffer, candidateBuffer);
}

// Formats an ISO timestamp for display, e.g. "21 Aug 2026, 11:40 pm" (IST-friendly).
function formatTimestamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function slugify(text) {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '');
}

function makeId() {
  return crypto.randomUUID();
}

// Generate a one-time recovery code for a user account. The code is shown
// only at account creation/regeneration time; only its password-style hash is
// persisted in the database.
function makeRecoveryCode() {
  return crypto.randomBytes(6).toString('hex').toUpperCase();
}

// Keeps only the digits from a phone number, for building wa.me links
// (WhatsApp's click-to-chat links don't allow +, spaces, or dashes).
function digitsOnly(text) {
  return (text || '').replace(/[^0-9]/g, '');
}

// A lottery result should just be numbers (optionally several, separated by
// spaces/commas/dashes) — this catches accidental typos like stray letters
// before they get posted to the public site.
function isValidResultText(text) {
  return /^[0-9][0-9\s,.\-]*$/.test((text || '').trim());
}

module.exports = {
  slugify,
  makeId,
  makeRecoveryCode,
  digitsOnly,
  hashPassword,
  verifyPassword,
  formatTimestamp,
  isValidResultText,
};
