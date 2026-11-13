import assert from 'node:assert';
import startHandler from '../api/track/start';
import { getRedisClient } from '../lib/redis';
import { auth } from '../lib/firebase';
import {
  MAX_AUTO_WATCHERS,
  normalizeWatcherUids,
} from '../lib/track/watchers';

type TestCase = { name: string; fn: () => void | Promise<void> };
const tests: TestCase[] = [];

function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

function fakeResponse() {
  const captured: any = { statusCode: null, body: null, headers: {} as Record<string, string> };
  return {
    captured,
    setHeader(name: string, value: string) {
      captured.headers[name] = value;
      return this;
    },
    status(code: number) {
      captured.statusCode = code;
      return {
        json(body: any) {
          captured.body = body;
          return body;
        },
      };
    },
  };
}

// Monkey-patch auth verification for tests
if (auth) {
  (auth as any).verifyIdToken = async (token: string) => {
    if (token === 'valid-test-token') {
      return {
        uid: 'test-user-owner-123',
        email: 'tester@trackme.shvms.in',
        name: 'Test Rider',
      };
    }
    throw new Error('Invalid token');
  };
}

test('normalizeWatcherUids filters invalid, dedupes, removes owner, and caps at MAX_AUTO_WATCHERS', () => {
  const ownerUid = 'user-owner-1';
  const rawList = [
    'user-w1',
    '  user-w2  ',
    'user-w1', // duplicate
    ownerUid, // owner self-notification blocked
    '', // empty
    null,
    123,
    'user-w3',
    'user-w4',
    'user-w5',
    'user-w6', // exceeds max 5
  ];

  const result = normalizeWatcherUids(rawList, ownerUid);
  assert.strictEqual(result.length, MAX_AUTO_WATCHERS);
  assert.deepStrictEqual(result, ['user-w1', 'user-w2', 'user-w3', 'user-w4', 'user-w5']);
});

test('_mockRedis.multi() pipelines arbitrary commands and executes them atomically in mock mode', async () => {
  const redis = await getRedisClient();
  const testKey = 'test:pipe:counter';
  const zsetKey = 'test:pipe:zset';

  await redis.del(testKey);
  await redis.del(zsetKey);

  const multi = redis.multi();
  multi.incr(testKey);
  multi.incr(testKey);
  multi.zAdd(zsetKey, { score: 10, value: 'v1' });
  multi.zAdd(zsetKey, { score: 20, value: 'v2' });
  multi.zRemRangeByScore(zsetKey, 0, 15);
  multi.zCard(zsetKey);
  const results = await multi.exec();

  assert.strictEqual(results.length, 6);
  assert.strictEqual(results[0], 1, 'First incr should return 1');
  assert.strictEqual(results[1], 2, 'Second incr should return 2');
  assert.strictEqual(results[4], 1, 'zRemRangeByScore should remove 1 item');
  assert.strictEqual(results[5], 1, 'zCard should report 1 remaining item');

  // Clean up
  await redis.del(testKey);
  await redis.del(zsetKey);
});

test('startHandler rejects non-GET/POST methods with 405 Method Not Allowed', async () => {
  const res = fakeResponse();
  await startHandler({ method: 'PUT' } as any, res as any);
  assert.strictEqual(res.captured.statusCode, 405);
  assert.strictEqual(res.captured.body.error, 'Method Not Allowed');
});

test('startHandler GET ?inbox=1 returns activeInvite null and no-store headers on empty inbox', async () => {
  const res = fakeResponse();
  await startHandler({
    method: 'GET',
    query: { inbox: '1' },
    headers: { authorization: 'Bearer valid-test-token' },
  } as any, res as any);

  assert.strictEqual(res.captured.statusCode, 200);
  assert.strictEqual(res.captured.body.activeInvite, null);
  assert.strictEqual(res.captured.headers['Cache-Control'], 'no-store, no-cache, must-revalidate');
});

test('startHandler GET ?inbox=1 gracefully purges malformed JSON in Redis without 500 error', async () => {
  const redis = await getRedisClient();
  const uid = 'test-user-owner-123';
  await redis.set(`watcher_inbox:${uid}`, '{invalid-json-string');

  const origError = console.error;
  console.error = () => {};
  try {
    const res = fakeResponse();
    await startHandler({
      method: 'GET',
      query: { inbox: '1' },
      headers: { authorization: 'Bearer valid-test-token' },
    } as any, res as any);

    assert.strictEqual(res.captured.statusCode, 200);
    assert.strictEqual(res.captured.body.activeInvite, null);

    // Verify corrupted key was purged
    assert.strictEqual(await redis.get(`watcher_inbox:${uid}`), null);
  } finally {
    console.error = origError;
  }
});

