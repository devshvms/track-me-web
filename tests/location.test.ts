import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import locationHandler, {
  VIEWER_VISIBLE_FIELDS,
  deriveSessionTtlSeconds,
  getSessionCacheControl,
} from '../api/track/[sessionId]/location';
import pingHandler from '../api/track/[sessionId]/ping';
import { getRedisClient } from '../lib/redis';
import { auth } from '../lib/firebase';
import {
  MAX_PATH_POINTS,
  appendPathPoint,
  compactPath,
  computeBearingDegrees,
  haversineMeters,
} from '../lib/track/trail';
import {
  MAX_AUTO_WATCHERS,
  dispatchTrustedWatcherNotifications,
  normalizeWatcherUids,
} from '../lib/track/watchers';

type TestCase = { name: string; fn: () => void | Promise<void> };
const tests: TestCase[] = [];

function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

test('VIEWER_VISIBLE_FIELDS omits owner identity fields', () => {
  const fields = [...VIEWER_VISIBLE_FIELDS] as string[];
  assert.ok(!fields.includes('ownerEmail'), 'ownerEmail leaked to VIEWER_VISIBLE_FIELDS');
  assert.ok(!fields.includes('ownerUid'), 'ownerUid leaked to VIEWER_VISIBLE_FIELDS');
});

test('VIEWER_VISIBLE_FIELDS includes master tracker and v1.9.3 trail fields', () => {
  const fields = [...VIEWER_VISIBLE_FIELDS] as string[];
  assert.ok(fields.includes('username'), 'username missing from VIEWER_VISIBLE_FIELDS');
  assert.ok(fields.includes('status'), 'status missing from VIEWER_VISIBLE_FIELDS');
  assert.ok(fields.includes('startedAt'), 'startedAt missing from VIEWER_VISIBLE_FIELDS');
  assert.ok(fields.includes('stopReason'), 'stopReason missing from VIEWER_VISIBLE_FIELDS');
  assert.ok(fields.includes('lastLocation'), 'lastLocation missing from VIEWER_VISIBLE_FIELDS');
  assert.ok(fields.includes('path'), 'path missing from VIEWER_VISIBLE_FIELDS');
});

test('appendPathPoint deduplicates jitter < 15m and appends >= 15m rounded to 5 decimals', () => {
  const first = appendPathPoint([], 12.9715987, 77.5945627, 92.44);
  assert.deepStrictEqual(first.path, [[12.9716, 77.59456]]);
  assert.strictEqual(first.heading, 92.4);

  // Move ~4 meters north -> ignored in breadcrumb trail
  const jitter = appendPathPoint(first.path, 12.97163, 77.59456, 95);
  assert.strictEqual(jitter.path.length, 1);

  // Move ~111 meters north -> appended cleanly, fallback bearing ~0 deg when heading omitted
  const moved = appendPathPoint(jitter.path, 12.9726, 77.59456, null);
  assert.strictEqual(moved.path.length, 2);
  assert.deepStrictEqual(moved.path[1], [12.9726, 77.59456]);
  assert.ok(
    moved.heading !== null && (moved.heading >= 355 || moved.heading <= 5),
    `Expected northward fallback bearing, got ${moved.heading}`,
  );
  assert.ok(haversineMeters(moved.path[0], moved.path[1]) >= 100);
  const eastBearing = computeBearingDegrees([12.97, 77.59], [12.97, 77.6]);
  assert.ok(eastBearing > 85 && eastBearing < 95, `Expected ~90 deg east bearing, got ${eastBearing}`);
});

test('appendPathPoint preserves explicit 0 deg North heading and null stationary heading', () => {
  // Explicit 0 degrees True North heading must be preserved as 0, not converted to null or overridden
  const northHeading = appendPathPoint([], 12.9716, 77.59456, 0);
  assert.strictEqual(northHeading.heading, 0, '0 deg North heading must be preserved');

  // Stationary point without prior track points and without heading must return null heading
  const stationary = appendPathPoint([], 12.9716, 77.59456, null);
  assert.strictEqual(stationary.heading, null, 'Stationary point with null heading must return null');

  // Sub-15m GPS jitter with null heading must also return null
  const jitterStationary = appendPathPoint(stationary.path, 12.97162, 77.59456, null);
  assert.strictEqual(jitterStationary.heading, null, 'Jitter without motion or heading must return null');
});

