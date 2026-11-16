import assert from 'node:assert';
import pingHandler, {
  MAX_CONCURRENT_VIEWERS,
  STALE_VIEWER_WINDOW_MS,
  MAX_VIEWER_ID_LENGTH,
} from '../api/track/[sessionId]/ping';
import stopHandler from '../api/track/[sessionId]/stop';
import { getRedisClient } from '../lib/redis';
import { auth } from '../lib/firebase';

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

// Monkey-patch auth verification for stop tests
if (auth) {
  (auth as any).verifyIdToken = async (token: string) => {
    if (token === 'valid-owner-token') {
      return {
        uid: 'user-owner-123',
        email: 'rider@trackme.shvms.in',
        name: 'Authorized Rider',
      };
    }
    throw new Error('Invalid token');
  };
}

test('pingHandler rejects non-POST requests with 405 Method Not Allowed', async () => {
  const res = fakeResponse();
  await pingHandler({
    method: 'GET',
    query: { sessionId: 'any-session' },
  } as any, res as any);

  assert.strictEqual(res.captured.statusCode, 405);
  assert.deepStrictEqual(res.captured.body, { error: 'Method Not Allowed' });
});

test('pingHandler rejects missing or invalid sessionId with 400', async () => {
  const cases = [
    { sessionId: undefined, viewerId: 'v1' },
    { sessionId: '', viewerId: 'v1' },
    { sessionId: '   ', viewerId: 'v1' },
    { sessionId: ['s1', 's2'], viewerId: 'v1' },
  ];

  for (const c of cases) {
    const res = fakeResponse();
    await pingHandler({
      method: 'POST',
      query: { sessionId: c.sessionId },
      body: { viewerId: c.viewerId },
    } as any, res as any);

    assert.strictEqual(res.captured.statusCode, 400);
    assert.deepStrictEqual(res.captured.body, { error: 'Missing or invalid sessionId' });
  }
});

test('pingHandler rejects missing or empty viewerId with 400', async () => {
  const cases = [
    { viewerId: undefined },
    { viewerId: '' },
    { viewerId: '   ' },
    { viewerId: 123 },
  ];

  for (const c of cases) {
    const res = fakeResponse();
    await pingHandler({
      method: 'POST',
      query: { sessionId: 'valid-session' },
      body: { viewerId: c.viewerId },
    } as any, res as any);

    assert.strictEqual(res.captured.statusCode, 400);
    assert.deepStrictEqual(res.captured.body, { error: 'Missing viewerId in body' });
  }
});

test('pingHandler returns 404 when session does not exist or has expired', async () => {
  const res = fakeResponse();
  await pingHandler({
    method: 'POST',
    query: { sessionId: 'nonexistent-session-123' },
    body: { viewerId: 'viewer-alice' },
  } as any, res as any);

  assert.strictEqual(res.captured.statusCode, 404);
  assert.deepStrictEqual(res.captured.body, { error: 'Session not found or expired' });
});

test('pingHandler registers new viewer, establishes TTL, and increments count', async () => {
  const redis = await getRedisClient();
  const sessionId = 'session-ping-new-viewer';
  const viewersKey = `session:${sessionId}:viewers`;

  await redis.set(`session:${sessionId}`, JSON.stringify({
    sessionId,
    ownerUid: 'user-owner-123',
    status: 'active',
  }), { EX: 1800 });

  await redis.del(viewersKey);

  const res1 = fakeResponse();
  await pingHandler({
    method: 'POST',
    query: { sessionId },
    body: { viewerId: 'viewer-1' },
  } as any, res1 as any);

  assert.strictEqual(res1.captured.statusCode, 200);
  assert.strictEqual(res1.captured.body.success, true);
  assert.strictEqual(res1.captured.body.viewers, 1);

  // Verify TTL set on viewersKey
  const ttl = await redis.ttl(viewersKey);
  assert.ok(ttl > 0, 'viewersKey must have TTL set');

  // Add second viewer
  const res2 = fakeResponse();
  await pingHandler({
    method: 'POST',
    query: { sessionId },
    body: { viewerId: 'viewer-2' },
  } as any, res2 as any);

  assert.strictEqual(res2.captured.statusCode, 200);
  assert.strictEqual(res2.captured.body.viewers, 2);

  // Clean up
  await redis.del(`session:${sessionId}`);
  await redis.del(viewersKey);
});

test('pingHandler updates existing viewer score without inflating count', async () => {
  const redis = await getRedisClient();
  const sessionId = 'session-ping-existing';
  const viewersKey = `session:${sessionId}:viewers`;

  await redis.set(`session:${sessionId}`, JSON.stringify({
    sessionId,
    status: 'active',
  }), { EX: 1800 });

  await redis.del(viewersKey);

  // Initial ping
  const res1 = fakeResponse();
  await pingHandler({
    method: 'POST',
    query: { sessionId },
    body: { viewerId: 'viewer-steady' },
  } as any, res1 as any);

  assert.strictEqual(res1.captured.body.viewers, 1);

  // Subsequent ping by same viewer
  const res2 = fakeResponse();
  await pingHandler({
    method: 'POST',
    query: { sessionId },
    body: { viewerId: 'viewer-steady' },
  } as any, res2 as any);

  assert.strictEqual(res2.captured.statusCode, 200);
  assert.strictEqual(res2.captured.body.viewers, 1, 'Viewer count must remain 1 for repeated pings');

  await redis.del(`session:${sessionId}`);
  await redis.del(viewersKey);
});

