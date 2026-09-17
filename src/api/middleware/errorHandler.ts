import type { ErrorRequestHandler, Request } from 'express';
import { ZodError } from 'zod';
import { logger } from '../../config/logger.ts';
import { INVALID_REQUEST_ERROR, invalidRequestErrorBody } from './validateBody.ts';

/**
 * The application's error handler (T9.1.1) — the recipient of every `next(error)` in this codebase.
 *
 * ARCHITECTURE Section 11 fixes what a failure is allowed to say to a browser, and its principle is
 * the whole of this file: *"any error that could reveal information useful for guessing another
 * student's identity, or that would expose internal implementation detail (stack traces, SQL, prompt
 * content), is reduced to a generic message before it reaches the browser. Everything else is logged
 * with full context server-side."*
 *
 * ## Why this exists, given that every route already answers its own refusals
 *
 * The routes do handle what they expect: a 400 for a malformed body, a 409 for a write to an already
 * submitted record, a 401 for a missing session. None of them handles the *unexpected* failure — a
 * dropped connection, a violated constraint, a bug — and every route ends its handler with
 * `next(error)` for exactly that case, because Express 4 does not forward a rejected promise from an
 * async handler on its own. Until now those calls fed Express's built-in handler, which answers
 * `text/html` with the stack embedded outside production. Section 11's table has no row that permits
 * that, so this is the handler those existing calls were always written to reach.
 *
 * ## Ordering, which is load-bearing
 *
 * Express dispatches error middleware in registration order, so one mounted before the routers would
 * never see their errors and this file would be inert. `createApp()` mounts it after every router.
 *
 * ## Response shape
 *
 * JSON `{ error }`, like every other refusal this API produces. The SPA's fetch wrapper parses one
 * shape, and a failure arriving as HTML would surface there as a parse error rather than as the
 * generic message Section 11 specifies.
 */

/**
 * The 500 body, in Section 11's own wording for its database-error row: *"500 with a generic
 * 'something went wrong, your answers are saved'"*.
 *
 * One message for every unexpected failure rather than one per route, because Section 11 reduces a
 * 500 to a generic message precisely so that the response says nothing about what went wrong
 * internally. The student's assessment is the long-lived flow here and the likeliest reader; a staff
 * member reading it on a failed dashboard load is unharmed by it, which is the smaller price than a
 * second message that would begin to describe the failure class back to the caller.
 */
const GENERIC_ERROR_MESSAGE = 'Something went wrong — your answers are saved';

/**
 * Express identifies error middleware by its four-argument signature, so `next` must stay declared
 * even where it goes unused. That is also why this is not built by a factory taking options: the
 * arity is part of the interface.
 */
export const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
  // A response already in flight cannot be replaced by an error status — the status line went out
  // with the first byte. The streamed CSV export is the real case (`csv.on('error', next)` in
  // `staff.routes.ts`): by the time a mid-stream failure is known the headers are long gone, so the
  // only honest ending is the one Express's own handler gives — destroy the connection, so the
  // client sees a broken download rather than a silently short file that looks complete.
  if (res.headersSent) {
    next(error);
    return;
  }

  // Section 11's validation row is normally answered one layer earlier, by `validateBody`, before any
  // handler runs. This is the backstop for a schema parsed somewhere else: the caller gets the same
  // field-level 400 rather than a 500 that hides what they got wrong. It reuses
  // `invalidRequestErrorBody` rather than restating the shape, so the 400 contract stays defined once.
  if (error instanceof ZodError) {
    res.status(400).json(invalidRequestErrorBody(error));
    return;
  }

  // A body the JSON parser could not read at all never reaches a route — `express.json()` raises its
  // own error, pre-classified as the caller's fault. Section 11 gives that the "Validation error" row
  // too ("Malformed autosave payload" → 400), so the status the error carries is honoured rather than
  // degraded to a 500. There are no `details` because there is no schema to name a field from.
  //
  // This is the convention Express's own default handler reads (`err.status || err.statusCode`), and
  // honouring the whole 4xx range rather than special-casing the parser keeps this behaviour
  // identical to what it replaced for every such error. A 5xx marked on an error is *not* honoured:
  // that is this server failing, and it is answered generically below.
  const clientStatus = clientErrorStatus(error);
  if (clientStatus !== null) {
    res.status(clientStatus).json({ error: INVALID_REQUEST_ERROR });
    return;
  }

  // Logged before the response, and logged *everything* — the reduction to a generic message is only
  // honest if the detail survives somewhere, which is what Section 11's "logged with full detail
  // server-side" column asks for on every row of its table.
  logServerError(error, req);

  res.status(500).json({ error: GENERIC_ERROR_MESSAGE });
};

/**
 * The status an error carries when the *caller*, not this server, is what went wrong — or null.
 *
 * Read defensively: anything can be thrown, including a string or `null`, so the property is checked
 * for type before it is used. Only 4xx is reported, because a 5xx is this server failing and must not
 * be able to describe itself to the client through a field some error happened to carry.
 */
function clientErrorStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;

  const { status, statusCode } = error as { status?: unknown; statusCode?: unknown };
  const candidate = typeof status === 'number' ? status : statusCode;

  if (typeof candidate !== 'number' || candidate < 400 || candidate >= 500) return null;

  return candidate;
}

/**
 * Full detail, server-side: what the browser is deliberately not told.
 *
 * Section 11's every row says "logged with full detail server-side", and the reduction to a generic
 * browser message is only honest if the detail survives here. `err` is pino's error key, so the
 * serialized line carries the type, the message, and the stack rather than the `{}` a plain object
 * spread of an `Error` would produce — `Object.keys(new Error('x'))` is empty, which is exactly how a
 * log line ends up saying nothing while looking correct.
 *
 * The method and URL are carried because a failure line without them does not say which request
 * failed, and at this scale there is no request id to join it to. The logger is the process-wide one
 * (T9.2.1), so this line is redacted, destination-configured, and greppable alongside every other.
 */
function logServerError(error: unknown, req: Request): void {
  logger.error(
    { event: 'request_failed', method: req.method, url: req.originalUrl, err: error },
    'request failed',
  );
}
