import bcrypt from 'bcrypt';

/**
 * The single implementation of staff password hashing (T3.1.2), per ARCHITECTURE Section 13:
 * bcrypt at cost factor 12, never storing or logging a plaintext password.
 *
 * This exists as a wrapper rather than calling `bcrypt` at each site for one reason: the seed
 * script (T2.3.1) and `StaffAuthService` (T3.3.1) must agree on the algorithm and the cost factor.
 * If they did not — a seed hashed at one cost and a verifier expecting another — the failure would
 * be "the password I just seeded does not work", which is a slow thing to diagnose and an easy
 * thing to prevent. One module, one cost constant.
 *
 * Cryptography is deliberately *not* reimplemented or tuned here: the wrapper chooses a cost and
 * forwards, and nothing else in the codebase imports `bcrypt` directly.
 */

/**
 * bcrypt work factor (ARCHITECTURE Section 13). Each increment doubles the work; 12 is the
 * documented value and is the reason a login costs roughly a quarter-second by design.
 */
export const BCRYPT_COST = 12;

/** Hashes a plaintext password for storage. */
export async function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, BCRYPT_COST);
}

/**
 * Whether a plaintext password matches a stored hash.
 *
 * Returns false rather than throwing for a stored value that is not a valid bcrypt hash — which
 * `bcrypt.compare` already does, and which is the answer the domain layer wants. A row whose
 * `passwordHash` is missing, truncated, or a fixture placeholder authenticates nobody; that is a
 * "no match", not a server error, and turning it into a 500 would only tell an attacker that the
 * account exists.
 *
 * The comparison is bcrypt's own, so it is constant-time with respect to the hash: a caller cannot
 * learn how much of a candidate password was correct from how long this takes.
 */
export async function verifyPassword(plaintext: string, passwordHash: string): Promise<boolean> {
  return bcrypt.compare(plaintext, passwordHash);
}
