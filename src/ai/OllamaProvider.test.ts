import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { OllamaProvider } from './OllamaProvider.ts';
import { AIValidationError, AIRetryableError, AINonRetryableError } from './errors.ts';
import type { WritingEvaluation, StudentProblemsAnalysis } from './AIEvaluationService.ts';

// Mock the validated env object
vi.mock('../config/env.ts', () => ({
  env: {
    OLLAMA_BASE_URL: 'https://ollama.com/api',
    OLLAMA_API_KEY: 'test-api-key',
  },
}));

/**
 * Unit coverage for `OllamaProvider` (T7.2.1–T7.2.2, ARCHITECTURE Section 15 — "test against a stubbed
 * HTTP layer, never real Ollama").
 *
 * The provider is tested by mocking `global.fetch`. The tests confirm request shape, timeout
 * enforcement, schema validation, and that no route/log line ever includes the API key.
 */

const VALID_WRITING_RESPONSE: WritingEvaluation = {
  criteriaScores: {
    grammarAccuracy: { score: 80, rationale: 'Good control of grammar.' },
    vocabulary: { score: 75, rationale: 'Varied vocabulary.' },
    sentenceStructure: { score: 85, rationale: 'Well-structured sentences.' },
    coherence: { score: 70, rationale: 'Ideas flow logically.' },
    taskCompletion: { score: 90, rationale: 'Addresses the prompt fully.' },
  },
  strengths: ['Clear position', 'Good examples'],
  weaknesses: ['Some repetition'],
  corrections: [
    { original: 'I think is important', corrected: 'I think it is important', explanation: 'Missing subject' },
  ],
  suggestions: ['Vary sentence openings'],
};

const VALID_PROBLEMS_RESPONSE: StudentProblemsAnalysis = {
  normalizedText: 'I find it difficult to speak in front of my classmates.',
  categories: [
    { label: 'Speaking anxiety', evidence: 'difficult to speak in front of my classmates' },
  ],
};

function mockFetch(response: Response) {
  return vi.spyOn(global, 'fetch').mockResolvedValue(response);
}

function makeResponse(body: unknown, ok = true, status = 200): Response {
  return new Response(JSON.stringify(body), { status, statusText: ok ? 'OK' : 'Error', headers: { 'Content-Type': 'application/json' } });
}

function makeErrorResponse(status: number, body: string): Response {
  return new Response(body, { status, statusText: 'Error', headers: { 'Content-Type': 'text/plain' } });
}

