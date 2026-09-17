import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { env } from '../config/env.ts';
import { disconnectPrismaClient, getPrismaClient } from '../data/prismaClient.ts';
import { useCleanTestDatabase } from '../test/fixtures.ts';

/**
 * `GET /health` (T9.2.2) — ARCHITECTURE Section 16's keep-warm ping target.
 *
 * ## What is being tested
 *
 * That the endpoint answers 200 only when the database actually answered, and 5xx when it did not —
 * which is the whole value of the endpoint. A ping that reported healthy while the database was cold
 * would be worse than no ping at all: Render would stay awake and Supabase would still pause, and the
 * monitor would be the last thing to notice (Section 16).
 *
 * ## Why the failure case is a real unreachable database and not a mock
 *
 * A rejected `pingDatabase` stub would prove the catch block is spelled correctly and nothing about
 * whether a database that is down actually produces that rejection. So the failure is produced for
 * real: the shared client is dropped, the connection string is pointed at a closed port, and the next
 * ping genuinely cannot connect. The route, the client, the driver, and the error path are all the
 * real ones; only the address is wrong. Section 15 asks for integration tests against the real
 * database, and "the database is unreachable" is a case that has to be *made* rather than observed.
 */

useCleanTestDatabase();

// `disconnectPrismaClient` is imported for the failure case, which must drop the client holding the
// good URL; `useCleanTestDatabase` closes the pool at the end of the file for the same reason it does
// everywhere else. The suite is a single process, so a client left pointing at the dead address would
// break every later file.
afterAll(async () => {
  await disconnectPrismaClient();
});

describe('GET /health', () => {
  it('answers 200 when the database is reachable', async () => {
    // No mocking: this is the real client, the real pool, and a real query against the test database.
    const response = await request(createApp()).get('/health').expect(200);

    expect(response.body).toEqual({ status: 'ok' });
    expect(response.headers['content-type']).toMatch(/application\/json/);
  });

  it('answers 503, generically, when the database cannot be reached', async () => {
    const reachableUrl = env.DATABASE_URL_TEST;

    // Dropped first, because `getPrismaClient` is memoized: without this the next call returns the
    // client still holding the reachable URL and the ping would succeed.
    await disconnectPrismaClient();
    // Port 1 is reserved and nothing listens on it, so this fails at connect rather than at auth.
    env.DATABASE_URL_TEST = 'postgresql://lexora:lexora@127.0.0.1:1/lexora_unreachable';

    try {
      const response = await request(createApp()).get('/health').expect(503);

      // Section 11: the caller learns that the service is unavailable and nothing about why — no
      // connection string, no driver, no host, no stack.
      expect(response.body).toEqual({ error: 'Service unavailable' });

      const body = JSON.stringify(response.body);
      for (const leak of ['127.0.0.1', 'lexora_unreachable', 'Prisma', 'ECONNREFUSED']) {
        expect(body).not.toContain(leak);
      }
    } finally {
      // Both halves, in this order: dropping the client while the bad URL is still in place is what
      // stops it being handed to the next test, and restoring the URL is what makes the *next* client
      // a good one.
      await disconnectPrismaClient();
      env.DATABASE_URL_TEST = reachableUrl;
    }
  });

  it('recovers once the database is reachable again', async () => {
    // The client is memoized and the URL is process-wide, so the test above leaves both in a state a
    // later test depends on. This asserts the restore actually worked rather than assuming it: a
    // `finally` that ran but restored the wrong value would otherwise show up as an unrelated failure
    // in whatever file ran next.
    const response = await request(createApp()).get('/health').expect(200);

    expect(response.body).toEqual({ status: 'ok' });
    expect((await getPrismaClient().cohort.count()) >= 0).toBe(true);
  });
});
