import { randomUUID } from 'node:crypto';
import { hashPassword, verifyPassword } from '../../auth/passwordHasher.ts';
import {
  staffUserRepository,
  type StaffUserRepository,
} from '../../data/StaffUserRepository.ts';

/**
 * Staff authentication (ARCHITECTURE Section 18 — canonical location for "Staff
 * authentication/authorization").
 *
 * Staff are the only credentialed users in the system (PRD Section 9.7, NFR-SEC-003). This service
 * answers exactly one question — do these credentials belong to a staff account — and returns the
 * answer; it does not issue anything.
 *
 * ## Where the session is issued, and why it is not here
 *
 * T3.3.1's description reads "issues the staff session on success", but ARCHITECTURE Section 1 is
 * explicit that the domain layer is "framework-agnostic; does not import Express types or React",
 * and issuing a session means writing a cookie onto an Express response. Section 18 assigns
 * issuance to `src/auth/session.ts`, which is where `issueStaffSession` lives. So the flow is:
 * this service decides, the route (T3.3.2) issues. Keeping the decision here and the cookie there
 * is what lets this service be tested without an HTTP request at all.
 *
 * ## Not revealing whether an account exists
 *
 * A wrong password and an email with no account behind it produce the same outcome — the same
 * `invalid_credentials` result, and therefore the same response from the route — because
 * distinguishing them would turn the login form into a way to enumerate staff addresses
 * (Section 11's principle: any error revealing information useful for guessing an identity is
 * reduced to a generic message).
 *
 * The response is not the only channel, so the *work* is matched too: an unknown email still costs
 * one bcrypt comparison against a hash nothing can match. Without that, "no such account" would
 * return in microseconds while a real account took a quarter-second, and the timing difference
 * would say what the response refuses to.
 */

/** The outcome of a login attempt. Both refusals are spelled the same way, on purpose. */
export type StaffAuthentication =
  | { outcome: 'authenticated'; staffUserId: string }
  | { outcome: 'invalid_credentials' };

export type StaffAuthDeps = {
  staffUsers: StaffUserRepository;
};

const INVALID_CREDENTIALS: StaffAuthentication = { outcome: 'invalid_credentials' };

let placeholderHash: string | undefined;

/**
 * A valid bcrypt hash, at the configured cost, of a random value.
 *
 * Used only to spend the same time on a login for an unknown email as on one for a real account.
 * Generated per process from random bytes rather than written into the source as a literal: a
 * hash-shaped string in a repository is exactly the kind of thing that gets mistaken for a
 * credential, and this one deliberately matches nothing.
 */
async function getPlaceholderHash(): Promise<string> {
  placeholderHash ??= await hashPassword(randomUUID());
  return placeholderHash;
}

export class StaffAuthService {
  private readonly deps: StaffAuthDeps;

  constructor(deps: StaffAuthDeps) {
    this.deps = deps;
  }

  /**
   * Verifies staff credentials.
   *
   * The email is trimmed — a trailing space from a password manager or an autofilled field is a
   * near-certainty rather than a typo — and otherwise matched exactly as provisioned.
   *
   * Exactly one bcrypt comparison runs on every path, which is what keeps the two refusals
   * indistinguishable in time as well as in shape.
   */
  async authenticate(email: string, password: string): Promise<StaffAuthentication> {
    const staff = await this.deps.staffUsers.findByEmail(email.trim());

    const passwordMatches = await verifyPassword(
      password,
      staff?.passwordHash ?? (await getPlaceholderHash()),
    );

    return staff && passwordMatches ? { outcome: 'authenticated', staffUserId: staff.id } : INVALID_CREDENTIALS;
  }
}

let instance: StaffAuthService | undefined;

/** The process-wide service, wired to the shared repository. */
export function getStaffAuthService(): StaffAuthService {
  instance ??= new StaffAuthService({ staffUsers: staffUserRepository });
  return instance;
}
