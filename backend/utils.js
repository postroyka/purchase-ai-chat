import { createHash, timingSafeEqual } from 'node:crypto';

// Constant-time string comparison with no length leak (#41). Hash both sides to a fixed 32-byte
// SHA-256 digest first: this sidesteps timingSafeEqual's equal-length requirement WITHOUT an early
// `length !== length` short-circuit (which leaked length via timing). SHA-256 is collision-resistant,
// so equal digests ⇒ equal inputs for our auth use. Shared by the Bearer check (index.js) and the
// cookie/credential checks (auth.js) so the two implementations never drift.
export function safeCompare(a, b) {
  const digest = (s) => createHash('sha256').update(Buffer.from(String(s), 'utf8')).digest();
  return timingSafeEqual(digest(a), digest(b));
}
