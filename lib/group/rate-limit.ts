/**
 * Fixed-window rate limiting for the join-code path (§5.2).
 *
 * The 6-character code is a convenience, never the security boundary — the 128-bit invite token
 * is. But 32^6 is guessable at volume, so the code path is limited to 5 attempts/min/IP, and
 * the code itself is TTL'd to 30 minutes on top of that.
 */

import crypto from 'crypto';
import type { VercelRequest } from '@vercel/node';
import { getStrictRedisClient } from '../redis';

export const CODE_LOOKUP_LIMIT = Number(process.env.GROUP_CODE_RATE_LIMIT || 5);
export const CODE_LOOKUP_WINDOW_SEC = 60;

/**
 * INCR then EXPIRE is the classic broken counter: if the process dies between them the key
 * never expires and that client is limited forever. One script, one round trip, no window.
 */
const RATE_LIMIT_SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return n
`;

let scriptSha: string | null = null;

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  retryAfterSec: number;
}

/**
 * The caller's IP, hashed and truncated.
 *
 * We are rate limiting, so we need a stable per-client key — but storing raw IPs against a
 * privacy feature is exactly the kind of thing §9's "aggregate counts only" is guarding, and a
 * Redis dump should stay boring. 16 hex characters is ample to separate clients and useless as
 * a record of who tried to join what.
 */
export function clientFingerprint(request: VercelRequest): string {
  const header = request.headers['x-forwarded-for'];
  const raw = Array.isArray(header) ? header[0] : header || '';
  const ip = raw.split(',')[0].trim() || 'unknown';
  return crypto.createHash('sha256').update(ip, 'utf8').digest('hex').slice(0, 16);
}

export async function checkCodeLookupLimit(request: VercelRequest): Promise<RateLimitResult> {
  const redis = await getStrictRedisClient();
  const key = `group:rl:code:${clientFingerprint(request)}`;
  const args: [string[], string[]] = [[key], [String(CODE_LOOKUP_WINDOW_SEC)]];

  let count: number;
  try {
    if (!scriptSha) scriptSha = await redis.scriptLoad(RATE_LIMIT_SCRIPT);
    count = Number(await redis.evalSha(scriptSha, { keys: args[0], arguments: args[1] }));
  } catch (err: any) {
    if (!String(err?.message || err).includes('NOSCRIPT')) throw err;
    scriptSha = null;
    count = Number(await redis.eval(RATE_LIMIT_SCRIPT, { keys: args[0], arguments: args[1] }));
  }

  return {
    allowed: count <= CODE_LOOKUP_LIMIT,
    count,
    retryAfterSec: CODE_LOOKUP_WINDOW_SEC,
  };
}
