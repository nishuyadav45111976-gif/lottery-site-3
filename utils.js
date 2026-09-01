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

// Turns a name into a URL-safe slug ("Rewari Special" -> "rewari-special").
// Falls back to a short random id when the input has no a-z/0-9 characters
// at all (e.g. pure Hindi text) so a lottery never ends up with an empty or
// colliding slug.
function slugify(text) {
  const base = text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '');
  return base || `lottery-${crypto.randomBytes(4).toString('hex')}`;
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

// A phone number should have 10-15 digits once formatting (spaces, dashes,
// a leading +) is stripped — covers a plain 10-digit Indian mobile number
// up to a full number with country code. Empty is valid too, since the
// contact bar field is optional and blank just hides it.
function isValidPhoneNumber(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return true;
  const digits = digitsOnly(trimmed);
  return digits.length >= 10 && digits.length <= 15;
}

// A lottery result should just be numbers (optionally several, separated by
// spaces/commas/dashes) — this catches accidental typos like stray letters
// before they get posted to the public site. Pass `digits` (2 for normal
// lotteries, 3 for Special Lottery) to also require every individual number
// in the result be exactly that many digits long — useful for catching a
// result typed into the wrong lottery type. Omit it to keep the original,
// more permissive check (any digit-led string).
function isValidResultText(text, digits) {
  const trimmed = (text || '').trim();
  if (!/^[0-9][0-9\s,.\-]*$/.test(trimmed)) return false;
  if (!digits) return true;
  const tokens = trimmed.split(/[\s,.\-]+/).filter(Boolean);
  if (!tokens.length) return false;
  const re = new RegExp(`^\\d{${digits}}$`);
  return tokens.every((t) => re.test(t));
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
  isValidPhoneNumber,
};