test('startHandler GET ?inbox=1 returns active invite when session is active and purges when session ended', async () => {
  const redis = await getRedisClient();
  const uid = 'test-user-owner-123';
  const sessionId = 'active-live-session-cie010';

  // Seed active session and invite
  await redis.set(`session:${sessionId}`, JSON.stringify({
    status: 'active',
    username: 'Alice',
    startedAt: Date.now(),
  }));
  const invitePayload = {
    sessionId,
    riderName: 'Alice',
    shareUrl: `https://trackme.shvms.in/live/${sessionId}`,
  };
  await redis.set(`watcher_inbox:${uid}`, JSON.stringify(invitePayload));

  const res = fakeResponse();
  await startHandler({
    method: 'GET',
    query: { inbox: '1' },
    headers: { authorization: 'Bearer valid-test-token' },
  } as any, res as any);

  assert.strictEqual(res.captured.statusCode, 200);
  assert.strictEqual(res.captured.body.activeInvite.sessionId, sessionId);

  // Now set session to stopped -> inbox query should auto-purge and return null
  await redis.set(`session:${sessionId}`, JSON.stringify({
    status: 'stopped',
    stopReason: 'The rider has ended this live trip.',
  }));

  const res2 = fakeResponse();
  await startHandler({
    method: 'GET',
    query: { inbox: '1' },
    headers: { authorization: 'Bearer valid-test-token' },
  } as any, res2 as any);

  assert.strictEqual(res2.captured.statusCode, 200);
  assert.strictEqual(res2.captured.body.activeInvite, null);
  assert.strictEqual(await redis.get(`watcher_inbox:${uid}`), null);

  // Clean up
  await redis.del(`session:${sessionId}`);
});

test('startHandler POST validates duration limits and rejects > 1440 min with 400', async () => {
  const res = fakeResponse();
  await startHandler({
    method: 'POST',
    headers: { authorization: 'Bearer valid-test-token' },
    body: { durationMinutes: 1500 },
  } as any, res as any);

  assert.strictEqual(res.captured.statusCode, 400);
  assert.ok(res.captured.body.error.includes('Duration cannot exceed 24 hours'));
});

test('startHandler POST initializes session with pipelined stats and trimmed bounds', async () => {
  const redis = await getRedisClient();
  const res = fakeResponse();

  await startHandler({
    method: 'POST',
    headers: {
      authorization: 'Bearer valid-test-token',
      'x-forwarded-proto': 'https',
      host: 'trackme.shvms.in',
    },
    body: {
      durationMinutes: 45,
      username: '   Rider Bob Longname '.padEnd(80, 'x'), // exceeds 64 chars
      watcherUids: [],
    },
  } as any, res as any);

  assert.strictEqual(res.captured.statusCode, 200);
  const { sessionId, shareLink, expiresAt } = res.captured.body;
  assert.ok(sessionId, 'sessionId must be generated');
  assert.strictEqual(shareLink, `https://trackme.shvms.in/live/${sessionId}`);
  assert.ok(new Date(expiresAt).getTime() > Date.now());

  // Verify session in Redis
  const rawSession = await redis.get(`session:${sessionId}`);
  assert.ok(rawSession, 'Session record must exist in Redis');
  const session = JSON.parse(rawSession!);
  assert.strictEqual(session.status, 'active');
  assert.strictEqual(session.initialDuration, 45);
  assert.strictEqual(session.username.length, 64, 'Username must be capped at 64 chars');
  assert.strictEqual(session.username.startsWith('Rider Bob Longname'), true);
  assert.deepStrictEqual(session.path, []);

  // Clean up
  await redis.del(`session:${sessionId}`);
});

async function main() {
  let passed = 0;
  const failures: string[] = [];

  for (const t of tests) {
    try {
      await t.fn();
      passed += 1;
      process.stdout.write(`  ✓ ${t.name}\n`);
    } catch (err) {
      failures.push(`${t.name}: ${(err as Error).message}`);
      process.stdout.write(`  ✗ ${t.name}\n`);
    }
  }

  process.stdout.write(`\nstart: ${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) {
    for (const f of failures) process.stderr.write(`  - ${f}\n`);
    process.exit(1);
  }
}

main();
