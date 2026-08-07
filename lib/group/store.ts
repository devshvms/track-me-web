/**
 * The only Redis-touching code for Group Ride, kept deliberately thin.
 *
 * Decisions live in `model.ts` where they are unit-tested; this file is mechanical. Multi-key
 * mutations run as Lua so they are atomic *and* connection-safe: node-redis shares one
 * connection per instance, so WATCH/MULTI across concurrently-awaited invocations on the same
 * instance can interleave. Lua avoids that class of bug entirely and costs one round trip.
 *
 * ⚠️ The scripts below cannot be exercised without a live Redis and are therefore NOT covered by
 * `npm run test:unit`. §12 Phase 1 requires an integration pass driven by a simulated
 * multi-member client before this ships; that pass is what validates this file.
 */

import { getStrictRedisClient } from '../redis';
import {
  GroupMember,
  GroupRecord,
  groupCodeKey,
  groupKey,
  groupMembersKey,
  groupRevKey,
  groupTokenKey,
} from './model';

// --- EVALSHA plumbing -------------------------------------------------------------------------

const shaCache = new Map<string, string>();

/**
 * EVALSHA with an EVAL fallback. Redis drops its script cache on restart and on SCRIPT FLUSH,
 * and a serverless instance can easily outlive that, so NOSCRIPT is a normal event rather than
 * an error — retrying with the full body reloads it for everyone.
 */
async function runScript(
  name: string,
  script: string,
  keys: string[],
  args: string[],
): Promise<any> {
  const redis = await getStrictRedisClient();
  let sha = shaCache.get(name);

  if (sha) {
    try {
      return await redis.evalSha(sha, { keys, arguments: args });
    } catch (err: any) {
      if (!String(err?.message || err).includes('NOSCRIPT')) throw err;
      shaCache.delete(name);
    }
  }

  const result = await redis.eval(script, { keys, arguments: args });
  try {
    sha = await redis.scriptLoad(script);
    if (sha) shaCache.set(name, sha);
  } catch {
    // Caching the sha is an optimisation, not a requirement; EVAL already ran.
  }
  return result;
}

// --- create -----------------------------------------------------------------------------------

/**
 * Writes all five keys or none. A half-written group — a token key pointing at a record that
 * does not exist — would present to a joiner as a group that resolves and then 404s on join,
 * which is exactly the kind of unreproducible failure §6.1 B2 is about.
 *
 * Returns 1 on success, 0 if the token hash is already taken, 2 if the join code collided.
 * The caller retries a code collision with a fresh code; a token collision means the client
 * reused a token and must not be retried with the same one.
 */
const CREATE_SCRIPT = `
if redis.call('EXISTS', KEYS[4]) == 1 then return 0 end
if redis.call('EXISTS', KEYS[5]) == 1 then return 2 end

redis.call('SET', KEYS[1], ARGV[1])
redis.call('PEXPIREAT', KEYS[1], ARGV[4])

redis.call('HSET', KEYS[2], ARGV[2], ARGV[3])
redis.call('PEXPIREAT', KEYS[2], ARGV[4])

redis.call('SET', KEYS[3], '1')
redis.call('PEXPIREAT', KEYS[3], ARGV[4])

redis.call('SET', KEYS[4], ARGV[6])
redis.call('PEXPIREAT', KEYS[4], ARGV[4])

redis.call('SET', KEYS[5], ARGV[6])
redis.call('PEXPIREAT', KEYS[5], ARGV[5])

return 1
`;

export type CreateOutcome = 'CREATED' | 'TOKEN_TAKEN' | 'CODE_TAKEN';

export async function createGroup(
  record: GroupRecord,
  owner: GroupMember,
  codeExpiresAtMs: number,
): Promise<CreateOutcome> {
  const result = await runScript(
    'group:create',
    CREATE_SCRIPT,
    [
      groupKey(record.groupId),
      groupMembersKey(record.groupId),
      groupRevKey(record.groupId),
      groupTokenKey(record.tokenHash),
      groupCodeKey(record.joinCode),
    ],
    [
      JSON.stringify(record),
      record.ownerUid,
      JSON.stringify(owner),
      String(record.expiresAt),
      String(codeExpiresAtMs),
      record.groupId,
    ],
  );

  if (result === 0) return 'TOKEN_TAKEN';
  if (result === 2) return 'CODE_TAKEN';
  return 'CREATED';
}

