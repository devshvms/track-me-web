import assert from 'node:assert';
import stopHandler, {
  MAX_STOP_REASON_LENGTH,
  DEFAULT_STOP_REASON,
  MIN_POST_RIDE_BUFFER_SECONDS,
  MAX_SESSION_TTL_SECONDS,
} from '../api/track/[sessionId]/stop';
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

// Monkey-patch auth verification for tests
if (auth) {
  (auth as any).verifyIdToken = async (token: string) => {
    if (token === 'valid-owner-token') {
      return {
        uid: 'user-owner-123',
        email: 'rider@trackme.shvms.in',
        name: 'Authorized Rider',
      };
    }
    if (token === 'valid-other-token') {
      return {
        uid: 'user-intruder-456',
        email: 'intruder@other.com',
        name: 'Other Rider',
      };
    }
    throw new Error('Invalid or expired token');
  };
}

test('stopHandler rejects non-POST requests with 405 Method Not Allowed', async () => {
  const res = fakeResponse();
  await stopHandler({
    method: 'GET',
    query: { sessionId: 'any-session' },
  } as any, res as any);

  assert.strictEqual(res.captured.statusCode, 405);
  assert.deepStrictEqual(res.captured.body, { error: 'Method Not Allowed' });
});

test('stopHandler rejects missing, empty, or non-string sessionId with 400', async () => {
  const cases = [
    { sessionId: undefined },
    { sessionId: '' },
    { sessionId: '   ' },
    { sessionId: ['s1', 's2'] },
  ];

  for (const c of cases) {
    const res = fakeResponse();
    await stopHandler({
      method: 'POST',
      query: c,
    } as any, res as any);

    assert.strictEqual(res.captured.statusCode, 400);
    assert.deepStrictEqual(res.captured.body, { error: 'Missing or invalid sessionId' });
  }
});

test('stopHandler requires authentication and rejects unauthenticated requests with 401', async () => {
  const res = fakeResponse();
  await stopHandler({
    method: 'POST',
    query: { sessionId: 'test-session-id' },
    headers: {},
  } as any, res as any);

  assert.strictEqual(res.captured.statusCode, 401);
  assert.ok(res.captured.body.error);
});

test('stopHandler returns 404 for non-existent or expired session', async () => {
  const res = fakeResponse();
  await stopHandler({
    method: 'POST',
    query: { sessionId: 'nonexistent-session-id-999' },
    headers: {
      authorization: 'Bearer valid-owner-token',
    },
  } as any, res as any);

  assert.strictEqual(res.captured.statusCode, 404);
  assert.deepStrictEqual(res.captured.body, { error: 'Session not found or already expired' });
});

test('stopHandler returns 403 when caller is not the session owner', async () => {
  const redis = await getRedisClient();
  const sessionId = 'session-unauthorized-check';
  const expiresAt = new Date(Date.now() + 3600_000).toISOString();

  await redis.set(`session:${sessionId}`, JSON.stringify({
    sessionId,
    ownerUid: 'user-owner-123',
    username: 'Legitimate Owner',
    status: 'active',
    expiresAt,
  }), { EX: 3600 });

  const res = fakeResponse();
  await stopHandler({
    method: 'POST',
    query: { sessionId },
    headers: {
      authorization: 'Bearer valid-other-token', // Belongs to user-intruder-456
    },
  } as any, res as any);

  assert.strictEqual(res.captured.statusCode, 403);
  assert.ok(res.captured.body.error.includes('do not own'));

  await redis.del(`session:${sessionId}`);
});

test('stopHandler successfully stops session with default stopReason and pipelined stats', async () => {
  const redis = await getRedisClient();
  const sessionId = 'session-stop-default-reason';
  const twoHoursAgo = Date.now() - 2 * 3600_000;
  const expiresAt = new Date(Date.now() + 3600_000).toISOString();

  await redis.set(`session:${sessionId}`, JSON.stringify({
    sessionId,
    ownerUid: 'user-owner-123',
    username: 'Test Rider',
    status: 'active',
    startedAt: twoHoursAgo,
    initialDuration: 180,
    expiresAt,
    path: [[12.97, 77.59]],
  }), { EX: 3600 });

  await redis.del('stats:total_hours');

  const res = fakeResponse();
  await stopHandler({
    method: 'POST',
    query: { sessionId },
    headers: {
      authorization: 'Bearer valid-owner-token',
    },
    body: {},
  } as any, res as any);

  assert.strictEqual(res.captured.statusCode, 200);
  assert.deepStrictEqual(res.captured.body, { success: true, message: 'Sharing stopped' });

  // Inspect saved state in Redis
  const rawUpdated = await redis.get(`session:${sessionId}`);
  assert.ok(rawUpdated);
  const updated = JSON.parse(rawUpdated!);
  assert.strictEqual(updated.status, 'stopped');
  assert.strictEqual(updated.stopReason, DEFAULT_STOP_REASON);
  assert.ok(updated.endedAt, 'endedAt timestamp must be set');

  // Verify total_hours incremented ~2.0 hours
  const totalHoursStr = await redis.get('stats:total_hours');
  assert.ok(totalHoursStr);
  const totalHours = parseFloat(totalHoursStr!);
  assert.ok(totalHours >= 1.95 && totalHours <= 2.05, `Expected ~2.0 total hours, got ${totalHours}`);

  await redis.del(`session:${sessionId}`);
  await redis.del('stats:total_hours');
});

