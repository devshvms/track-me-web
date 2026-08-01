import { createClient } from 'redis';

// Global memory store for serverless fallback when external Redis instance (REDIS_URL) is not provided or reachable
const globalAny: any = global;
if (!globalAny._mockRedis) {
  const store = new Map<string, string>();
  const zsets = new Map<string, Map<string, number>>();
  const hashes = new Map<string, Map<string, number>>();

  globalAny._mockRedis = {
    isOpen: true,
    isMock: true,
    async get(key: string) {
      return store.get(key) || null;
    },
    async set(key: string, value: string, options?: any) {
      store.set(key, value);
      return 'OK';
    },
    async keys(pattern: string) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      return Array.from(store.keys()).filter(k => regex.test(k));
    },
    async mGet(keys: string[]) {
      if (!keys || keys.length === 0) return [];
      return keys.map(k => store.get(k) || null);
    },
    async mget(keys: string[]) {
      return this.mGet(keys);
    },
    async del(key: string) {
      store.delete(key);
      zsets.delete(key);
      hashes.delete(key);
      return 1;
    },
    async incr(key: string) {
      const current = parseInt(store.get(key) || '0', 10);
      const updated = current + 1;
      store.set(key, String(updated));
      return updated;
    },
    async incrByFloat(key: string, increment: number) {
      const current = parseFloat(store.get(key) || '0');
      const updated = current + increment;
      store.set(key, String(updated));
      return updated;
    },
    async zAdd(key: string, item: { score: number; value: string } | Array<{ score: number; value: string }>) {
      if (!zsets.has(key)) zsets.set(key, new Map());
      const set = zsets.get(key)!;
      const items = Array.isArray(item) ? item : [item];
      for (const i of items) set.set(i.value, i.score);
      return items.length;
    },
    async zRem(key: string, value: string) {
      if (!zsets.has(key)) return 0;
      return zsets.get(key)!.delete(value) ? 1 : 0;
    },
    async zRemRangeByScore(key: string, min: number, max: number) {
      if (!zsets.has(key)) return 0;
      const set = zsets.get(key)!;
      let removed = 0;
      for (const [val, score] of set.entries()) {
        if (score >= min && score <= max) {
          set.delete(val);
          removed++;
        }
      }
      return removed;
    },
    async zScore(key: string, member: string) {
      if (!zsets.has(key)) return null;
      const score = zsets.get(key)!.get(member);
      return score !== undefined ? score : null;
    },
    async zCard(key: string) {
      if (!zsets.has(key)) return 0;
      return zsets.get(key)!.size;
    },
    async zCount(key: string, min: number, max: number) {
      if (!zsets.has(key)) return 0;
      const set = zsets.get(key)!;
      let count = 0;
      for (const score of set.values()) {
        if (score >= min && score <= max) count++;
      }
      return count;
    },
    async ttl(key: string) {
      // Mock always returns -1 (no expiry) since we don't track TTLs in memory.
      // -1 is a real Redis answer too ("exists, never expires"), so every caller
      // must handle it. Writing `if (ttl > 0)` here silently discards the write
      // under the mock AND against a real key with no expiry — see
      // setPreservingExpiry() below, which is the only supported way to rewrite
      // a session blob.
      return store.has(key) || zsets.has(key) || hashes.has(key) ? -1 : -2;
    },
    async hIncrBy(key: string, field: string, increment: number) {
      if (!hashes.has(key)) hashes.set(key, new Map());
      const hash = hashes.get(key)!;
      const current = hash.get(field) || 0;
      const updated = current + increment;
      hash.set(field, updated);
      return updated;
    },
    async expire(key: string, seconds: number) {
      return 1;
    },
    async connect() {
      return this;
    }
  };
}

let cachedClient: any = null;

// getRedisClient() runs on every request, so a per-call warning would drown the
// logs and get filtered out — but a fallback that logs nothing is worse: it is
// what turns a dropped live-share write into an *invisible* dropped write
// (TASK-176). Each distinct degradation is therefore logged exactly once per
// process, which is once per cold serverless instance.
const warnedFallbacks = new Set<string>();
function warnFallbackOnce(cause: string, detail: string) {
  if (warnedFallbacks.has(cause)) return;
  warnedFallbacks.add(cause);
  console.warn(
    `[redis] DEGRADED: using the in-memory mock store (${cause}). ${detail} ` +
    'Sessions live only in this serverless instance, are not shared between ' +
    'instances, vanish on cold start, and have no TTL. Live-share sessions are ' +
    'not durable until REDIS_URL points at a real Redis instance.',
  );
}

export async function getRedisClient() {
  if (cachedClient && cachedClient.isOpen) {
    return cachedClient;
  }

  const redisUrl = process.env.REDIS_URL;
  if (redisUrl && redisUrl !== 'redis://localhost:6379') {
    try {
      if (!cachedClient || cachedClient.isMock) {
        cachedClient = createClient({ url: redisUrl });
        cachedClient.on('error', (err: any) => console.error('Redis Client Error:', err));
      }
      if (!cachedClient.isOpen) {
        await cachedClient.connect();
      }
      return cachedClient;
    } catch (err) {
      warnFallbackOnce('REDIS_URL is set but the connection failed', `Connection error: ${(err as Error)?.message || err}.`);
      return globalAny._mockRedis;
    }
  }

  if (!redisUrl) {
    warnFallbackOnce('REDIS_URL is not set', 'No Redis URL was provided to this deployment.');
  } else {
    // `redis://localhost:6379` is special-cased because a serverless function
    // has no localhost Redis to reach. It used to be the value documented in
    // doc/technical.md, so it is a value people actually deploy with.
    warnFallbackOnce(
      'REDIS_URL is redis://localhost:6379',
      'That value is treated as "no Redis" because a serverless function cannot reach localhost.',
    );
  }

  return globalAny._mockRedis;
}

