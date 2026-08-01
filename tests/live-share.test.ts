// TASK-170 / TASK-172 regression tests for the live-share safety surface.
//
// The defect these exist to prevent: POST /api/track/:id/location answered
// 200 {success:true} for an update it had thrown away, because it guarded the
// write with `if (ttl > 0)` and Redis returns -1 for a key with no expiry --
// which is also what the in-memory fallback store returns unconditionally. The
// rider's phone believed it was uploading; the viewer watched a pin that never
// moved and read it as a stationary rider.

// Force the in-memory fallback store: this is the exact condition (ttl === -1
// on every key) under which the old guard discarded writes. Must be set before
// the first getRedisClient() call caches a client.
process.env.REDIS_URL = '';
delete process.env.VERCEL_ENV;

import assert from 'node:assert';
import { getRedisClient, setPreservingExpiry, setWithScopedExpiry } from '../lib/redis';
import { SESSION_END_REASONS, resolveEndReason } from '../api/track/[sessionId]/stop';
import {
  DEFAULT_DEADLINE_GRACE_SECONDS,
  DEFAULT_DURATION_MINUTES,
  MAX_SESSION_MINUTES,
  POST_END_VISIBILITY_SECONDS,
  computeClosureTtlSeconds,
  computeStartTtlSeconds,
  parseTripPlan,
} from '../lib/tripExpiry';

// The handler authenticates via lib/auth. Replace the verification with a stub
// owner so these tests exercise the storage path rather than Firebase. The
// handler resolves `requireUser` off the module object at call time, so
// patching the export here is sufficient.
const authModule: any = require('../lib/auth');
authModule.requireUser = async () => ({ uid: 'test-owner-uid', email: 'owner@example.com' });

import locationHandler from '../api/track/[sessionId]/location';
import startHandler from '../api/track/start';
import stopHandler from '../api/track/[sessionId]/stop';

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (err) {
    failures.push(`${name}: ${(err as Error).message}`);
    process.stdout.write(`  ✗ ${name}\n`);
  }
}

// Minimal Vercel req/res mocks.
function mockReq(overrides: any = {}): any {
  return { method: 'POST', headers: {}, body: {}, socket: {}, query: {}, ...overrides };
}
function mockRes(): any {
  const res: any = { statusCode: 0, body: undefined };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload: any) => {
    res.body = payload;
    return res;
  };
  res.setHeader = () => res;
  return res;
}

async function seedSession(overrides: any = {}) {
  const redis = await getRedisClient();
  const sessionId = `test-session-${Math.random().toString(36).slice(2)}`;
  const sessionData = {
    sessionId,
    ownerUid: 'test-owner-uid',
    username: 'Alex',
    initialDuration: 60,
    startedAt: Date.now(),
    status: 'active',
    lastLocation: null,
    ...overrides,
  };
  await redis.set(`session:${sessionId}`, JSON.stringify(sessionData));
  return { redis, sessionId };
}

