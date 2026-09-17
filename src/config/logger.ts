import pino from 'pino';

/**
 * The application's structured logger (T9.2.1) — one instance, configured once, for the whole process.
 *
 * ARCHITECTURE Section 16 fixes the destination and the format: *"structured JSON logs via `pino` to
 * stdout, captured by Render's built-in log viewer, including the staff data-access log lines
 * described in Section 13. No separate log aggregation service."* Every log line in this application
 * goes through this export; there is deliberately no second instance, no wrapper function adding a
 * second layer of shape, and no transport.
 *
 * ## Why it lives in `src/config/`
 *
 * Section 18 records the canonical location for the *log line* — `src/api/staff.routes.ts` — but names
 * no home for a logger, and Section 4's project structure does not either. `env.ts` is the other
 * process-level configuration module and already lives here, and what this file holds is exactly the
 * same kind of thing: the settings a process is built with, resolved once at import. The staff access
 * line itself does *not* move — Section 18 puts it at the route, and it stays there.
 *
 * ## Redaction (Section 13)
 *
 * Section 13 requires `pino` to be *"configured to redact any field literally named
 * `apiKey`/`authorization`"* as a defence in depth for the Ollama key, which is read only inside
 * `OllamaProvider` and must never reach a log. `censor` is `[Redacted]` rather than pino's default so
 * a redacted field is visibly redacted rather than looking like the string `[Redacted]` was the value.
 *
 * The `*.` paths are the ones that do the work. Section 13 names the two bare field names, but a
 * redaction path is matched against the *top level* of the object being logged — so `authorization`
 * catches `logger.info({ authorization })` and misses `logger.info({ headers: { authorization } })`,
 * which is the shape a request-derived field actually arrives in. A test pins that difference.
 *
 * **What this does not cover, stated so it is not assumed:** one `*` spans exactly one level, and
 * `fast-redact` has no recursive wildcard, so `{ req: { headers: { authorization } } }` is *not*
 * redacted — the secret sits two levels below a name that is matched. That is a real limit of
 * implementing "any field literally named `apiKey`" as a path list, and it is acceptable here for a
 * reason worth naming: nothing in this application logs a whole request object. Every field reaching
 * this logger is written out explicitly at its call site, so the depths in use are the two covered
 * above. A future `pino-http`-style request logger would change that, and would need these paths
 * extended — or the risky field picked apart at its call site instead.
 *
 * ## The destination is stdout, and it is named explicitly
 *
 * Section 13 and Section 16 both place these lines in stdout: *"an operational log, written to stdout
 * and viewable in Render's log dashboard alongside every other application log — it is not a database
 * table, not an audit-event model, and nothing else in the system reads it back."* So there is no file
 * destination, no rotation, and nothing that persists them anywhere else.
 *
 * `process.stdout` is passed rather than left to `pino`'s default fd-based destination. The two write
 * the same bytes to the same place; the difference is *when* the destination is resolved. The fd
 * destination binds at logger construction — which for a module-level logger is import time — while
 * naming the stream resolves `write` on every call. That makes these lines behave like every other
 * stdout write in the process, including a `process.stdout.write` interceptor, which is what lets the
 * tests observe the real lines in the real place rather than through a test hook this module would
 * otherwise have to grow. The cost is pino's fd fast path, which at pilot volume is not a cost.
 */
export const logger = pino(
  {
    redact: {
      paths: ['apiKey', 'authorization', '*.apiKey', '*.authorization'],
      censor: '[Redacted]',
    },
  },
  process.stdout,
);
