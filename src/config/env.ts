import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

/** Repository root, resolved from this file's location so it holds in both `src/` and `dist/`. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// A missing .env is normal in production, where the host injects real environment variables,
// so the return value is ignored on purpose. dotenv never overwrites an already-set variable,
// which means a real environment always wins over a stray local .env file.
dotenv.config({ path: path.join(REPO_ROOT, '.env') });

/**
 * Only the two variables that need coercion or a default are parsed by zod. Every other value is
 * read manually below so that presence and format problems are all collected and reported
 * together — a config error that reveals one missing variable per attempt is a papercut on every
 * fresh checkout.
 */
const defaultsSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
});

export type Env = {
  NODE_ENV: 'development' | 'test' | 'production';
  PORT: number;
  DATABASE_URL: string;
  DATABASE_URL_TEST: string | undefined;
  SESSION_SECRET: string;
  /** Optional under NODE_ENV=test: the suite always uses FakeAIEvaluationService. */
  OLLAMA_API_KEY: string | undefined;
  OLLAMA_BASE_URL: string | undefined;
};

type EnvIssue = { path: string; message: string };

function readEnvVar(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

/** Records an issue and returns a placeholder; the caller throws before the placeholder escapes. */
function requireEnvVar(value: string | undefined, key: string, issues: EnvIssue[]): string {
  if (value) return value;
  issues.push({ path: key, message: 'Required' });
  return '';
}

function checkAbsoluteUrl(value: string | undefined, key: string, issues: EnvIssue[]): string | undefined {
  if (!value) return undefined;
  try {
    new URL(value);
    return value;
  } catch {
    issues.push({ path: key, message: 'must be a valid absolute URL' });
    return undefined;
  }
}

function configurationError(issues: EnvIssue[]): Error {
  const details = issues.map((issue) => `  - ${issue.path}: ${issue.message}`).join('\n');

  return new Error(
    `Invalid environment configuration:\n${details}\n\n` +
      'Copy .env.example to .env and fill in the missing values. See ARCHITECTURE Section 16.',
  );
}

function loadEnv(): Env {
  const parsedDefaults = defaultsSchema.safeParse(process.env);

  if (!parsedDefaults.success) {
    throw configurationError(
      parsedDefaults.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
    );
  }

  const { NODE_ENV, PORT } = parsedDefaults.data;
  const issues: EnvIssue[] = [];

  const DATABASE_URL = requireEnvVar(readEnvVar('DATABASE_URL'), 'DATABASE_URL', issues);
  const SESSION_SECRET = requireEnvVar(readEnvVar('SESSION_SECRET'), 'SESSION_SECRET', issues);

  if (SESSION_SECRET && SESSION_SECRET.length < 32) {
    issues.push({
      path: 'SESSION_SECRET',
      message: 'must be at least 32 characters — it signs both session cookies',
    });
  }

  const OLLAMA_API_KEY = readEnvVar('OLLAMA_API_KEY');
  const OLLAMA_BASE_URL = readEnvVar('OLLAMA_BASE_URL');

  if (NODE_ENV !== 'test') {
    requireEnvVar(OLLAMA_API_KEY, 'OLLAMA_API_KEY', issues);
    requireEnvVar(OLLAMA_BASE_URL, 'OLLAMA_BASE_URL', issues);
  }

  checkAbsoluteUrl(OLLAMA_BASE_URL, 'OLLAMA_BASE_URL', issues);

  if (issues.length > 0) throw configurationError(issues);

  return {
    NODE_ENV,
    PORT,
    DATABASE_URL,
    DATABASE_URL_TEST: readEnvVar('DATABASE_URL_TEST'),
    SESSION_SECRET,
    OLLAMA_API_KEY,
    OLLAMA_BASE_URL,
  };
}

/**
 * Validated environment configuration.
 *
 * Validated on import so the process fails before it binds a port or accepts a request, rather
 * than at the first request that happens to need a variable.
 */
export const env: Env = loadEnv();