describe('OllamaProvider', () => {
  let provider: OllamaProvider;

  beforeEach(() => {
    provider = new OllamaProvider();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('evaluateWriting', () => {
    it('sends the correct request shape with rubric instructions and response text', async () => {
      mockFetch(makeResponse({ message: { content: JSON.stringify(VALID_WRITING_RESPONSE) } }));

      const rubricInstructions = 'Test rubric instructions.';
      const responseText = 'Student essay text.';

      const result = await provider.evaluateWriting(responseText, rubricInstructions);

      expect(result).toEqual(VALID_WRITING_RESPONSE);

      const fetchCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls as Array<[string, RequestInit]>;
      const fetchCall = fetchCalls[0]!;
      const [url, options] = fetchCall;

      expect(url).toBe('https://ollama.com/api/chat');
      expect(options.method).toBe('POST');
      expect((options.headers as Record<string, string>)['Content-Type']).toBe('application/json');
      expect((options.headers as Record<string, string>)['Authorization']).toBe('Bearer test-api-key');

      const body = JSON.parse(options.body as string);
      expect(body.model).toBe('llama3.1:8b');
      expect(body.format).toBe('json');
      expect(body.stream).toBe(false);
      expect(body.options.temperature).toBe(0);
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0].role).toBe('system');
      expect(body.messages[1].role).toBe('user');
      expect(body.messages[1].content).toContain(rubricInstructions);
      expect(body.messages[1].content).toContain(responseText);
    });

    it('throws AINonRetryableError for empty response text', async () => {
      await expect(provider.evaluateWriting('', 'rubric')).rejects.toThrow(AINonRetryableError);
      await expect(provider.evaluateWriting('   ', 'rubric')).rejects.toThrow(AINonRetryableError);
    });

    it('throws AIRetryableError on timeout', async () => {
      // Simulate timeout by making fetch respect the AbortSignal
      let abortSignal: AbortSignal | undefined;
      vi.spyOn(global, 'fetch').mockImplementation((_url, options) => {
        abortSignal = (options as RequestInit).signal as AbortSignal;
        return new Promise<Response>((_resolve, reject) => {
          if (abortSignal?.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
          } else {
            abortSignal?.addEventListener('abort', () => {
              reject(new DOMException('Aborted', 'AbortError'));
            });
          }
        });
      });

      const promise = provider.evaluateWriting('Student essay.', 'Rubric.');

      // The rejection handlers are attached *before* the timers advance. Adding them after would
      // work for the assertions, but the rejection would briefly have no handler — which Node
      // reports as an unhandled rejection and vitest prints as an error on every run.
      const throwsRetryable = expect(promise).rejects.toThrow(AIRetryableError);
      const namesTheTimeout = expect(promise).rejects.toThrow(/timed out after 60000ms/);

      // Advance timers past the 60s timeout
      await vi.advanceTimersByTimeAsync(60_001);

      await throwsRetryable;
      await namesTheTimeout;
    });

    it('throws AIRetryableError on network error', async () => {
      vi.spyOn(global, 'fetch').mockRejectedValue(new TypeError('fetch failed'));

      await expect(provider.evaluateWriting('Student essay.', 'Rubric.')).rejects.toThrow(AIRetryableError);
      await expect(provider.evaluateWriting('Student essay.', 'Rubric.')).rejects.toThrow(/network error/);
    });

    it('throws AIRetryableError on HTTP 429 (queue full)', async () => {
      mockFetch(makeErrorResponse(429, 'Rate limited'));

      await expect(provider.evaluateWriting('Student essay.', 'Rubric.')).rejects.toThrow(AIRetryableError);
      await expect(provider.evaluateWriting('Student essay.', 'Rubric.')).rejects.toThrow(/Ollama HTTP 429/);
    });

    it('throws AIRetryableError on HTTP 500', async () => {
      mockFetch(makeErrorResponse(500, 'Internal server error'));

      await expect(provider.evaluateWriting('Student essay.', 'Rubric.')).rejects.toThrow(AIRetryableError);
    });

    it('throws AINonRetryableError on HTTP 401', async () => {
      mockFetch(makeErrorResponse(401, 'Unauthorized'));

      await expect(provider.evaluateWriting('Student essay.', 'Rubric.')).rejects.toThrow(AINonRetryableError);
    });

    it('throws AIValidationError when Ollama response is not valid JSON', async () => {
      mockFetch(new Response('not json', { status: 200 }));

      await expect(provider.evaluateWriting('Student essay.', 'Rubric.')).rejects.toThrow(AIValidationError);
      await expect(provider.evaluateWriting('Student essay.', 'Rubric.')).rejects.toThrow(/not valid JSON/);
    });

    it('throws AIValidationError when Ollama message has no content', async () => {
      mockFetch(makeResponse({ message: {} }));

      let error: Error | undefined;
      try {
        await provider.evaluateWriting('Student essay.', 'Rubric.');
      } catch (e) {
        error = e as Error;
      }
      expect(error).toBeInstanceOf(AIValidationError);
      expect(error?.message).toMatch(/no content/);
    });

    it('throws AIValidationError when Ollama content is not valid JSON', async () => {
      mockFetch(makeResponse({ message: { content: 'not json' } }));

      await expect(provider.evaluateWriting('Student essay.', 'Rubric.')).rejects.toThrow(AIValidationError);
      await expect(provider.evaluateWriting('Student essay.', 'Rubric.')).rejects.toThrow(/not valid JSON/);
    });

    it('throws AIValidationError when schema validation fails', async () => {
      const invalidResponse = { ...VALID_WRITING_RESPONSE, criteriaScores: {} }; // Missing required criteria
      mockFetch(makeResponse({ message: { content: JSON.stringify(invalidResponse) } }));

      let error: Error | undefined;
      try {
        await provider.evaluateWriting('Student essay.', 'Rubric.');
      } catch (e) {
        error = e as Error;
      }
      expect(error).toBeInstanceOf(AIValidationError);
      expect(error?.message).toMatch(/schema validation/);
    });

    it('does not include the API key in any error message', async () => {
      // Section 13: the key lives in one header and nowhere else. Written with the assertions
      // *outside* the catch, because a `try`/`catch` whose expectations only run on the error path
      // passes silently the day the call stops throwing — which is the day this test is needed.
      mockFetch(makeErrorResponse(500, 'Server error'));

      const error = await provider
        .evaluateWriting('Student essay.', 'Rubric.')
        .then(() => null)
        .catch((thrown: unknown) => thrown as Error);

      expect(error).toBeInstanceOf(AIRetryableError);
      // The whole serialized error, not just `message`: a stack or a `cause` carrying the request
      // would leak just as effectively as a message would.
      const serialized = `${error?.message}\n${error?.stack ?? ''}\n${JSON.stringify(error, Object.getOwnPropertyNames(error ?? {}))}`;
      expect(serialized).not.toContain('test-api-key');
      expect(serialized).not.toContain('OLLAMA_API_KEY');
    });

    it('sends the API key only in the Authorization header', async () => {
      // The other half of the same requirement: not leaking it outward is worth little if it is
      // also sitting in the prompt, where it would reach the model and the provider's own logs.
      mockFetch(makeResponse({ message: { content: JSON.stringify(VALID_WRITING_RESPONSE) } }));

      await provider.evaluateWriting('Student essay.', 'Rubric.');

      const fetchCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls as Array<[string, RequestInit]>;
      const [url, options] = fetchCalls[0]!;

      expect((options.headers as Record<string, string>)['Authorization']).toBe('Bearer test-api-key');
      expect(options.body as string).not.toContain('test-api-key');
      expect(url).not.toContain('test-api-key');
    });
  });

  describe('processStudentProblemsText', () => {
    it('sends the correct request shape with student response text', async () => {
      mockFetch(makeResponse({ message: { content: JSON.stringify(VALID_PROBLEMS_RESPONSE) } }));

      const responseText = 'أجد صعوبة في التحدث أمام زملائي.';

      const result = await provider.processStudentProblemsText(responseText);

      expect(result).toEqual(VALID_PROBLEMS_RESPONSE);

      const fetchCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls as Array<[string, RequestInit]>;
      const fetchCall = fetchCalls[0]!;
      const [url, options] = fetchCall;

      // The same endpoint and the same credential as the writing call — one transport, asserted from
      // both entry points so a divergence between them cannot pass as "the other one covers it".
      expect(url).toBe('https://ollama.com/api/chat');
      expect((options.headers as Record<string, string>)['Authorization']).toBe('Bearer test-api-key');

      const body = JSON.parse(options.body as string);
      expect(body.model).toBe('llama3.1:8b');
      expect(body.messages[1].content).toContain(responseText);
    });

    it('throws AINonRetryableError for empty response text', async () => {
      await expect(provider.processStudentProblemsText('')).rejects.toThrow(AINonRetryableError);
      await expect(provider.processStudentProblemsText('   ')).rejects.toThrow(AINonRetryableError);
    });

    it('throws AIRetryableError on timeout', async () => {
      let abortSignal: AbortSignal | undefined;
      vi.spyOn(global, 'fetch').mockImplementation((_url, options) => {
        abortSignal = (options as RequestInit).signal as AbortSignal;
        return new Promise<Response>((_resolve, reject) => {
          if (abortSignal?.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
          } else {
            abortSignal?.addEventListener('abort', () => {
              reject(new DOMException('Aborted', 'AbortError'));
            });
          }
        });
      });

      const promise = provider.processStudentProblemsText('Student text.');

      // Attached before the timers advance — see the note on the `evaluateWriting` timeout test.
      const throwsRetryable = expect(promise).rejects.toThrow(AIRetryableError);
      const namesTheTimeout = expect(promise).rejects.toThrow(/timed out after 60000ms/);

      await vi.advanceTimersByTimeAsync(60_001);

      await throwsRetryable;
      await namesTheTimeout;
    });

    it('throws AIValidationError when schema validation fails', async () => {
      const invalidResponse = { normalizedText: '', categories: [] }; // normalizedText must be non-empty
      mockFetch(makeResponse({ message: { content: JSON.stringify(invalidResponse) } }));

      let error: Error | undefined;
      try {
        await provider.processStudentProblemsText('Student text.');
      } catch (e) {
        error = e as Error;
      }
      expect(error).toBeInstanceOf(AIValidationError);
      expect(error?.message).toMatch(/schema validation/);
    });

    it('maps HTTP 429 and 5xx to AIRetryableError', async () => {
      mockFetch(makeErrorResponse(429, 'Queue full'));
      await expect(provider.processStudentProblemsText('Student text.')).rejects.toThrow(AIRetryableError);

      mockFetch(makeErrorResponse(503, 'Service unavailable'));
      await expect(provider.processStudentProblemsText('Student text.')).rejects.toThrow(AIRetryableError);
    });

    it('maps HTTP 4xx (except 429) to AINonRetryableError', async () => {
      mockFetch(makeErrorResponse(400, 'Bad request'));
      await expect(provider.processStudentProblemsText('Student text.')).rejects.toThrow(AINonRetryableError);

      mockFetch(makeErrorResponse(401, 'Unauthorized'));
      await expect(provider.processStudentProblemsText('Student text.')).rejects.toThrow(AINonRetryableError);
    });
  });
});
