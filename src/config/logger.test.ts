import { describe, expect, it } from 'vitest';
import { logger } from './logger.ts';

/**
 * The logging configuration (T9.2.1) — ARCHITECTURE Section 13: *"`pino` is configured to redact any
 * field literally named `apiKey`/`authorization` as a defense-in-depth measure"*, and Section 16:
 * *"structured JSON logs via `pino` to stdout, captured by Render's built-in log viewer."*
 *
 * ## Why this asserts through the application's logger rather than a local one
 *
 * E8 proved redaction by constructing a `pino` instance inside the test with the same `redact`
 * configuration copied into it. That test passes whether or not the application's own logger redacts
 * anything — it tests the copy. The config is now defined once, in `src/config/logger.ts`, so what is
 * asserted here is the object every log line in the process actually goes through: delete a path from
 * the real configuration and these fail.
 */

/**
 * Runs `fn` with everything written to stdout collected.
 *
 * Section 16 puts these lines in stdout, and `logger.ts` passes `process.stdout` explicitly so that
 * this interception is possible at all — a default fd destination binds at import time and would be
 * invisible here. That choice is documented at the logger; this is the test it exists for.
 */
async function captureStdout<T>(fn: () => T): Promise<{ result: T; output: string }> {
  const original = process.stdout.write.bind(process.stdout);
  let output = '';

  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    output += String(chunk);
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;

  try {
    return { result: fn(), output };
  } finally {
    process.stdout.write = original;
  }
}

/** The parsed JSON objects in captured output, one per log line. */
function logLines(output: string): Record<string, unknown>[] {
  return output
    .split('\n')
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('the application logger', () => {
  it('redacts a top-level apiKey and authorization (Section 13)', async () => {
    const { output } = await captureStdout(() => {
      logger.info(
        { apiKey: 'sk-live-secret', authorization: 'Bearer sk-live-secret', event: 'probe' },
        'probe',
      );
    });

    expect(output).not.toContain('sk-live-secret');
    expect(output).toContain('[Redacted]');

    const [line] = logLines(output);
    expect(line).toMatchObject({ apiKey: '[Redacted]', authorization: '[Redacted]' });
  });

  it('redacts a nested apiKey and authorization, which the bare paths do not reach', async () => {
    // The reason `logger.ts` carries the `*.` forms alongside the two names Section 13 spells out:
    // a redaction path matches against the logged object's top level, so `authorization` alone
    // catches `logger.info({ authorization })` and misses a field one level down. Without this test
    // the `*.` paths look like redundant spelling; with the bare paths removed it fails.
    const { output } = await captureStdout(() => {
      logger.info(
        { event: 'probe', headers: { authorization: 'Bearer sk-live-secret' } },
        'probe',
      );
    });

    expect(output).not.toContain('sk-live-secret');

    const [line] = logLines(output);
    expect(line).toMatchObject({ headers: { authorization: '[Redacted]' } });
  });

  it('leaves an unrelated field alone, so redaction is not a blanket censor', async () => {
    // The complement of the two tests above, and the reason they mean something: a configuration that
    // redacted every string would satisfy them without redacting anything in particular.
    const { output } = await captureStdout(() => {
      logger.info({ event: 'probe', submissionId: 'abc-123', note: 'Bearer' }, 'probe');
    });

    const [line] = logLines(output);

    expect(line).toMatchObject({ submissionId: 'abc-123', note: 'Bearer' });
  });

  it('writes one JSON object per line to stdout, not a formatted string', async () => {
    const { output } = await captureStdout(() => {
      logger.info({ event: 'probe', port: 3000 }, 'server listening');
    });

    const [line] = logLines(output);

    // Parseable as a single object, which is what "structured JSON logs" buys Render's viewer and an
    // operator's grep. `msg` is pino's own message field name.
    expect(line).toMatchObject({ event: 'probe', port: 3000, msg: 'server listening' });
    expect(typeof line?.['level']).toBe('number');
  });
});
