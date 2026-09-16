import { describe, expect, it } from 'vitest';
import { BCRYPT_COST, hashPassword, verifyPassword } from './passwordHasher.ts';

/**
 * Unit tests for the password hasher (T3.1.2).
 *
 * Nothing here touches the database or a route: the contract is "hash then verify round-trips,
 * anything else does not", and that is worth pinning down on its own before `StaffAuthService`
 * (T3.3.1) builds a login on it.
 *
 * bcrypt at cost 12 takes roughly a quarter-second per operation, so this file deliberately keeps
 * the number of hashes small — the same statements would take seconds longer without testing
 * anything further.
 */

const PASSWORD = 'correct horse battery staple';

describe('hashPassword', () => {
  it('produces a bcrypt hash at the cost factor from Section 13', async () => {
    const hash = await hashPassword(PASSWORD);

    // The `$2b$12$` prefix is bcrypt's own record of the algorithm and cost, so this asserts the
    // configured work factor is actually the one applied — not merely that a hash came back.
    expect(hash).toMatch(/^\$2b\$12\$/);
    expect(BCRYPT_COST).toBe(12);

    // The stored value never contains the password.
    expect(hash).not.toContain(PASSWORD);
  });

  it('salts each hash, so the same password never produces the same value twice', async () => {
    const [first, second] = await Promise.all([hashPassword(PASSWORD), hashPassword(PASSWORD)]);

    expect(first).not.toBe(second);
    // Both are still valid hashes of the same password — the salt changes the value, not the
    // answer.
    await expect(verifyPassword(PASSWORD, first)).resolves.toBe(true);
    await expect(verifyPassword(PASSWORD, second)).resolves.toBe(true);
  });
});

describe('verifyPassword', () => {
  it('accepts the matching password and rejects a wrong one', async () => {
    const hash = await hashPassword(PASSWORD);

    await expect(verifyPassword(PASSWORD, hash)).resolves.toBe(true);
    await expect(verifyPassword('Correct horse battery staple', hash)).resolves.toBe(false);
    await expect(verifyPassword('', hash)).resolves.toBe(false);
  });

  it('rejects a stored value that is not a bcrypt hash instead of failing the request', async () => {
    // `src/test/fixtures.ts` gives staff rows this placeholder by default, so "not a hash" is a
    // state the application genuinely meets. It must read as "does not match", not as a crash —
    // a 500 here would confirm to an attacker that the account exists.
    await expect(verifyPassword(PASSWORD, 'not-a-real-bcrypt-hash')).resolves.toBe(false);
    await expect(verifyPassword(PASSWORD, '')).resolves.toBe(false);
  });
});
