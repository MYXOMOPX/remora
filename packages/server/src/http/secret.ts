import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** R29: 32 random bytes as base64url (43 chars). */
export function generateSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** R29: at least 43 characters of [A-Za-z0-9_-]. */
export function isValidSecret(s: string): boolean {
  return /^[A-Za-z0-9_-]{43,}$/.test(s);
}

const sha256 = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

/**
 * Constant-time comparison: both sides are hashed first, so the compare always runs over
 * 32 bytes whatever the lengths are. An empty secret never matches.
 */
export function secretMatches(candidate: string, secret: string): boolean {
  const equal = timingSafeEqual(sha256(candidate), sha256(secret));
  return equal && secret.length > 0;
}