/** The in-memory fallback lives in one process and disappears with it. */
export function isDurableStore(redis: any): boolean {
  return !redis?.isMock;
}

/**
 * True where the in-memory mock is a fault rather than a convenience.
 *
 * Local development and the test suite deliberately run on the mock, so they
 * must keep working. A production deployment serving live share out of a
 * per-instance memory map is a different thing: the rider's next upload can
 * land on a different instance that has never heard of the session, so the
 * viewer's pin freezes while the phone reports success. That is DEFECT-B, and
 * on the safety surface it must fail loudly instead.
 */
export function expectsDurableStore(): boolean {
  return process.env.VERCEL_ENV === 'production';
}

export type RedisWriteResult =
  | { ok: true; ttl: number }
  | { ok: false; reason: 'key_missing' | 'write_failed'; ttl: number; error?: unknown };

/**
 * Overwrite `key` while preserving whatever expiry it already carries.
 *
 * Redis TTL semantics are the whole point here:
 *   ttl  > 0  the key has a live expiry -> re-apply it, so rewriting a session
 *             never extends it past the window its owner chose.
 *   ttl == -1 the key exists with NO expiry -> write it WITHOUT an EX option.
 *             The in-memory fallback reports -1 unconditionally, so in a
 *             degraded deployment this is the normal case, not an exotic one.
 *   ttl == -2 the key does not exist; it expired between the read and this
 *             write. There is nothing to update, and recreating it would
 *             resurrect an expired session, so this is reported as a failure.
 *
 * The idiom this replaces was `if (ttl > 0) { await redis.set(...) }`, which
 * dropped the write for both -1 and -2 while the caller went on to return
 * 200 {success:true}. The rider's phone believed it was uploading and the
 * viewer watched a frozen pin, which reads as a stationary rider rather than a
 * dead feed (DEFECT-B / TASK-170).
 *
 * Callers MUST branch on `ok` and MUST NOT report success when it is false.
 */
export async function setPreservingExpiry(
  redis: any,
  key: string,
  value: string,
): Promise<RedisWriteResult> {
  let ttl: number;
  try {
    ttl = await redis.ttl(key);
  } catch (error) {
    return { ok: false, reason: 'write_failed', ttl: Number.NaN, error };
  }

  if (ttl === -2) {
    return { ok: false, reason: 'key_missing', ttl };
  }

  // Any answer that is not a finite number means we cannot reason about the
  // expiry. Writing without EX would strip the TTL and mint an immortal
  // tracking link, so refuse rather than guess.
  if (typeof ttl !== 'number' || !Number.isFinite(ttl)) {
    return { ok: false, reason: 'write_failed', ttl: Number.NaN };
  }

  try {
    const result = ttl > 0
      ? await redis.set(key, value, { EX: ttl })
      : await redis.set(key, value);
    // node-redis resolves SET to 'OK'; an explicit null means the server
    // declined the write. Treat that as a failure, never as a success.
    if (result === null) {
      return { ok: false, reason: 'write_failed', ttl };
    }
    return { ok: true, ttl };
  } catch (error) {
    return { ok: false, reason: 'write_failed', ttl, error };
  }
}

/**
 * Overwrite `key` and give it an explicit expiry, replacing whatever expiry it
 * had. This is the closure write (TASK-171 / D5): when a ride ends, the
 * session's lifetime is re-scoped to the trip — see computeClosureTtlSeconds
 * in lib/tripExpiry.ts — rather than left to run out a duration chosen before
 * the trip was over.
 *
 * Same contract as setPreservingExpiry: the key must already exist (a closure
 * for an expired session would resurrect it), and callers MUST branch on `ok`
 * and never report success when it is false.
 */
export async function setWithScopedExpiry(
  redis: any,
  key: string,
  value: string,
  ttlSeconds: number,
): Promise<RedisWriteResult> {
  if (!Number.isFinite(ttlSeconds) || ttlSeconds < 1) {
    return { ok: false, reason: 'write_failed', ttl: Number.NaN };
  }

  let ttl: number;
  try {
    ttl = await redis.ttl(key);
  } catch (error) {
    return { ok: false, reason: 'write_failed', ttl: Number.NaN, error };
  }

  if (ttl === -2) {
    return { ok: false, reason: 'key_missing', ttl };
  }

  try {
    const result = await redis.set(key, value, { EX: Math.ceil(ttlSeconds) });
    if (result === null) {
      return { ok: false, reason: 'write_failed', ttl };
    }
    return { ok: true, ttl };
  } catch (error) {
    return { ok: false, reason: 'write_failed', ttl, error };
  }
}

export async function redisMGet(redis: any, keys: string[]): Promise<Array<string | null>> {
  if (keys.length === 0) return [];

  if (typeof redis.mGet === 'function') {
    return redis.mGet(keys);
  }

  if (typeof redis.mget === 'function') {
    return redis.mget(keys);
  }

  return Promise.all(keys.map((key) => redis.get(key)));
}