async function run() {
  // --- the mock is the -1 condition ----------------------------------------
  await test('the fallback store reports ttl === -1 for a key that exists', async () => {
    const { redis, sessionId } = await seedSession();
    assert.equal(await redis.ttl(`session:${sessionId}`), -1, 'this is the condition the old guard dropped');
    assert.equal(await redis.ttl('session:definitely-not-here'), -2);
  });

  // --- setPreservingExpiry --------------------------------------------------
  await test('ttl === -1 writes without expiry instead of discarding the write', async () => {
    const { redis, sessionId } = await seedSession();
    const result = await setPreservingExpiry(redis, `session:${sessionId}`, JSON.stringify({ marker: 'written' }));
    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(await redis.get(`session:${sessionId}`)), { marker: 'written' });
  });

  await test('a positive ttl is preserved, never extended or dropped', async () => {
    const calls: any[] = [];
    const fakeRedis = {
      ttl: async () => 900,
      set: async (key: string, value: string, options?: any) => {
        calls.push({ key, value, options });
        return 'OK';
      },
    };
    const result = await setPreservingExpiry(fakeRedis, 'session:x', 'payload');
    assert.equal(result.ok, true);
    assert.deepEqual(calls[0].options, { EX: 900 });
  });

  await test('ttl === -2 (key gone) reports key_missing rather than resurrecting it', async () => {
    const redis = await getRedisClient();
    const result = await setPreservingExpiry(redis, 'session:definitely-not-here', 'payload');
    assert.equal(result.ok, false);
    assert.equal((result as any).reason, 'key_missing');
    assert.equal(await redis.get('session:definitely-not-here'), null, 'must not create the key');
  });

  await test('a throwing store reports failure instead of pretending', async () => {
    const throwsOnTtl = { ttl: async () => { throw new Error('boom'); }, set: async () => 'OK' };
    const throwsOnSet = { ttl: async () => -1, set: async () => { throw new Error('boom'); } };
    assert.equal((await setPreservingExpiry(throwsOnTtl, 'k', 'v')).ok, false);
    assert.equal((await setPreservingExpiry(throwsOnSet, 'k', 'v')).ok, false);
  });

  await test('a null SET result is a failure, not a success', async () => {
    const declines = { ttl: async () => -1, set: async () => null };
    assert.equal((await setPreservingExpiry(declines, 'k', 'v')).ok, false);
  });

  await test('a non-numeric ttl fails closed rather than stripping the expiry', async () => {
    let wrote = false;
    const weird = { ttl: async () => undefined, set: async () => { wrote = true; return 'OK'; } };
    assert.equal((await setPreservingExpiry(weird, 'k', 'v')).ok, false);
    assert.equal(wrote, false, 'writing without EX here would mint an immortal tracking link');
  });

  // --- the handler contract -------------------------------------------------
  await test('POST location under the ttl === -1 store persists the write and only then returns success', async () => {
    const { redis, sessionId } = await seedSession();
    const res = mockRes();
    await locationHandler(
      mockReq({
        query: { sessionId },
        body: { lat: 12.9, lng: 77.6, batteryLevel: 42, timestamp: '2026-08-01T10:00:00.000Z' },
      }),
      res,
    );

    const stored = JSON.parse(await redis.get(`session:${sessionId}`));
    if (res.body && res.body.success === true) {
      // Success is only permitted if the update is actually in the store.
      assert.ok(stored.lastLocation, 'reported success while discarding the write');
      assert.equal(stored.lastLocation.lat, 12.9);
      assert.equal(stored.lastLocation.lng, 77.6);
      assert.equal(res.statusCode, 200);
    } else {
      assert.notEqual(res.statusCode, 200, 'a non-success body must not carry a 200');
    }
  });

  await test('a discarded write can never be reported as success', async () => {
    // Simulate the pre-fix behaviour end to end: if the store keeps the old
    // blob, the response must not be 200 {success:true}.
    const { redis, sessionId } = await seedSession();
    const before = await redis.get(`session:${sessionId}`);
    const res = mockRes();
    await locationHandler(
      mockReq({ query: { sessionId }, body: { lat: 1, lng: 2 } }),
      res,
    );
    const after = await redis.get(`session:${sessionId}`);
    const discarded = before === after;
    assert.ok(
      !(discarded && res.statusCode === 200 && res.body?.success === true),
      'handler returned success for a write the store did not take',
    );
  });

  await test('POST location refuses to claim success when a production deploy has no durable store', async () => {
    const { sessionId } = await seedSession();
    process.env.VERCEL_ENV = 'production';
    try {
      const res = mockRes();
      await locationHandler(mockReq({ query: { sessionId }, body: { lat: 1, lng: 2 } }), res);
      assert.equal(res.statusCode, 503);
      assert.notEqual(res.body?.success, true);
    } finally {
      delete process.env.VERCEL_ENV;
    }
  });

  await test('GET location is unaffected and still serves the session', async () => {
    const { sessionId } = await seedSession({ username: 'Alex' });
    const res = mockRes();
    await locationHandler(mockReq({ method: 'GET', query: { sessionId } }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.username, 'Alex');
  });

  await test('POST location for an unknown session is a 404, not a success', async () => {
    const res = mockRes();
    await locationHandler(mockReq({ query: { sessionId: 'nope' }, body: { lat: 1, lng: 2 } }), res);
    assert.equal(res.statusCode, 404);
    assert.notEqual(res.body?.success, true);
  });

  // --- TASK-172 closure reasons --------------------------------------------
  await test('end reasons are a closed enum', () => {
    assert.deepEqual([...SESSION_END_REASONS], ['marked_safe', 'ride_ended', 'expired']);
  });

  await test('nothing unrecognised is ever inferred as marked_safe', () => {
    assert.equal(resolveEndReason(undefined), 'ride_ended');
    assert.equal(resolveEndReason({}), 'ride_ended');
    assert.equal(resolveEndReason({ stopReason: 'manual_stop' }), 'ride_ended');
    assert.equal(resolveEndReason({ stopReason: 'safe' }), 'ride_ended');
    assert.equal(resolveEndReason({ endReason: 'arrived' }), 'ride_ended');
    assert.equal(resolveEndReason({ endReason: 42 }), 'ride_ended');
  });

  await test('marked_safe is honoured only when the client states it explicitly', () => {
    assert.equal(resolveEndReason({ endReason: 'marked_safe' }), 'marked_safe');
    assert.equal(resolveEndReason({ endReason: 'expired' }), 'expired');
  });

  // --- TASK-171 trip plan validation ---------------------------------------
  await test('parseTripPlan rejects malformed or dangerous payloads', () => {
    const now = Date.now();
    const inAnHour = new Date(now + 3600_000).toISOString();
    assert.equal(parseTripPlan({ destination: { lat: 91, lng: 0 } }, now).ok, false);
    assert.equal(parseTripPlan({ destination: { lat: 0, lng: -181 } }, now).ok, false);
    assert.equal(parseTripPlan({ destination: { lat: '12', lng: 77 } }, now).ok, false);
    assert.equal(parseTripPlan({ destination: { lat: 12, lng: 77, label: 42 } }, now).ok, false);
    assert.equal(parseTripPlan({ etaAt: 'not-a-date' }, now).ok, false);
    assert.equal(parseTripPlan({ deadlineAt: 'not-a-date' }, now).ok, false);
    assert.equal(parseTripPlan({ deadlineAt: new Date(now - 1000).toISOString() }, now).ok, false, 'a past deadline is a typo, not a trip');
    assert.equal(
      parseTripPlan({ deadlineAt: new Date(now + (MAX_SESSION_MINUTES + 60) * 60_000).toISOString() }, now).ok,
      false,
      'a deadline beyond the ceiling would mint a near-immortal link',
    );
    assert.equal(parseTripPlan({ etaAt: new Date(now + 7200_000).toISOString(), deadlineAt: inAnHour }, now).ok, false, 'eta after deadline is incoherent');
  });

  await test('parseTripPlan defaults the deadline to ETA plus the grace period', () => {
    const now = Date.now();
    const eta = new Date(now + 3600_000).toISOString();
    const result = parseTripPlan({ etaAt: eta }, now);
    assert.equal(result.ok, true);
    const plan = (result as any).plan;
    assert.equal(plan.deadlineAt, new Date(now + 3600_000 + DEFAULT_DEADLINE_GRACE_SECONDS * 1000).toISOString());
  });

  await test('parseTripPlan trims and caps the destination label', () => {
    const now = Date.now();
    const result = parseTripPlan({ destination: { lat: 12.9, lng: 77.6, label: `  ${'x'.repeat(200)}  ` } }, now);
    assert.equal(result.ok, true);
    assert.equal((result as any).plan.destination.label.length, 80);
  });

  // --- TASK-171 expiry policy ----------------------------------------------
  await test('start TTL is scoped to the deadline plus the visibility window', () => {
    const now = Date.now();
    const deadline = now + 3 * 3600_000;
    assert.equal(
      computeStartTtlSeconds({ durationMinutes: null, deadlineAtMs: deadline }, now),
      3 * 3600 + POST_END_VISIBILITY_SECONDS,
    );
    // A trip deadline beyond 24 h is exactly what the old cap forbade.
    const longDeadline = now + 30 * 3600_000;
    assert.equal(
      computeStartTtlSeconds({ durationMinutes: null, deadlineAtMs: longDeadline }, now),
      30 * 3600 + POST_END_VISIBILITY_SECONDS,
    );
    // An explicit longer duration is a floor, never silently shortened.
    assert.equal(
      computeStartTtlSeconds({ durationMinutes: 10 * 60, deadlineAtMs: now + 3600_000 }, now),
      10 * 3600,
    );
    // No trip fields: legacy behaviour byte-for-byte.
    assert.equal(
      computeStartTtlSeconds({ durationMinutes: null, deadlineAtMs: null }, now),
      DEFAULT_DURATION_MINUTES * 60,
    );
    assert.equal(computeStartTtlSeconds({ durationMinutes: 90, deadlineAtMs: null }, now), 90 * 60);
  });

  await test('closure TTL is the window after ride end, or through the deadline, whichever is later', () => {
    const now = Date.now();
    assert.equal(computeClosureTtlSeconds(null, now), POST_END_VISIBILITY_SECONDS);
    assert.equal(
      computeClosureTtlSeconds(now + 3600_000, now),
      3600 + POST_END_VISIBILITY_SECONDS,
      'stopping before the deadline must keep the closure visible through it',
    );
    assert.equal(computeClosureTtlSeconds(now - 3600_000, now), POST_END_VISIBILITY_SECONDS, 'a past deadline adds nothing');
    assert.equal(computeClosureTtlSeconds(NaN, now), POST_END_VISIBILITY_SECONDS, 'a corrupt stored deadline must not break the stop write');
  });

  await test('setWithScopedExpiry applies the expiry and refuses nonsense', async () => {
    const calls: any[] = [];
    const fakeRedis = {
      ttl: async () => 900,
      set: async (key: string, value: string, options?: any) => {
        calls.push({ key, value, options });
        return 'OK';
      },
    };
    const ok = await setWithScopedExpiry(fakeRedis, 'session:x', 'payload', 7200);
    assert.equal(ok.ok, true);
    assert.deepEqual(calls[0].options, { EX: 7200 });

    const missing = await setWithScopedExpiry({ ttl: async () => -2, set: async () => 'OK' }, 'k', 'v', 7200);
    assert.equal(missing.ok, false);
    assert.equal((missing as any).reason, 'key_missing');

    assert.equal((await setWithScopedExpiry(fakeRedis, 'k', 'v', NaN)).ok, false);
    assert.equal((await setWithScopedExpiry(fakeRedis, 'k', 'v', 0)).ok, false);
  });

  // --- TASK-171 handler contracts ------------------------------------------
  // The handlers reach the shared mock store; wrapping its `set` records the
  // expiry each write carries without changing behaviour.
  async function captureSets(fn: () => Promise<void>) {
    const redis = await getRedisClient();
    const original = redis.set;
    const calls: Array<{ key: string; value: string; options?: any }> = [];
    redis.set = async (key: string, value: string, options?: any) => {
      calls.push({ key, value, options });
      return original.call(redis, key, value, options);
    };
    try {
      await fn();
    } finally {
      redis.set = original;
    }
    return calls;
  }

  await test('start with a trip plan stores the trip and scopes the expiry to it', async () => {
    const now = Date.now();
    const eta = new Date(now + 2 * 3600_000).toISOString();
    const deadline = new Date(now + 3 * 3600_000).toISOString();
    const res = mockRes();
    const sets = await captureSets(async () => {
      await startHandler(
        mockReq({
          body: {
            username: 'Alex',
            destination: { lat: 12.97, lng: 77.59, label: "Ivy's place" },
            etaAt: eta,
            deadlineAt: deadline,
          },
        }),
        res,
      );
    });

    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const sessionSet = sets.find((c) => c.key.startsWith('session:'));
    assert.ok(sessionSet, 'no session write captured');
    const expectedTtl = 3 * 3600 + POST_END_VISIBILITY_SECONDS;
    // Parsing the ISO strings loses no precision, so the TTL is exact.
    assert.equal(sessionSet.options?.EX, expectedTtl);
    const stored = JSON.parse(sessionSet.value);
    assert.deepEqual(stored.destination, { lat: 12.97, lng: 77.59, label: "Ivy's place" });
    assert.equal(stored.etaAt, new Date(eta).toISOString());
    assert.equal(stored.deadlineAt, new Date(deadline).toISOString());
    assert.equal(res.body.deadlineAt, new Date(deadline).toISOString());
    assert.equal(new Date(res.body.expiresAt).getTime(), new Date(stored.expiresAt).getTime());
  });

  await test('start without trip fields keeps the legacy duration default', async () => {
    const res = mockRes();
    const sets = await captureSets(async () => {
      await startHandler(mockReq({ body: { username: 'Alex' }, headers: {} }), res);
    });
    assert.equal(res.statusCode, 200);
    const sessionSet = sets.find((c) => c.key.startsWith('session:'));
    assert.ok(sessionSet, 'no session write captured');
    assert.equal(sessionSet.options?.EX, DEFAULT_DURATION_MINUTES * 60);
    const stored = JSON.parse(sessionSet.value);
    assert.ok(!('destination' in stored), 'legacy sessions must not grow trip fields');
  });

  await test('start rejects a past deadline and an over-ceiling duration', async () => {
    const past = mockRes();
    await startHandler(
      mockReq({ body: { deadlineAt: new Date(Date.now() - 60_000).toISOString() }, headers: {} }),
      past,
    );
    assert.equal(past.statusCode, 400);

    const huge = mockRes();
    await startHandler(
      mockReq({ body: { durationMinutes: MAX_SESSION_MINUTES + 1 }, headers: {} }),
      huge,
    );
    assert.equal(huge.statusCode, 400);
  });

  await test('stop re-scopes a legacy session to the post-end window', async () => {
    const { sessionId } = await seedSession({ initialDuration: 1440 });
    const res = mockRes();
    const sets = await captureSets(async () => {
      await stopHandler(mockReq({ query: { sessionId }, body: {} }), res);
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.endReason, 'ride_ended');
    const sessionSet = sets.find((c) => c.key === `session:${sessionId}`);
    assert.ok(sessionSet, 'no closure write captured');
    assert.equal(sessionSet.options?.EX, POST_END_VISIBILITY_SECONDS, 'a stopped share must not linger for the rest of a long duration');
    const stored = JSON.parse(sessionSet.value);
    assert.equal(stored.status, 'stopped');
    assert.ok(stored.endedAt, 'the closure must carry its timestamp');
  });

  await test('stop before the deadline keeps the closure visible through it', async () => {
    const deadline = new Date(Date.now() + 3600_000).toISOString();
    const { redis, sessionId } = await seedSession({ deadlineAt: deadline });
    const res = mockRes();
    const sets = await captureSets(async () => {
      await stopHandler(mockReq({ query: { sessionId }, body: { endReason: 'marked_safe' } }), res);
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.endReason, 'marked_safe');
    const sessionSet = sets.find((c) => c.key === `session:${sessionId}`);
    assert.ok(sessionSet, 'no closure write captured');
    assert.ok(
      sessionSet.options?.EX > POST_END_VISIBILITY_SECONDS &&
      sessionSet.options?.EX <= 3600 + POST_END_VISIBILITY_SECONDS,
      `closure TTL ${sessionSet.options?.EX} must cover the deadline plus the window`,
    );
    const stored = JSON.parse(await redis.get(`session:${sessionId}`));
    assert.equal(stored.endReason, 'marked_safe');
  });

  await test('stop refuses to claim success when a production deploy has no durable store', async () => {
    const { sessionId } = await seedSession();
    process.env.VERCEL_ENV = 'production';
    try {
      const res = mockRes();
      await stopHandler(mockReq({ query: { sessionId }, body: { endReason: 'marked_safe' } }), res);
      assert.equal(res.statusCode, 503);
      assert.notEqual(res.body?.success, true, 'a rider must never believe a safe-mark that no viewer can see');
    } finally {
      delete process.env.VERCEL_ENV;
    }
  });

  process.stdout.write(`\nlive-share: ${passed} passed, ${failures.length} failed\n`);
  if (failures.length) {
    failures.forEach((f) => process.stderr.write(`  FAIL ${f}\n`));
    process.exit(1);
  }
}

run();
