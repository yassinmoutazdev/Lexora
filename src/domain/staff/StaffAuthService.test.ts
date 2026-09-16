import { describe, expect, it } from 'vitest';
import { hashPassword } from '../../auth/passwordHasher.ts';
import { StaffUserRepository } from '../../data/StaffUserRepository.ts';
import { createStaffUser, useCleanTestDatabase } from '../../test/fixtures.ts';
import { StaffAuthService } from './StaffAuthService.ts';

/**
 * Tests for staff authentication (T3.3.1).
 *
 * ARCHITECTURE Section 15 lists this area as a unit test, and what it asserts is exactly that —
 * "correct credentials succeed; wrong password and unknown email are rejected identically". It runs
 * against the real test database rather than a stubbed repository, because the thing being trusted
 * is that a password verifies against the `passwordHash` column as it is actually stored; a fake
 * repository would assert that this service agrees with itself.
 *
 * Staff rows are created with a real bcrypt hash at the configured cost, since verification against
 * the fixtures' placeholder hash would only ever prove that failing is possible.
 */

const PASSWORD = 'correct horse battery staple';

function createService(): StaffAuthService {
  return new StaffAuthService({ staffUsers: new StaffUserRepository() });
}

async function createStaff(email: string, password = PASSWORD) {
  return createStaffUser({ email, passwordHash: await hashPassword(password) });
}

useCleanTestDatabase();

describe('StaffAuthService.authenticate', () => {
  it('authenticates correct credentials and returns the staff user id', async () => {
    const staff = await createStaff('staff@lexora.test');

    const result = await createService().authenticate('staff@lexora.test', PASSWORD);

    expect(result).toEqual({ outcome: 'authenticated', staffUserId: staff.id });
  });

  it('accepts an email with surrounding whitespace', async () => {
    const staff = await createStaff('staff@lexora.test');

    const result = await createService().authenticate('  staff@lexora.test ', PASSWORD);

    expect(result).toEqual({ outcome: 'authenticated', staffUserId: staff.id });
  });

  it('rejects a wrong password', async () => {
    await createStaff('staff@lexora.test');

    const result = await createService().authenticate('staff@lexora.test', 'not-the-password');

    expect(result).toEqual({ outcome: 'invalid_credentials' });
  });

  it('rejects an empty password rather than treating it as absent', async () => {
    await createStaff('staff@lexora.test');

    const result = await createService().authenticate('staff@lexora.test', '');

    expect(result).toEqual({ outcome: 'invalid_credentials' });
  });

  it('rejects an unknown email', async () => {
    await createStaff('staff@lexora.test');

    const result = await createService().authenticate('someone-else@lexora.test', PASSWORD);

    expect(result).toEqual({ outcome: 'invalid_credentials' });
  });

  it('gives byte-identical results for a wrong password and an unknown email', async () => {
    // The no-enumeration requirement: a caller must not be able to tell "this account exists but
    // you got the password wrong" from "there is no such account".
    await createStaff('staff@lexora.test');
    const service = createService();

    const wrongPassword = await service.authenticate('staff@lexora.test', 'not-the-password');
    const unknownEmail = await service.authenticate('someone-else@lexora.test', PASSWORD);

    expect(wrongPassword).toEqual(unknownEmail);
    expect(JSON.stringify(wrongPassword)).toBe(JSON.stringify(unknownEmail));
  });

  it('gives the same result when the account exists but the password is also wrong', async () => {
    await createStaff('staff@lexora.test');

    const result = await createService().authenticate('someone-else@lexora.test', 'not-the-password');

    expect(result).toEqual({ outcome: 'invalid_credentials' });
  });

  it('rejects a staff row whose stored hash is not usable, rather than failing the request', async () => {
    // `createStaffUser`'s default hash stands in for a corrupted or never-provisioned row.
    await createStaffUser({ email: 'broken@lexora.test' });

    const result = await createService().authenticate('broken@lexora.test', PASSWORD);

    expect(result).toEqual({ outcome: 'invalid_credentials' });
  });

  it('does not accept another staff member’s password', async () => {
    await createStaff('first@lexora.test', 'first-password');
    await createStaff('second@lexora.test', 'second-password');
    const service = createService();

    expect(await service.authenticate('first@lexora.test', 'second-password')).toEqual({
      outcome: 'invalid_credentials',
    });
    expect(await service.authenticate('first@lexora.test', 'first-password')).toEqual({
      outcome: 'authenticated',
      staffUserId: expect.any(String),
    });
  });
});
