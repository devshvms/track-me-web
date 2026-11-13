import { createClient } from 'redis';

// Global memory store for serverless fallback when external Redis instance (REDIS_URL) is not provided or reachable
const globalAny: any = global;
if (!globalAny._mockRedis) {
  const store = new Map<string, string>();
  const zsets = new Map<string, Map<string, number>>();
  const hashes = new Map<string, Map<string, number>>();
  // High-fidelity in-memory TTL expiration tracker (timestamp in ms)
  const expiries = new Map<string, number>();

  const isExpired = (key: string): boolean => {
    const exp = expiries.get(key);
    if (exp !== undefined && Date.now() >= exp) {
      store.delete(key);
      zsets.delete(key);
      hashes.delete(key);
      expiries.delete(key);
      return true;
    }
    return false;
  };

  globalAny._mockRedis = {
    isOpen: true,
    isMock: true,
    async get(key: string) {
      if (isExpired(key)) return null;
      return store.get(key) || null;
    },
    async exists(...keys: string[]): Promise<number> {
      if (!keys || keys.length === 0) return 0;
      let count = 0;
      for (const key of keys) {
        if (!key) continue;
        if (isExpired(key)) {
          store.delete(key);
          zsets.delete(key);
          hashes.delete(key);
          expiries.delete(key);
          continue;
        }
        if (store.has(key) || zsets.has(key) || hashes.has(key)) {
          count++;
        }
      }
      return count;
    },
    async set(key: string, value: string, options?: any) {
      store.set(key, value);
      if (options?.EX && typeof options.EX === 'number' && options.EX > 0) {
        expiries.set(key, Date.now() + options.EX * 1000);
      } else if (options?.PX && typeof options.PX === 'number' && options.PX > 0) {
        expiries.set(key, Date.now() + options.PX);
      } else {
        expiries.delete(key);
      }
      return 'OK';
    },
    async keys(pattern: string) {
      // Lazy evict any expired keys before pattern evaluation
      for (const k of Array.from(expiries.keys())) {
        isExpired(k);
      }
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      return Array.from(store.keys()).filter(k => regex.test(k));
    },
    async mGet(keys: string[]) {
      if (!keys || keys.length === 0) return [];
      return keys.map(k => {
        if (isExpired(k)) return null;
        return store.get(k) || null;
      });
    },
    async mget(keys: string[]) {
      return this.mGet(keys);
    },
    async del(key: string) {
      const existed = store.has(key) || zsets.has(key) || hashes.has(key);
      store.delete(key);
      zsets.delete(key);
      hashes.delete(key);
      expiries.delete(key);
      return existed ? 1 : 0;
    },
    async incr(key: string) {
      if (isExpired(key)) store.delete(key);
      const current = parseInt(store.get(key) || '0', 10);
      const updated = current + 1;
      store.set(key, String(updated));
      return updated;
    },
    async incrByFloat(key: string, increment: number) {
      if (isExpired(key)) store.delete(key);
      const current = parseFloat(store.get(key) || '0');
      const updated = current + increment;
      store.set(key, String(updated));
      return updated;
    },
    async zAdd(key: string, item: { score: number; value: string } | Array<{ score: number; value: string }>) {
      if (isExpired(key)) zsets.delete(key);
      if (!zsets.has(key)) zsets.set(key, new Map());
      const set = zsets.get(key)!;
      const items = Array.isArray(item) ? item : [item];
      for (const i of items) set.set(i.value, i.score);
      return items.length;
    },
    async zRem(key: string, value: string) {
      if (isExpired(key)) return 0;
      if (!zsets.has(key)) return 0;
      return zsets.get(key)!.delete(value) ? 1 : 0;
    },
    async zRemRangeByScore(key: string, min: number, max: number) {
      if (isExpired(key)) return 0;
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
      if (isExpired(key)) return null;
      if (!zsets.has(key)) return null;
      const score = zsets.get(key)!.get(member);
      return score !== undefined ? score : null;
    },
    async zCard(key: string) {
      if (isExpired(key)) return 0;
      if (!zsets.has(key)) return 0;
      return zsets.get(key)!.size;
    },
    async zCount(key: string, min: number, max: number) {
      if (isExpired(key)) return 0;
      if (!zsets.has(key)) return 0;
      const set = zsets.get(key)!;
      let count = 0;
      for (const score of set.values()) {
        if (score >= min && score <= max) count++;
      }
      return count;
    },
    async ttl(key: string) {
      const exists = store.has(key) || zsets.has(key) || hashes.has(key);
      if (!exists) return -2; // Key does not exist
      const exp = expiries.get(key);
      if (exp === undefined) return -1; // Key exists without TTL
      const remainingSec = Math.floor((exp - Date.now()) / 1000);
      if (remainingSec <= 0) {
        store.delete(key);
        zsets.delete(key);
        hashes.delete(key);
        expiries.delete(key);
        return -2;
      }
      return remainingSec;
    },
    async hIncrBy(key: string, field: string, increment: number) {
      if (isExpired(key)) hashes.delete(key);
      if (!hashes.has(key)) hashes.set(key, new Map());
      const hash = hashes.get(key)!;
      const current = hash.get(field) || 0;
      const updated = current + increment;
      hash.set(field, updated);
      return updated;
    },
    async expire(key: string, seconds: number) {
      const exists = store.has(key) || zsets.has(key) || hashes.has(key);
      if (!exists || seconds <= 0) return 0;
      expiries.set(key, Date.now() + seconds * 1000);
      return 1;
    },
    multi() {
      // Pipelining/multi implementation for batched operations in mock mode
      const queue: Array<() => Promise<any>> = [];
      const multiProxy: any = new Proxy({}, {
        get(_target, prop: string) {
          if (prop === 'exec') {
            return async () => {
              const results = [];
              for (const fn of queue) {
                results.push(await fn());
              }
              return results;
            };
          }
          return (...args: any[]) => {
            const client = globalAny._mockRedis;
            const method = client ? (client as any)[prop] : null;
            if (typeof method === 'function') {
              queue.push(() => method.apply(client, args));
            }
            return multiProxy;
          };
        },
      });
      return multiProxy;
    },
    async connect() {
      return this;
    }
  };
}

