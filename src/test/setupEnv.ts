/**
 * Test-safe environment defaults, loaded by vitest before any test module.
 *
 * `src/config/env.ts` validates configuration on import and throws when a required variable is
 * missing. The suite has to pass on a clean checkout with no `.env` file, so this supplies the
 * minimum required values. They are deliberately obvious placeholders rather than plausible
 * credentials — a test that ever reached a real service with these would fail loudly.
 *
 * Assignments use `??=` so an explicitly provided environment (CI secrets, a developer's shell)
 * still wins. They run before `env.ts` calls `dotenv.config()`, and dotenv never overwrites an
 * already-set variable, so these also take precedence over a local `.env`.
 *
 * `DATABASE_URL` pointedly does not point at a real database: database-backed tests use
 * `DATABASE_URL_TEST` (T1.2.2), so the suite can never truncate a developer's working database
 * by accident.
 */
process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgresql://placeholder:placeholder@localhost:5432/lexora_unused';
process.env.SESSION_SECRET ??= 'test-only-session-secret-not-used-outside-the-suite';

// OLLAMA_API_KEY / OLLAMA_BASE_URL are intentionally left unset: they are not required under
// NODE_ENV=test, and leaving them absent proves the suite never depends on Ollama being
// reachable (ARCHITECTURE Section 15).
