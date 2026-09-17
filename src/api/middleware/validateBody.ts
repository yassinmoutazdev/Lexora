import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ZodTypeAny } from 'zod';

/**
 * Request-body validation for the API boundary (T3.2.3).
 *
 * ARCHITECTURE Section 10: "Every request body is validated against a `zod` schema before it
 * reaches a domain service — malformed input never reaches business logic." This middleware is
 * where that happens, and Section 11 gives the failure its own row in the error table: a `zod`
 * parse failure is *caught by the middleware*, never by the domain layer.
 *
 * ## Why validation is allowed to be specific when an identity refusal must not be
 *
 * The two 400s this API produces mean different things and say different things. An identity that
 * does not resolve (T3.2.2) is refused generically, because naming the field would help a student
 * guess another student's details. A body that is the wrong *shape* is the opposite case: the
 * caller already knows what they sent, no one else's data is implicated, and a field-level message
 * is what Section 11 asks for — it is the difference between "something is wrong" and "rollNumber
 * is required" for the person building the frontend against this endpoint.
 *
 * ## On not reshaping what it validates
 *
 * The schemas used with this middleware deliberately do **not** transform their input. Trimming or
 * case-folding belongs to `StudentIdentityService`, which stores the roll number as typed for
 * display and normalizes only what it compares (ARCHITECTURE Section 6). If validation trimmed
 * here, the value the database records as "as typed" would be a value nobody typed, and the two
 * layers would disagree about what raw means.
 */

/**
 * The `error` string every 400 carries.
 *
 * Exported because the error handler answers this same failure class for a body the parser could not
 * read at all (T9.1.1): there is no schema to name a field from in that case, so there are no
 * `details`, but it is the same refusal and it has to read the same to the client.
 */
export const INVALID_REQUEST_ERROR = 'Invalid request body';

/**
 * The 400 body a `zod` refusal produces.
 *
 * Exported because the dashboard's cohort filter is validated from the *query* string rather than
 * from a body (T8.1.3), and a route that spelled this shape for itself would be a second definition
 * of one response contract — the thing Section 10's "malformed input never reaches business logic"
 * is enforced through, and therefore the last place two copies should be allowed to drift.
 */
export function invalidRequestErrorBody(error: z.ZodError): {
  error: string;
  details: { field: string; message: string }[];
} {
  return {
    error: INVALID_REQUEST_ERROR,
    details: error.issues.map((issue) => ({
      field: issue.path.join('.') || '(root)',
      message: issue.message,
    })),
  };
}

/**
 * Wraps a `zod` schema as an Express middleware.
 *
 * On success the parsed value *replaces* `req.body`, so everything downstream reads the schema's
 * output rather than the raw payload — which is also what strips unknown keys, so a request cannot
 * smuggle extra fields past the schema into a service.
 */
export function validateBody(schema: ZodTypeAny): RequestHandler {
  return function validateBodyMiddleware(req, res, next) {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      res.status(400).json(invalidRequestErrorBody(result.error));
      return;
    }

    req.body = result.data;

    next();
  };
}

/**
 * A required string that must contain something other than whitespace.
 *
 * `z.string().trim().min(1)` would say the same thing, but it *rewrites* the value it approves.
 * This rejects a blank field while leaving the value exactly as it arrived, which is what lets the
 * service keep storing the raw roll number verbatim.
 */
export function requiredText(field: string): ZodTypeAny {
  return z
    .string({
      required_error: `${field} is required`,
      invalid_type_error: `${field} must be a string`,
    })
    .refine((value) => value.trim().length > 0, { message: `${field} must not be blank` });
}
