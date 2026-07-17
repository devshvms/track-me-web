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
      // Mock always returns -1 (no expiry) since we don't track TTLs in memory
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
      console.warn("Real Redis connection failed, falling back to mock:", err);
      return globalAny._mockRedis;
    }
  }

  // If no REDIS_URL provided or pointing to localhost in Vercel, use mock cleanly
  return globalAny._mockRedis;
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