// --- join -------------------------------------------------------------------------------------

/**
 * Capacity check and membership write in one atomic step.
 *
 * Splitting these is not a rounding error. Two members joining a 4-of-5 group simultaneously
 * would both read 4, both write, and one write would be lost — leaving a member who believes
 * they joined but 403s on every sync, with nothing to explain it. The over-capacity case is the
 * benign half of that race; the lost update is the one that matters.
 *
 * The EXISTS check on KEYS[1] closes the window where the group ends between the caller's read
 * and this write, which would otherwise leave an orphaned `group:*` key alive past the end and
 * break §10's "no key matching group:* remains".
 *
 * Returns { code, memberCount, rev } — code 0 joined, 1 rejoined, 2 full, 3 group gone.
 */
const JOIN_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return { 3, 0, 0 }
end

local already = redis.call('HEXISTS', KEYS[2], ARGV[1])
if already == 0 then
  local count = redis.call('HLEN', KEYS[2])
  if count >= tonumber(ARGV[3]) then
    return { 2, count, tonumber(redis.call('GET', KEYS[3]) or '0') }
  end
end

redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
redis.call('PEXPIREAT', KEYS[2], ARGV[4])

local rev = redis.call('INCR', KEYS[3])
redis.call('PEXPIREAT', KEYS[3], ARGV[4])

local joined = 0
if already == 1 then joined = 1 end
return { joined, redis.call('HLEN', KEYS[2]), rev }
`;

export interface JoinResult {
  outcome: 'JOINED' | 'REJOINED' | 'FULL' | 'GONE';
  memberCount: number;
  rev: number;
}

export async function joinGroup(
  groupId: string,
  uid: string,
  member: GroupMember,
  maxMembers: number,
  expiresAtMs: number,
): Promise<JoinResult> {
  const [code, memberCount, rev] = (await runScript(
    'group:join',
    JOIN_SCRIPT,
    [groupKey(groupId), groupMembersKey(groupId), groupRevKey(groupId)],
    [uid, JSON.stringify(member), String(maxMembers), String(expiresAtMs)],
  )) as [number, number, number];

  const outcome =
    code === 0 ? 'JOINED' : code === 1 ? 'REJOINED' : code === 2 ? 'FULL' : 'GONE';
  return { outcome, memberCount: Number(memberCount), rev: Number(rev) };
}

// --- reads ------------------------------------------------------------------------------------

export async function readGroup(groupId: string): Promise<GroupRecord | null> {
  const redis = await getStrictRedisClient();
  const raw = await redis.get(groupKey(groupId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as GroupRecord;
  } catch {
    // A record we cannot parse is indistinguishable from a missing one to every caller, and
    // pretending otherwise would turn corruption into a 500 on the hot path.
    console.error('Unparseable group record', { groupId });
    return null;
  }
}

export async function resolveGroupIdByToken(tokenHash: string): Promise<string | null> {
  const redis = await getStrictRedisClient();
  return redis.get(groupTokenKey(tokenHash));
}

export async function resolveGroupIdByCode(joinCode: string): Promise<string | null> {
  const redis = await getStrictRedisClient();
  return redis.get(groupCodeKey(joinCode));
}

export async function readMemberCount(groupId: string): Promise<number> {
  const redis = await getStrictRedisClient();
  return redis.hLen(groupMembersKey(groupId));
}

export async function isMember(groupId: string, uid: string): Promise<boolean> {
  const redis = await getStrictRedisClient();
  return (await redis.hExists(groupMembersKey(groupId), uid)) === true;
}

export async function readRev(groupId: string): Promise<number> {
  const redis = await getStrictRedisClient();
  return Number((await redis.get(groupRevKey(groupId))) || 0);
}