test('compactPath decimates above MAX_PATH_POINTS while preserving first and last point', () => {
  const points: [number, number][] = [];
  for (let i = 0; i < MAX_PATH_POINTS + 12; i++) {
    points.push([12.9 + i * 0.001, 77.5 + i * 0.001]);
  }
  const compacted = compactPath(points);
  assert.ok(compacted.length <= MAX_PATH_POINTS, `Compacted length ${compacted.length} exceeded max`);
  assert.deepStrictEqual(compacted[0], points[0], 'Start point must be preserved');
  assert.deepStrictEqual(
    compacted[compacted.length - 1],
    points[points.length - 1],
    'End point must be preserved',
  );
});

test('normalizeWatcherUids deduplicates, rejects self and empty, and caps at MAX_AUTO_WATCHERS', () => {
  const result = normalizeWatcherUids(
    ['owner-1', ' w1 ', '', 'w2', 'w1', 42, 'w3', 'w4', 'w5', 'w6', 'w7'],
    'owner-1',
  );
  assert.deepStrictEqual(result, ['w1', 'w2', 'w3', 'w4', 'w5']);
  assert.strictEqual(result.length, MAX_AUTO_WATCHERS);
});

test('dispatchTrustedWatcherNotifications verifies Firestore relation, writes Redis inbox, and sends FCM', async () => {
  const redisWrites: Array<{ key: string; value: string; options: any }> = [];
  const fcmCalls: any[] = [];

  const mockDb = {
    collection(name: string) {
      assert.strictEqual(name, 'users');
      return {
        doc(uid: string) {
          return {
            collection(sub: string) {
              assert.strictEqual(sub, 'trusted_watchers');
              return {
                doc(watcherUid: string) {
                  return {
                    async get() {
                      if (uid === 'owner-1' && watcherUid === 'w-ok') {
                        return { exists: true, data: () => ({ autoNotify: true }) };
                      }
                      if (uid === 'owner-1' && watcherUid === 'w-paused') {
                        return { exists: true, data: () => ({ autoNotify: false }) };
                      }
                      return { exists: false };
                    },
                  };
                },
              };
            },
            async get() {
              if (uid === 'w-ok') {
                return { exists: true, data: () => ({ fcmToken: 'token-abc-123' }) };
              }
              return { exists: false };
            },
          };
        },
      };
    },
  };

  const mockRedis = {
    async set(key: string, value: string, options: any) {
      redisWrites.push({ key, value, options });
    },
  };

  const mockMessaging = {
    async sendEachForMulticast(payload: any) {
      fcmCalls.push(payload);
    },
  };

  const count = await dispatchTrustedWatcherNotifications({
    ownerUid: 'owner-1',
    riderName: 'Shivam',
    sessionId: 'sess-99',
    shareUrl: 'https://trackme.shvms.in/live/sess-99',
    startedAt: 1700000000000,
    expiresAt: '2026-11-12T17:00:00.000Z',
    ttlSeconds: 3600,
    watcherUids: ['owner-1', 'w-ok', 'w-paused', 'w-stranger'],
    db: mockDb,
    messaging: mockMessaging,
    redis: mockRedis,
  });

  assert.strictEqual(count, 1);
  assert.strictEqual(redisWrites.length, 1);
  assert.strictEqual(redisWrites[0].key, 'watcher_inbox:w-ok');
  assert.strictEqual(JSON.parse(redisWrites[0].value).sessionId, 'sess-99');
  assert.strictEqual(fcmCalls.length, 1);
  assert.deepStrictEqual(fcmCalls[0].tokens, ['token-abc-123']);
  assert.strictEqual(fcmCalls[0].data.type, 'live_share_started');
  assert.strictEqual(fcmCalls[0].data.sessionId, 'sess-99');
});

