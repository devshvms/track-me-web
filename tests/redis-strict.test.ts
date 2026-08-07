import assert from 'node:assert';
import path from 'node:path';

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

const MODULE_PATH = path.join(__dirname, '..', 'lib', 'redis.ts');

/**
 * `getStrictRedisClient` reads `process.env.REDIS_URL` at call time but caches the connection in
 * module scope, so each scenario gets a fresh module instance. Also clears the global mock, which
 * otherwise persists across reloads and would let one case observe another's state.
 */
function loadRedisModule(redisUrl?: string) {
  delete require.cache[require.resolve(MODULE_PATH)];
  delete (global as any)._mockRedis;
  if (redisUrl === undefined) {
    delete process.env.REDIS_URL;
  } else {
    process.env.REDIS_URL = redisUrl;
  }
  return require(MODULE_PATH);
}

/**
 * Several cases deliberately fail to connect, and the library plus our own handlers log the
 * stack traces. A passing suite that prints walls of ECONNREFUSED trains people to ignore CI
 * output, so the expected noise is swallowed here — real failures still surface as `✗`.
 */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const realError = console.error;
  const realWarn = console.warn;
  console.error = () => {};
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.error = realError;
    console.warn = realWarn;
  }
}

function fakeResponse() {
  const captured: any = { statusCode: null, body: null, headers: {} as Record<string, string> };
  return {
    captured,
    setHeader(name: string, value: string) {
      captured.headers[name] = value;
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

const originalRedisUrl = process.env.REDIS_URL;

async function run() {
  // --- B2: the mock must never reach group traffic ---

  await test('getRedisClient still degrades to the mock with no REDIS_URL (legacy behaviour intact)', async () => {
    // /api/track/* and /api/export/* depend on this. GR-02 must not change it — a rate counter
    // that degrades is survivable; the point is that group routes opt out, not that everyone does.
    const mod = loadRedisModule(undefined);
    const client = await mod.getRedisClient();
    assert.strictEqual(mod.isMockRedis(client), true, 'legacy getRedisClient stopped returning the mock');
  });

  await test('getStrictRedisClient throws instead of returning the mock when REDIS_URL is unset', async () => {
    const mod = loadRedisModule(undefined);
    await assert.rejects(() => mod.getStrictRedisClient(), mod.RedisUnavailableError);
  });

  await test('getStrictRedisClient throws when Redis is configured but unreachable', async () => {
    // The nastier half of B2: REDIS_URL is set, so the operator believes Redis is live, but the
    // connection fails and getRedisClient() quietly hands back a mock.
    const mod = loadRedisModule('redis://127.0.0.1:1');
    await quietly(() => assert.rejects(() => mod.getStrictRedisClient(), mod.RedisUnavailableError));
  });

  await test('getRedisClient DOES silently return the mock in that same unreachable case', async () => {
    // Pins the divergence that motivates this task. If this ever starts failing, the legacy
    // fallback was changed and every route's failure mode moved with it.
    const mod = loadRedisModule('redis://127.0.0.1:1');
    const client = await quietly(() => mod.getRedisClient());
    assert.strictEqual(mod.isMockRedis(client), true);
  });

  await test('getStrictRedisClient does not special-case the localhost sentinel', async () => {
    // getRedisClient() treats redis://localhost:6379 as "use the mock" without ever trying. The
    // strict path must actually attempt a connection — a real local Redis is exactly what group
    // development against a staging relay needs (H7).
    //
    // Asserted as "never the mock" rather than "always throws" so the result does not depend on
    // whether the machine running the tests happens to have Redis on 6379: with one, we connect;
    // without one, we throw. Both are correct; silently mocking is not.
    const mod = loadRedisModule('redis://localhost:6379');
    const legacy = await mod.getRedisClient();
    assert.strictEqual(mod.isMockRedis(legacy), true, 'legacy localhost heuristic changed');

    let strict: any = null;
    try {
      strict = await quietly(() => mod.getStrictRedisClient());
    } catch (err) {
      assert.ok(err instanceof mod.RedisUnavailableError, `threw the wrong error type: ${err}`);
    }
    if (strict) {
      assert.strictEqual(mod.isMockRedis(strict), false, 'strict path returned the mock for localhost');
      await strict.destroy?.();
    }
  });

  // --- The typed error contract the Android client keys off ---

  await test('RedisUnavailableError carries a 503, a stable code, and retryable', async () => {
    const mod = loadRedisModule(undefined);
    const err = new mod.RedisUnavailableError('test');
    assert.strictEqual(err.statusCode, 503);
    assert.strictEqual(err.code, 'REDIS_UNAVAILABLE');
    assert.strictEqual(err.retryable, true);
    assert.strictEqual(err.name, 'RedisUnavailableError');
    assert.ok(err instanceof Error);
  });

  await test('sendRedisError responds 503 with the typed body and Retry-After', async () => {
    const mod = loadRedisModule(undefined);
    const res = fakeResponse();
    const handled = mod.sendRedisError(res, new mod.RedisUnavailableError('connection failed'));
    assert.strictEqual(handled, true);
    assert.strictEqual(res.captured.statusCode, 503);
    assert.strictEqual(res.captured.body.code, 'REDIS_UNAVAILABLE');
    assert.strictEqual(res.captured.body.retryable, true);
    assert.strictEqual(res.captured.headers['Retry-After'], '5');
  });

  await test('sendRedisError never leaks the internal reason to the caller', async () => {
    // The message embeds why we failed; the response must not. A connection string or host in a
    // 503 body is free reconnaissance.
    const mod = loadRedisModule(undefined);
    const res = fakeResponse();
    mod.sendRedisError(res, new mod.RedisUnavailableError('redis://secret-host:6379 refused'));
    assert.ok(!JSON.stringify(res.captured.body).includes('secret-host'), 'internal reason leaked');
  });

  await test('sendRedisError declines errors it does not own', async () => {
    const mod = loadRedisModule(undefined);
    const res = fakeResponse();
    assert.strictEqual(mod.sendRedisError(res, new Error('something else')), false);
    assert.strictEqual(res.captured.statusCode, null, 'wrote a response for an unrelated error');
  });

  // --- Detection helper ---

  await test('isMockRedis identifies the mock and rejects everything else', async () => {
    const mod = loadRedisModule(undefined);
    const mock = await mod.getRedisClient();
    assert.strictEqual(mod.isMockRedis(mock), true);
    for (const notMock of [null, undefined, {}, { isMock: false }, { isMock: 'true' }, { isOpen: true }]) {
      assert.strictEqual(mod.isMockRedis(notMock), false, `treated ${JSON.stringify(notMock)} as the mock`);
    }
  });

  await test('the mock still self-identifies via isMock', async () => {
    // isMockRedis is only as good as this flag. A future mock rewrite that drops it would make
    // every guard above silently pass, which is exactly the B2 failure shape again.
    const mod = loadRedisModule(undefined);
    const mock = await mod.getRedisClient();
    assert.strictEqual(mock.isMock, true);
  });

  process.stdout.write(`\nredis-strict: ${passed} passed, ${failures.length} failed\n`);
  if (originalRedisUrl === undefined) {
    delete process.env.REDIS_URL;
  } else {
    process.env.REDIS_URL = originalRedisUrl;
  }
  if (failures.length > 0) {
    for (const f of failures) process.stderr.write(`  - ${f}\n`);
    process.exit(1);
  }
  // Any client socket left open keeps the event loop alive and the run never ends.
  process.exit(0);
}

run();
