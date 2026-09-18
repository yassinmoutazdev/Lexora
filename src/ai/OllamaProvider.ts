import type { ZodType } from 'zod';
import { env } from '../config/env.ts';
import type { AIEvaluationService, StudentProblemsAnalysis, WritingEvaluation } from './AIEvaluationService.ts';
import {
  AIError,
  AIValidationError,
  AIRetryableError,
  AINonRetryableError,
  AIModelNotFoundError,
} from './errors.ts';
import { studentProblemsAnalysisSchema, writingEvaluationSchema } from './schemas.ts';

/**
 * The Ollama Cloud provider — the ONLY file that knows about Ollama (ARCHITECTURE Section 13,
 * Section 18).
 *
 * ## What this file does, and what it must not
 *
 * - It builds the fixed rubric prompt from the versioned `writingRubricInstructions`.
 * - It requests structured JSON from Ollama Cloud.
 * - It enforces a request timeout.
 * - It validates the response against `src/ai/schemas.ts` before returning.
 * - It maps failures to `AIValidationError`, `AIRetryableError`, `AINonRetryableError`,
 *   `AIModelNotFoundError`.
 *
 * It does NOT:
 * - Compute an overall score (that is `WritingScoreCalculator`'s).
 * - Know about jobs, retries, or the database (those are `JobService`/`workerLoop`).
 * - Read `OLLAMA_API_KEY`/`OLLAMA_BASE_URL` from anywhere but the validated `env` object.
 * - Put student text into error messages (see `src/ai/errors.ts`).
 *
 * ## One request path, two prompts
 *
 * The two public methods differ in exactly four things: the prompt they build, the system prompt
 * that frames it, the schema they validate against, and the message they use for empty input.
 * Everything between — the HTTP call,
 * the timeout, the status mapping, unwrapping Ollama's chat envelope, and the schema check — is
 * `complete()`. Written out twice the two copies were identical, which meant every fix to the
 * transport had to be made in both places and would eventually be made in one.
 */

/**
 * The model used for evaluation.
 *
 * Deployed against Ollama Cloud (Section 16), so the tag is the cloud variant. Verified against
 * Ollama's own model listing on 2026-09-17: `https://ollama.com/library/gemma4` advertises
 * `gemma4:31b-cloud`, and `https://ollama.com/library/gemma4:31b-cloud` resolves 200. The plausible
 * mis-spelling `gemma4:b31-cloud` is not a tag Ollama serves — worth recording, because a wrong tag
 * here fails the same silent way a wrong `OLLAMA_BASE_URL` does (see `AIModelNotFoundError`).
 *
 * The *choice* of model is still PRD Section 23.2 item 4's to make; this constant records which one
 * the deployment targets today, not a decision the audit made.
 */
const MODEL_NAME = 'gemma4:31b-cloud';