test('AASA and vercel.json expose universal links for verified iOS Team+BundleID with JSON headers', () => {
  const repoRoot = path.resolve(__dirname, '..');
  const aasaPath = path.join(repoRoot, 'public/.well-known/apple-app-site-association');
  const aasa = JSON.parse(fs.readFileSync(aasaPath, 'utf8'));
  const detail = aasa.applinks.details[0];
  assert.ok(
    detail.appIDs.includes('5BS87KKKN8.in.shvms.track-me-ios'),
    'AASA must use verified Apple Team+BundleID 5BS87KKKN8.in.shvms.track-me-ios',
  );
  const paths = detail.components.map((c: { '/': string }) => c['/']);
  assert.ok(paths.includes('/live/*'));
  assert.ok(paths.includes('/g/*'));
  assert.ok(paths.includes('/r/*'));

  const vercelConfig = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'vercel.json'), 'utf8'),
  );
  const wellKnownHeaders = (vercelConfig.headers || []).map((h: { source: string }) => h.source);
  assert.ok(wellKnownHeaders.includes('/.well-known/apple-app-site-association'));
  assert.ok(wellKnownHeaders.includes('/.well-known/assetlinks.json'));
});

test('tracker.html includes Smart App Banner, /live/watcher guard, trail polyline, heading cone, and safe textContent', () => {
  const trackerHtml = fs.readFileSync(
    path.resolve(__dirname, '../public/tracker.html'),
    'utf8',
  );
  assert.ok(trackerHtml.includes('id="smartAppBanner"'));
  assert.ok(trackerHtml.includes('id="openAppBtn"'));
  assert.ok(trackerHtml.includes("const isWatcherInvite = sessionId === 'watcher';"));
  assert.ok(trackerHtml.includes('Array.isArray(pt)'));
  assert.ok(trackerHtml.includes('trailCasing'));
  assert.ok(trackerHtml.includes('trailLine'));
  assert.ok(trackerHtml.includes('heading-cone-wrap'));
  assert.ok(trackerHtml.includes('start-pin'));
  assert.ok(trackerHtml.includes('nameBadge.textContent = username'));
  assert.ok(trackerHtml.includes("statusEl.innerText = 'Connecting...';"));
  assert.ok(trackerHtml.includes('stopPollingTimers()'));
});

test('deriveSessionTtlSeconds correctly calculates remaining seconds from ISO8601 expiresAt', () => {
  const now = 1700000000000;
  // 3600 seconds in the future
  const futureIso = new Date(now + 3600 * 1000).toISOString();
  assert.strictEqual(deriveSessionTtlSeconds({ expiresAt: futureIso }, now), 3600);

  // 15 seconds in the past -> clamped to 0
  const pastIso = new Date(now - 15 * 1000).toISOString();
  assert.strictEqual(deriveSessionTtlSeconds({ expiresAt: pastIso }, now), 0);

  // Missing or malformed sessionData
  assert.strictEqual(deriveSessionTtlSeconds(null, now), 0);
  assert.strictEqual(deriveSessionTtlSeconds({}, now), 0);
  assert.strictEqual(deriveSessionTtlSeconds({ expiresAt: 'invalid-date' }, now), 0);
});

test('mockRedis emulates TTL expiration, keys lazy eviction, and multi() pipelining', async () => {
  const redis = await getRedisClient();
  const testKey = 'test:session:cie001';

  // Test set with EX option
  await redis.set(testKey, JSON.stringify({ ok: true }), { EX: 120 });
  const ttl = await redis.ttl(testKey);
  assert.ok(ttl > 100 && ttl <= 120, `Expected TTL around 120, got ${ttl}`);

  const val = await redis.get(testKey);
  assert.ok(val !== null);

  // Test expire update
  await redis.expire(testKey, 300);
  const updatedTtl = await redis.ttl(testKey);
  assert.ok(updatedTtl > 280 && updatedTtl <= 300, `Expected updated TTL around 300, got ${updatedTtl}`);

  // Test multi() pipelining for zsets
  const zsetKey = 'test:zset:cie001';
  await redis.zAdd(zsetKey, [
    { score: 100, value: 'item1' },
    { score: 200, value: 'item2' },
    { score: 300, value: 'item3' },
  ]);

  assert.strictEqual(typeof redis.multi, 'function');
  const multi = redis.multi();
  multi.zRemRangeByScore(zsetKey, 0, 150);
  multi.zCard(zsetKey);
  const results = await multi.exec();

  assert.strictEqual(results.length, 2);
  assert.strictEqual(results[0], 1, 'zRemRangeByScore should have removed 1 item');
  assert.strictEqual(results[1], 2, 'zCard should report 2 remaining items');

  // Clean up
  await redis.del(testKey);
  await redis.del(zsetKey);
  assert.strictEqual(await redis.ttl(testKey), -2, 'Deleted key should return -2 for ttl');
});

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