let cachedClient: any = null;

/**
 * `reconnectStrategy: false` makes a failed connect *reject* rather than retry in the
 * background. Without it node-redis keeps retrying with backoff, so `connect()` never settles:
 * on Vercel that is an invocation billed by duration for a Redis that is already down, and it
 * defeats the whole point of the strict path below — you cannot fail loudly on a promise that
 * never resolves. `connectTimeout` bounds the same hang for a host that accepts the TCP
 * connection and then goes quiet.
 *
 * This also fixes the legacy path, which previously hung instead of falling back to the mock.
 */
const SOCKET_OPTIONS = { connectTimeout: 5000, reconnectStrategy: false as const };

async function connectRealClient(redisUrl: string) {
  if (!cachedClient || cachedClient.isMock) {
    cachedClient = createClient({ url: redisUrl, socket: SOCKET_OPTIONS });
    cachedClient.on('error', (err: any) => console.error('Redis Client Error:', err));
  }
  if (!cachedClient.isOpen) {
    await cachedClient.connect();
  }
  return cachedClient;
}

export async function getRedisClient() {
  if (cachedClient && cachedClient.isOpen) {
    return cachedClient;
  }

  const redisUrl = process.env.REDIS_URL;
  if (redisUrl && redisUrl !== 'redis://localhost:6379') {
    try {
      return await connectRealClient(redisUrl);
    } catch (err) {
      console.warn("Real Redis connection failed, falling back to mock:", err);
      return globalAny._mockRedis;
    }
  }

  // If no REDIS_URL provided or pointing to localhost in Vercel, use mock cleanly
  return globalAny._mockRedis;
}

/** True for the process-local in-memory stand-in, false for a real connection. */
export function isMockRedis(client: any): boolean {
  return client?.isMock === true;
}

/**
 * Thrown instead of handing back the in-memory mock. Carries a machine-readable `code` so a
 * client can tell "the relay is down, back off and retry" apart from "you did something wrong".
 */
export class RedisUnavailableError extends Error {
  readonly statusCode = 503;
  readonly code = 'REDIS_UNAVAILABLE';
  readonly retryable = true;

  constructor(reason: string) {
    super(`Redis is unavailable: ${reason}`);
    this.name = 'RedisUnavailableError';
  }
}

/**
 * Redis for callers that cannot tolerate the mock — currently everything under `/api/group/*`.
 *
 * `getRedisClient()` degrades to a per-instance `Map` when `REDIS_URL` is missing or the
 * connection fails. For rate counters that is a survivable degradation. For Group Ride it is
 * SCOPE §6.1 B2, the audit's highest-severity finding: serverless instances share no memory, so
 * members would land on different instances, each see an empty group, and get **no error at
 * all**. A silent, unreproducible total failure is worse than an outage — an outage at least
 * tells you what happened.
 *
 * So this throws where `getRedisClient()` degrades. Callers surface it as a 503 via
 * `sendRedisError()`; §8 has the client back off with jitter, hold the group in DEGRADED, and
 * keep the user's own ride recording completely unaffected.
 *
 * The `redis://localhost:6379` sentinel is deliberately **not** special-cased here. That
 * heuristic is half of what makes B2 dangerous, and a real local Redis is exactly what group
 * development against a staging relay needs (§6.2 H7). If something is listening, we use it;
 * if nothing is, the connect fails and we say so.
 */
export async function getStrictRedisClient() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new RedisUnavailableError('REDIS_URL is not configured');
  }

  let client: any;
  try {
    client = await connectRealClient(redisUrl);
  } catch (err) {
    console.error('Strict Redis connection failed:', err);
    throw new RedisUnavailableError('connection failed');
  }

  // Belt and braces. `connectRealClient` cannot return the mock today, but the mock is a global
  // singleton shared by every route in the process — if it ever leaked in here, group traffic
  // would read another feature's keys. Cheap assertion, unbounded downside without it.
  if (isMockRedis(client)) {
    throw new RedisUnavailableError('refusing to serve group traffic from the in-memory mock');
  }

  return client;
}

/**
 * Mirrors `sendAuthError` in `lib/auth.ts`. Returns true when it handled the error, so route
 * handlers can chain the two guards before falling through to a 500.
 */
export function sendRedisError(response: any, error: unknown): boolean {
  if (error instanceof RedisUnavailableError) {
    response.setHeader('Retry-After', '5');
    response.status(error.statusCode).json({
      error: 'Group sharing is temporarily unavailable.',
      code: error.code,
      retryable: error.retryable,
    });
    return true;
  }
  return false;
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
