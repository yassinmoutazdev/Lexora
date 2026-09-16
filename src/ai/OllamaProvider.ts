import type { ZodType } from 'zod';
import { env } from '../config/env.ts';
import type { AIEvaluationService, StudentProblemsAnalysis, WritingEvaluation } from './AIEvaluationService.ts';
import { AIError, AIValidationError, AIRetryableError, AINonRetryableError } from './errors.ts';
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
 * - It maps failures to `AIValidationError`, `AIRetryableError`, `AINonRetryableError`.
 *
 * It does NOT:
 * - Compute an overall score (that is `WritingScoreCalculator`'s).
 * - Know about jobs, retries, or the database (those are `JobService`/`workerLoop`).
 * - Read `OLLAMA_API_KEY`/`OLLAMA_BASE_URL` from anywhere but the validated `env` object.
 * - Put student text into error messages (see `src/ai/errors.ts`).
 *
 * ## One request path, two prompts
 *
 * The two public methods differ in exactly three things: the prompt they build, the schema they
 * validate against, and the message they use for empty input. Everything between — the HTTP call,
 * the timeout, the status mapping, unwrapping Ollama's chat envelope, and the schema check — is
 * `complete()`. Written out twice the two copies were identical, which meant every fix to the
 * transport had to be made in both places and would eventually be made in one.
 */

/** The model used for evaluation. PROVISIONAL — PRD Section 23.2 item 4 defers the exact model. */
const MODEL_NAME = 'llama3.1:8b';

/** Request timeout in milliseconds (ARCHITECTURE Section 14). */
const REQUEST_TIMEOUT_MS = 60_000;

/** The system prompt that frames every evaluation request. */
const SYSTEM_PROMPT = `You are an expert English writing evaluator. Follow the rubric instructions exactly and return only the JSON object described. No prose, no markdown, no commentary.`;

function buildWritingPrompt(responseText: string, rubricInstructions: string): string {
  return `${rubricInstructions}\n\n---\n\nStudent response:\n${responseText}\n\n---\n\nReturn your assessment as a single JSON object and nothing else.`;
}

function buildStudentProblemsPrompt(responseText: string): string {
  return `You are analyzing a university student's open-text response about difficulties they face learning or using English. The response may be in English or Arabic.

Your task:
1. Produce an English-normalized representation of the response. If the response is in Arabic, translate it to natural English. If it is in English, clean it up (fix obvious typos, normalize punctuation) without changing the meaning.
2. Extract structured difficulty categories from the response. Each category must have a label (your own short wording) and a direct quote from the original response that supports it.

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

function mapHttpError(status: number, body: string): AIError {
  // Ollama Cloud returns 429 when its free-tier queue is full, 5xx for internal errors.
  // Both are retryable — the same request sent later may succeed.
  if (status === 429 || status >= 500) {
    return new AIRetryableError(`Ollama HTTP ${status}: ${body.slice(0, 200)}`);
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

    return this.complete(buildWritingPrompt(responseText, rubricInstructions), writingEvaluationSchema);
  }

  async processStudentProblemsText(responseText: string): Promise<StudentProblemsAnalysis> {
    if (!responseText || responseText.trim().length === 0) {
      throw new AINonRetryableError('Student Problems response text is empty');
    }

    return this.complete(buildStudentProblemsPrompt(responseText), studentProblemsAnalysisSchema);
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
  private async complete<T>(prompt: string, schema: ZodType<T>): Promise<T> {
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
              { role: 'system', content: SYSTEM_PROMPT },
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
        throw mapHttpError(response.status, body);
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
        parsed = JSON.parse(content);
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