test('stopHandler parses ISO string startedAt safely without NaN', async () => {
  const redis = await getRedisClient();
  const sessionId = 'session-stop-iso-timestamp';
  const oneHourAgoIso = new Date(Date.now() - 3600_000).toISOString();
  const expiresAt = new Date(Date.now() + 1800_000).toISOString();

  await redis.set(`session:${sessionId}`, JSON.stringify({
    sessionId,
    ownerUid: 'user-owner-123',
    username: 'Test Rider',
    status: 'active',
    startedAt: oneHourAgoIso, // ISO string instead of epoch ms
    initialDuration: 90,
    expiresAt,
  }), { EX: 1800 });

  await redis.del('stats:total_hours');

  const res = fakeResponse();
  await stopHandler({
    method: 'POST',
    query: { sessionId },
    headers: {
      authorization: 'Bearer valid-owner-token',
    },
    body: {
      stopReason: 'Arrived at destination safely.',
    },
  } as any, res as any);

  assert.strictEqual(res.captured.statusCode, 200);

  const rawUpdated = await redis.get(`session:${sessionId}`);
  const updated = JSON.parse(rawUpdated!);
  assert.strictEqual(updated.status, 'stopped');
  assert.strictEqual(updated.stopReason, 'Arrived at destination safely.');

  // Verify total_hours is ~1.0, not NaN or 0
  const totalHoursStr = await redis.get('stats:total_hours');
  assert.ok(totalHoursStr);
  const totalHours = parseFloat(totalHoursStr!);
  assert.ok(totalHours >= 0.95 && totalHours <= 1.05, `Expected ~1.0 hour, got ${totalHours}`);

  await redis.del(`session:${sessionId}`);
  await redis.del('stats:total_hours');
});

test('stopHandler clamps stopReason exceeding MAX_STOP_REASON_LENGTH to 256 chars', async () => {
  const redis = await getRedisClient();
  const sessionId = 'session-stop-long-reason';
  const expiresAt = new Date(Date.now() + 3600_000).toISOString();

  await redis.set(`session:${sessionId}`, JSON.stringify({
    sessionId,
    ownerUid: 'user-owner-123',
    username: 'Test Rider',
    status: 'active',
    expiresAt,
  }), { EX: 3600 });

  const excessivelyLongReason = 'Trip stopped '.repeat(30); // 390 chars
  assert.ok(excessivelyLongReason.length > MAX_STOP_REASON_LENGTH);

  const res = fakeResponse();
  await stopHandler({
    method: 'POST',
    query: { sessionId },
    headers: {
      authorization: 'Bearer valid-owner-token',
    },
    body: {
      stopReason: excessivelyLongReason,
    },
  } as any, res as any);

  assert.strictEqual(res.captured.statusCode, 200);

  const rawUpdated = await redis.get(`session:${sessionId}`);
  const updated = JSON.parse(rawUpdated!);
  assert.strictEqual(updated.stopReason.length, MAX_STOP_REASON_LENGTH);
  assert.strictEqual(updated.stopReason, excessivelyLongReason.trim().slice(0, MAX_STOP_REASON_LENGTH));

  await redis.del(`session:${sessionId}`);
});

test('stopHandler enforces post-ride viewing buffer of at least 3600s', async () => {
  const redis = await getRedisClient();
  const sessionId = 'session-stop-grace-period';
  // Session expiring in only 30 seconds
  const nearExpiryDate = new Date(Date.now() + 30_000).toISOString();

  await redis.set(`session:${sessionId}`, JSON.stringify({
    sessionId,
    ownerUid: 'user-owner-123',
    username: 'Test Rider',
    status: 'active',
    expiresAt: nearExpiryDate,
  }), { EX: 30 });

  const initialTtl = await redis.ttl(`session:${sessionId}`);
  assert.ok(initialTtl <= 30 && initialTtl > 0);

  const res = fakeResponse();
  await stopHandler({
    method: 'POST',
    query: { sessionId },
    headers: {
      authorization: 'Bearer valid-owner-token',
    },
  } as any, res as any);

  assert.strictEqual(res.captured.statusCode, 200);

  // After stopping, remaining TTL must be bumped to at least MIN_POST_RIDE_BUFFER_SECONDS (3600s)
  const stoppedTtl = await redis.ttl(`session:${sessionId}`);
  assert.ok(
    stoppedTtl >= MIN_POST_RIDE_BUFFER_SECONDS - 5 && stoppedTtl <= MIN_POST_RIDE_BUFFER_SECONDS + 5,
    `Expected stopped TTL ~3600s, got ${stoppedTtl}`
  );

  await redis.del(`session:${sessionId}`);
});

test('stopHandler caps post-ride TTL at MAX_SESSION_TTL_SECONDS (86400s)', async () => {
  const redis = await getRedisClient();
  const sessionId = 'session-stop-max-cap';
  // Session with far future expiresAt (e.g. 48 hours)
  const farFutureExpiry = new Date(Date.now() + 48 * 3600_000).toISOString();

  await redis.set(`session:${sessionId}`, JSON.stringify({
    sessionId,
    ownerUid: 'user-owner-123',
    username: 'Test Rider',
    status: 'active',
    expiresAt: farFutureExpiry,
  }), { EX: 172800 });

  const res = fakeResponse();
  await stopHandler({
    method: 'POST',
    query: { sessionId },
    headers: {
      authorization: 'Bearer valid-owner-token',
    },
  } as any, res as any);

  assert.strictEqual(res.captured.statusCode, 200);

  const finalTtl = await redis.ttl(`session:${sessionId}`);
  assert.ok(
    finalTtl <= MAX_SESSION_TTL_SECONDS && finalTtl >= MAX_SESSION_TTL_SECONDS - 5,
    `Expected stopped TTL capped at 86400s, got ${finalTtl}`
  );

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

  process.stdout.write(`\nstop: ${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) {
    for (const f of failures) process.stderr.write(`  - ${f}\n`);
    process.exit(1);
  }
}

main();