test('getSessionCacheControl provides optimal edge caching for active, ended, and 404 sessions', () => {
  assert.strictEqual(
    getSessionCacheControl({ status: 'active' }),
    's-maxage=2, stale-while-revalidate',
    'Active session must have short 2s edge cache'
  );
  assert.strictEqual(
    getSessionCacheControl({ status: 'stopped' }),
    's-maxage=300, max-age=60, stale-while-revalidate',
    'Stopped session must be cached for 5 min at edge'
  );
  assert.strictEqual(
    getSessionCacheControl({ status: 'ended' }),
    's-maxage=300, max-age=60, stale-while-revalidate',
    'Ended session must be cached for 5 min at edge'
  );
  assert.strictEqual(
    getSessionCacheControl({ status: 'active', endedAt: '2026-11-13T08:00:00.000Z' }),
    's-maxage=300, max-age=60, stale-while-revalidate',
    'Session with endedAt must be cached for 5 min at edge'
  );
  assert.strictEqual(
    getSessionCacheControl(null),
    's-maxage=60, max-age=10',
    'Missing session (404) must be cached for 60s at edge to deflect crawler loops'
  );
});

test('_mockRedis.exists accurately detects presence, multiple keys, and lazy TTL eviction', async () => {
  const redis = await getRedisClient();
  const k1 = 'test:exists:k1';
  const k2 = 'test:exists:k2';

  await redis.set(k1, 'v1');
  await redis.set(k2, 'v2', { PX: 50 }); // expires in 50ms

  assert.strictEqual(await redis.exists(k1), 1, 'Existing key must return 1');
  assert.strictEqual(await redis.exists('test:exists:nonexistent'), 0, 'Non-existent key must return 0');
  assert.strictEqual(await redis.exists(k1, 'test:exists:nonexistent'), 1, 'Multi-key exists must count present keys');

  // Wait 60ms for k2 to expire
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.strictEqual(await redis.exists(k2), 0, 'Expired key must return 0');

  await redis.del(k1);
  assert.strictEqual(await redis.exists(k1), 0, 'Deleted key must return 0');
});

test('location GET sets Cache-Control header based on session state and 404', async () => {
  const redis = await getRedisClient();
  const activeSessionId = 'active-session-cie006';
  const stoppedSessionId = 'stopped-session-cie006';

  await redis.set(`session:${activeSessionId}`, JSON.stringify({
    username: 'Alice',
    status: 'active',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    lastLocation: { lat: 12.97, lng: 77.59 },
  }));

  await redis.set(`session:${stoppedSessionId}`, JSON.stringify({
    username: 'Bob',
    status: 'stopped',
    stopReason: 'Arrived at destination',
    endedAt: new Date().toISOString(),
    lastLocation: { lat: 12.98, lng: 77.60 },
  }));

  // Test active session GET
  const activeRes = fakeResponse();
  await locationHandler({ method: 'GET', query: { sessionId: activeSessionId } } as any, activeRes as any);
  assert.strictEqual(activeRes.captured.statusCode, 200);
  assert.strictEqual(activeRes.captured.headers['Cache-Control'], 's-maxage=2, stale-while-revalidate');

  // Test stopped session GET
  const stoppedRes = fakeResponse();
  await locationHandler({ method: 'GET', query: { sessionId: stoppedSessionId } } as any, stoppedRes as any);
  assert.strictEqual(stoppedRes.captured.statusCode, 200);
  assert.strictEqual(stoppedRes.captured.headers['Cache-Control'], 's-maxage=300, max-age=60, stale-while-revalidate');
  assert.strictEqual(stoppedRes.captured.body.status, 'stopped');
  assert.strictEqual(stoppedRes.captured.body.stopReason, 'Arrived at destination');
  assert.ok(typeof stoppedRes.captured.body.endedAt === 'string');

  // Test missing session GET (404)
  const missingRes = fakeResponse();
  await locationHandler({ method: 'GET', query: { sessionId: 'nonexistent-session-cie006' } } as any, missingRes as any);
  assert.strictEqual(missingRes.captured.statusCode, 404);
  assert.strictEqual(missingRes.captured.headers['Cache-Control'], 's-maxage=60, max-age=10');

  // Clean up
  await redis.del(`session:${activeSessionId}`);
  await redis.del(`session:${stoppedSessionId}`);
});

