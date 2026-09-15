import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The application under test is a Node server, not a DOM. Browser-side tests, if any are
    // ever needed, would opt into a different environment explicitly.
    environment: 'node',

    include: ['src/**/*.test.ts'],

    // Supplies the minimum required configuration before any test module imports
    // src/config/env.ts, which validates on import.
    setupFiles: ['src/test/setupEnv.ts'],

    // Applies migrations to the test database once per suite. A no-op until DATABASE_URL_TEST
    // is configured and E2 has created the schema.
    globalSetup: ['src/test/globalSetup.ts'],

    // Integration tests share a real Postgres database, so test files must not run in parallel
    // against each other. T1.2.2 relies on this.
    fileParallelism: false,
  },
});