/** Request timeout in milliseconds (ARCHITECTURE Section 14). */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * The system prompts, one per call.
 *
 * These were a single constant until it was noticed what it said on the Student Problems call. It
 * read *"You are an expert English writing evaluator. Follow the rubric instructions exactly …"* —
 * sent to a request whose user message contains no rubric and whose job is to normalize a
 * description of learning difficulties, not to judge writing. The frame was not merely untidy: it
 * points the model at the student's English, which is the one thing FR-PROB-008 forbids this data
 * from influencing, and "follow the rubric instructions" named text that was not there.
 *
 * What both prompts still share is the output-form line, and it stays in the system prompt rather
 * than moving to the user message: it is a standing constraint on every response, and it is the
 * line `src/ai/schemas.ts` cites when it justifies `.strict()` (*"the rubric instructions already
 * ask for 'a single JSON object and nothing else'"*). Moving it would weaken that justification.
 *
 * Neither prompt contains Gemma 4's `<|think|>` token, and neither should: that token is what
 * enables the model's thinking mode, and thinking is off by default.
 */
const WRITING_SYSTEM_PROMPT = `You are an expert English writing evaluator. Follow the rubric instructions exactly and return only the JSON object described. No prose, no markdown, no commentary.`;

const STUDENT_PROBLEMS_SYSTEM_PROMPT = `You are analyzing a university student's own description of the difficulties they face in learning or using English. Your job is to record what the student says, not to judge their English: this response is never scored and must not be assessed, graded, or corrected. Follow the instructions exactly and return only the JSON object described. No prose, no markdown, no commentary.`;

function buildWritingPrompt(responseText: string, rubricInstructions: string): string {
  return `${rubricInstructions}\n\n---\n\nStudent response:\n${responseText}\n\n---\n\nReturn your assessment as a single JSON object and nothing else.`;
}

function buildStudentProblemsPrompt(responseText: string): string {
  return `The response may be written in English, in Arabic, or in a mixture of the two.

Your task:
1. Produce an English-normalized representation of the response. Translate any part written in Arabic into natural English. Clean up any part written in English (fix obvious typos, normalize punctuation) without changing the meaning. For a response that mixes the two, apply the rule to each part.
2. Extract structured difficulty categories from the response. Each category must have a label and a direct quote from the response that supports it.

For the categories:
- Quote in the student's own language and exact wording. The quote is the evidence staff check against the original response, so a translated quote would defeat its purpose.
- Write each label as a short noun phrase naming the difficulty itself — not a sentence, not a judgement about the student, and not a summary of the whole response.
- Word labels so that the same difficulty gets the same label from a different student. These labels are counted together across responses, and wording that varies per student splits one difficulty into several.
- Report each distinct difficulty once. Do not repeat a difficulty under different labels, and do not split one into near-duplicates.
- If the response describes no difficulty, return an empty array.

Return a single JSON object with exactly these fields:
- normalizedText: string (non-empty)
- categories: array of { label: string, evidence: string }

No prose, no markdown, no commentary.

Student response:
${responseText}`;
}

/**
 * Whether a thrown value is an abort — by `name`, not by `instanceof DOMException`.
 *
 * Node's `fetch` rejects with a `DOMException` today, but a stubbed transport (and older runtimes)
 * reject with a plain `Error` carrying the same name. Both are the same event, and the narrower
 * check quietly relabels a timeout as a generic network error: still retryable, so nothing breaks,
 * but the log line stops saying which of the two actually happened.
 */
function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

/**
 * The chat endpoint, derived from the configured base URL.
 *
 * Trailing slashes are stripped so `https://ollama.com/api` and `https://ollama.com/api/` resolve to
 * the same place. `OLLAMA_BASE_URL` is expected to carry Ollama's `/api` prefix — the value this was
 * written against is `https://ollama.com/api`. A base URL without it produces a 404, which maps to
 * `AINonRetryableError` and sends every evaluation to `failed_needs_review`: a misconfiguration that
 * looks from the dashboard exactly like a provider refusing to grade. The expectation is recorded
 * here, and in `.env.example`, rather than left to be discovered from that symptom.
 */
function chatEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat`;
}

/**
 * Removes a markdown code fence wrapping the body, if the model added one.
 *
 * `format: 'json'` is documented to constrain the response to JSON, and it does not guarantee a
 * *bare* body. Observed live against `gemma4:31b-cloud` (2026-09-17): a request whose prompt did not
 * explicitly forbid markdown came back as
 *
 *     ```json
 *     { "ok": true }
 *     ```
 *
 * which `JSON.parse` rejects outright — so the request that was supposed to be structurally
 * guaranteed was the one that failed validation.
 *
 * Both prompts currently forbid fences in so many words, and the model honours that: every
 * evaluation run through the real prompts during that same check came back unfenced. So this is a
 * backstop, not a repair. It is worth having because of what the instruction is: a sentence inside
 * versioned *content*, which someone editing the rubric could delete without knowing it was holding
 * up the entire parse. The failure it would cause is not a slightly worse grade but every
 * evaluation failing validation, spending its one retry, and landing on `failed_needs_review`.
 *
 * Deliberately narrow: it strips one fence at each end of the whole body and nothing else. It does
 * not hunt for embedded JSON, repair truncation, or coerce a malformed object — a response that is
 * genuinely wrong should still fail loudly.
 */
function stripCodeFence(content: string): string {
  return content.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '');
}

/**
 * Whether an error body is Ollama saying it does not have the model we asked for.
 *
 * Ollama's error for an unknown model names the model it could not find. Checking for the configured
 * tag rather than treating every 404 alike is deliberate: a 404 from a mistyped `OLLAMA_BASE_URL` is
 * a different fault with a different fix, and reporting it as "model not found" would send whoever
 * reads it to the wrong setting. When the body does not name the model the two cannot be told apart,
 * so the generic non-retryable failure — which is still the right *classification* for both — is the
 * honest answer.
 */
function namesTheModel(body: string, model: string): boolean {
  return body.includes(model);
}

function mapHttpError(status: number, body: string, model: string): AIError {
  // Ollama Cloud returns 429 when its free-tier queue is full, 5xx for internal errors.
  // Both are retryable — the same request sent later may succeed.
  if (status === 429 || status >= 500) {
    return new AIRetryableError(`Ollama HTTP ${status}: ${body.slice(0, 200)}`);
  }

  // The one 4xx worth its own name. Both this and a mistyped base URL land on non-retryable, and
  // that classification is right for both — retrying a tag that does not exist is pointless. What
  // the name adds is the diagnosis: without it, the whole queue failing at once reads from the
  // dashboard exactly like a provider refusing to grade (see `chatEndpoint`).
  if (status === 404 && namesTheModel(body, model)) {
    return new AIModelNotFoundError(
      `Ollama does not serve model ${JSON.stringify(model)} (HTTP 404). Check MODEL_NAME in ` +
        `src/ai/OllamaProvider.ts, and that OLLAMA_BASE_URL points at Ollama Cloud. ` +
        `Response: ${body.slice(0, 200)}`,
    );
  }

  // 4xx other than 429 suggests a bad request (e.g., invalid API key, malformed payload).
  // These are not retryable by sending the same request again.
  return new AINonRetryableError(`Ollama HTTP ${status}: ${body.slice(0, 200)}`);
}

export class OllamaProvider implements AIEvaluationService {
  private readonly endpoint: string;
  private readonly apiKey: string;

  constructor() {
    // These are validated at startup by `src/config/env.ts` (non-test environments), and `server.ts`
    // refuses to construct this provider without them.
    this.endpoint = chatEndpoint(env.OLLAMA_BASE_URL!);
    this.apiKey = env.OLLAMA_API_KEY!;
  }

  async evaluateWriting(responseText: string, rubricInstructions: string): Promise<WritingEvaluation> {
    if (!responseText || responseText.trim().length === 0) {
      throw new AINonRetryableError('Writing response text is empty');
    }

    return this.complete(
      buildWritingPrompt(responseText, rubricInstructions),
      WRITING_SYSTEM_PROMPT,
      writingEvaluationSchema,
    );
  }

  async processStudentProblemsText(responseText: string): Promise<StudentProblemsAnalysis> {
    if (!responseText || responseText.trim().length === 0) {
      throw new AINonRetryableError('Student Problems response text is empty');
    }

    return this.complete(
      buildStudentProblemsPrompt(responseText),
      STUDENT_PROBLEMS_SYSTEM_PROMPT,
      studentProblemsAnalysisSchema,
    );
  }

  /**
   * One structured-JSON completion: send, bound, unwrap, validate.
   *
   * ## What the timeout covers
   *
   * The whole exchange, not just the headers. The abort controller stays armed until the body has
   * been read, because a response that arrives and then stalls mid-body would otherwise hold the
   * single worker loop open indefinitely — and "a hung call cannot block the worker" (Section 14) is
   * a claim about the call, not about its first byte.
   */
  private async complete<T>(prompt: string, systemPrompt: string, schema: ZodType<T>): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      let response: Response;
      try {
        response = await fetch(this.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: MODEL_NAME,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: prompt },
            ],
            format: 'json',
            stream: false,
            options: { temperature: 0 },
          }),
          signal: controller.signal,
        });
      } catch (error) {
        if (isAbortError(error)) {
          throw new AIRetryableError(`Ollama request timed out after ${REQUEST_TIMEOUT_MS}ms`);
        }
        throw new AIRetryableError(`Ollama network error: ${(error as Error).message}`);
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '<unreadable>');
        throw mapHttpError(response.status, body, MODEL_NAME);
      }

      let data: unknown;
      try {
        data = await response.json();
      } catch (error) {
        // An abort here is the timeout firing mid-body, not malformed JSON. Calling it a validation
        // error would make the job non-retryable for a reason that has nothing to do with the model.
        if (isAbortError(error)) {
          throw new AIRetryableError(`Ollama request timed out after ${REQUEST_TIMEOUT_MS}ms`);
        }
        throw new AIValidationError('Ollama response is not valid JSON');
      }

      const content = (data as { message?: { content?: string } }).message?.content?.trim();
      if (!content) {
        throw new AIValidationError('Ollama response has no content');
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(stripCodeFence(content));
      } catch {
        throw new AIValidationError('Ollama response content is not valid JSON');
      }

      const validated = schema.safeParse(parsed);
      if (!validated.success) {
        const issues = validated.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join(', ');
        throw new AIValidationError(`Ollama output failed schema validation: ${issues}`);
      }

      return validated.data;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