test('pingHandler prunes viewers inactive for more than STALE_VIEWER_WINDOW_MS', async () => {
  const redis = await getRedisClient();
  const sessionId = 'session-ping-stale-prune';
  const viewersKey = `session:${sessionId}:viewers`;

  await redis.set(`session:${sessionId}`, JSON.stringify({
    sessionId,
    status: 'active',
  }), { EX: 1800 });

  await redis.del(viewersKey);

  // Insert an old viewer whose ping was 50 seconds ago (> STALE_VIEWER_WINDOW_MS = 40s)
  const staleTimestamp = Date.now() - 50_000;
  await redis.zAdd(viewersKey, { score: staleTimestamp, value: 'stale-viewer-old' });

  // A fresh viewer pings
  const res = fakeResponse();
  await pingHandler({
    method: 'POST',
    query: { sessionId },
    body: { viewerId: 'fresh-viewer' },
  } as any, res as any);

  assert.strictEqual(res.captured.statusCode, 200);
  assert.strictEqual(res.captured.body.viewers, 1, 'Stale viewer should be pruned, leaving 1 active viewer');

  // Verify old viewer is no longer in ZSET
  const oldScore = await redis.zScore(viewersKey, 'stale-viewer-old');
  assert.strictEqual(oldScore, null, 'stale-viewer-old must be removed');

  await redis.del(`session:${sessionId}`);
  await redis.del(viewersKey);
});

test('pingHandler enforces MAX_CONCURRENT_VIEWERS cap for new viewers but allows existing viewers', async () => {
  const redis = await getRedisClient();
  const sessionId = 'session-ping-capacity-cap';
  const viewersKey = `session:${sessionId}:viewers`;

  await redis.set(`session:${sessionId}`, JSON.stringify({
    sessionId,
    status: 'active',
  }), { EX: 1800 });

  await redis.del(viewersKey);

  // Pre-fill MAX_CONCURRENT_VIEWERS (10) active viewers
  const now = Date.now();
  for (let i = 1; i <= MAX_CONCURRENT_VIEWERS; i++) {
    await redis.zAdd(viewersKey, { score: now, value: `viewer-${i}` });
  }

  // 11th new viewer should receive 429
  const resNew = fakeResponse();
  await pingHandler({
    method: 'POST',
    query: { sessionId },
    body: { viewerId: 'viewer-11-new' },
  } as any, resNew as any);

  assert.strictEqual(resNew.captured.statusCode, 429);
  assert.ok(resNew.captured.body.error.includes('Maximum concurrent viewers'));

  // Existing viewer-1 should still succeed with 200
  const resExisting = fakeResponse();
  await pingHandler({
    method: 'POST',
    query: { sessionId },
    body: { viewerId: 'viewer-1' },
  } as any, resExisting as any);

  assert.strictEqual(resExisting.captured.statusCode, 200);
  assert.strictEqual(resExisting.captured.body.viewers, MAX_CONCURRENT_VIEWERS);

  await redis.del(`session:${sessionId}`);
  await redis.del(viewersKey);
});

test('stopHandler immediately removes viewersKey ZSET when session concludes', async () => {
  const redis = await getRedisClient();
  const sessionId = 'session-stop-deletes-viewers';
  const viewersKey = `session:${sessionId}:viewers`;

  await redis.set(`session:${sessionId}`, JSON.stringify({
    sessionId,
    ownerUid: 'user-owner-123',
    username: 'Test Rider',
    status: 'active',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  }), { EX: 3600 });

  // Add active viewers
  await redis.zAdd(viewersKey, { score: Date.now(), value: 'viewer-a' });
  await redis.zAdd(viewersKey, { score: Date.now(), value: 'viewer-b' });

  const initialCount = await redis.zCard(viewersKey);
  assert.strictEqual(initialCount, 2);

  // Stop session
  const res = fakeResponse();
  await stopHandler({
    method: 'POST',
    query: { sessionId },
    headers: { authorization: 'Bearer valid-owner-token' },
    body: {},
  } as any, res as any);

  assert.strictEqual(res.captured.statusCode, 200);

  // Verify viewersKey is completely deleted from Redis
  const remainingCount = await redis.zCard(viewersKey);
  assert.strictEqual(remainingCount, 0, 'viewersKey must be pruned on session stop');

  await redis.del(`session:${sessionId}`);
  await redis.del(viewersKey);
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

  process.stdout.write(`\nping: ${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) {
    for (const f of failures) process.stderr.write(`  - ${f}\n`);
    process.exit(1);
  }
}

main();