test('ping endpoint uses redis.exists to verify session presence without downloading full payload', async () => {
  const redis = await getRedisClient();
  const sessionId = 'ping-test-session-cie006';

  // Simulate session with large coordinates array
  await redis.set(`session:${sessionId}`, JSON.stringify({
    ownerUid: 'user-xyz',
    status: 'active',
    path: Array.from({ length: 50 }, (_, i) => [12.9 + i * 0.001, 77.5 + i * 0.001]),
  }), { EX: 300 });

  // Successful ping
  const pingRes = fakeResponse();
  await pingHandler({
    method: 'POST',
    query: { sessionId },
    body: { viewerId: 'viewer-abc' },
  } as any, pingRes as any);

  assert.strictEqual(pingRes.captured.statusCode, 200);
  assert.strictEqual(pingRes.captured.body.success, true);
  assert.strictEqual(typeof pingRes.captured.body.viewers, 'number');

  // Ping for missing session -> 404
  const missingPingRes = fakeResponse();
  await pingHandler({
    method: 'POST',
    query: { sessionId: 'nonexistent-ping-session-cie006' },
    body: { viewerId: 'viewer-abc' },
  } as any, missingPingRes as any);

  assert.strictEqual(missingPingRes.captured.statusCode, 404);

  // Clean up
  await redis.del(`session:${sessionId}`);
  await redis.del(`session:${sessionId}:viewers`);
});

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

test('locationHandler POST enforces powerSaveMode on low battery threshold (<= 15%)', async () => {
  const redis = await getRedisClient();
  const sessionId = 'battery-defense-test-cie015';

  await redis.set(`session:${sessionId}`, JSON.stringify({
    ownerUid: 'user-owner-123',
    status: 'active',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    path: [],
  }));

  // 1. Post with batteryLevel: 12 and powerSaveMode: false -> powerSaveMode must resolve to true
  const res1 = fakeResponse();
  await locationHandler({
    method: 'POST',
    query: { sessionId },
    headers: { authorization: 'Bearer valid-owner-token' },
    body: {
      lat: 12.9716,
      lng: 77.5946,
      batteryLevel: 12,
      powerSaveMode: false,
    },
  } as any, res1 as any);

  assert.strictEqual(res1.captured.statusCode, 200);
  const updated1 = JSON.parse(await redis.get(`session:${sessionId}`) as string);
  assert.strictEqual(updated1.lastLocation.powerSaveMode, true, 'Low battery (12%) must enforce powerSaveMode = true');
  assert.strictEqual(updated1.lastLocation.batteryLevel, 12);

  // 2. Post with batteryLevel: 80 and powerSaveMode: false -> powerSaveMode must be false
  const res2 = fakeResponse();
  await locationHandler({
    method: 'POST',
    query: { sessionId },
    headers: { authorization: 'Bearer valid-owner-token' },
    body: {
      lat: 12.9720,
      lng: 77.5950,
      batteryLevel: 80,
      powerSaveMode: false,
    },
  } as any, res2 as any);

  assert.strictEqual(res2.captured.statusCode, 200);
  const updated2 = JSON.parse(await redis.get(`session:${sessionId}`) as string);
  assert.strictEqual(updated2.lastLocation.powerSaveMode, false, 'Normal battery with powerSaveMode: false must remain false');

  // 3. Post with batteryLevel: 80 and powerSaveMode: true -> powerSaveMode must be true
  const res3 = fakeResponse();
  await locationHandler({
    method: 'POST',
    query: { sessionId },
    headers: { authorization: 'Bearer valid-owner-token' },
    body: {
      lat: 12.9725,
      lng: 77.5955,
      batteryLevel: 80,
      powerSaveMode: true,
    },
  } as any, res3 as any);

  assert.strictEqual(res3.captured.statusCode, 200);
  const updated3 = JSON.parse(await redis.get(`session:${sessionId}`) as string);
  assert.strictEqual(updated3.lastLocation.powerSaveMode, true, 'Explicit powerSaveMode: true must be respected');

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

  process.stdout.write(`\nlocation: ${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) {
    for (const f of failures) process.stderr.write(`  - ${f}\n`);
    process.exit(1);
  }
}

main();
