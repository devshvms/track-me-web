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
  allGroupKeys,
  groupCodeKey,
  groupKey,
  groupMembersKey,
  groupPosKey,
  groupRevKey,
  groupTokenKey,
} from './model';

// --- EVALSHA plumbing -------------------------------------------------------------------------

const shaCache = new Map<string, string>();

/**
 * A script plus its declared arity.
 *
 * The arity is not decoration. These scripts have no runtime coverage in this environment, and
 * the failure mode of a mismatch is silent: Lua reads an out-of-range `ARGV[n]` as `nil`, so a
 * renumbering slip turns into `tonumber(nil)` comparisons that quietly never fire rather than an
 * error anyone would notice. `runScript` checks the arity on every call, and
 * `tests/group-store-scripts.test.ts` checks it against the highest index the body actually
 * references — which is the one property of this file that *can* be verified without a Redis.
 */
interface GroupScript {
  name: string;
  body: string;
  keys: number;
  args: number;
}

export function assertScriptArity(script: GroupScript, keys: string[], args: string[]): void {
  if (keys.length !== script.keys || args.length !== script.args) {
    throw new Error(
      `${script.name}: declared ${script.keys} keys/${script.args} args, `
      + `called with ${keys.length}/${args.length}`,
    );
  }
}

/**
 * EVALSHA with an EVAL fallback. Redis drops its script cache on restart and on SCRIPT FLUSH,
 * and a serverless instance can easily outlive that, so NOSCRIPT is a normal event rather than
 * an error — retrying with the full body reloads it for everyone.
 */
async function runScript(
  descriptor: GroupScript,
  keys: string[],
  args: string[],
): Promise<any> {
  assertScriptArity(descriptor, keys, args);
  const { name, body: script } = descriptor;
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
const CREATE_SCRIPT_BODY = `
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

redis.call('SET', KEYS[5], ARGV[7])
redis.call('PEXPIREAT', KEYS[5], ARGV[5])

return 1
`;

export const CREATE_SCRIPT: GroupScript = {
  name: 'group:create', body: CREATE_SCRIPT_BODY, keys: 5, args: 7,
};

export type CreateOutcome = 'CREATED' | 'TOKEN_TAKEN' | 'CODE_TAKEN';

export async function createGroup(
  record: GroupRecord,
  owner: GroupMember,
  codeExpiresAtMs: number,
  wrappedToken: string,
): Promise<CreateOutcome> {
  const result = await runScript(
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
      // The code key holds the groupId *and* the token wrapped under the code, so a joiner who
      // only typed a code can recover the group key. The relay cannot: it has neither the code
      // nor the token, only this ciphertext.
      JSON.stringify({ groupId: record.groupId, wrappedToken } satisfies CodeEntry),
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
const JOIN_SCRIPT_BODY = `
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

export const JOIN_SCRIPT: GroupScript = {
  name: 'group:join', body: JOIN_SCRIPT_BODY, keys: 3, args: 4,
};

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
    JOIN_SCRIPT,
    [groupKey(groupId), groupMembersKey(groupId), groupRevKey(groupId)],
    [uid, JSON.stringify(member), String(maxMembers), String(expiresAtMs)],
  )) as [number, number, number];

  const outcome =
    code === 0 ? 'JOINED' : code === 1 ? 'REJOINED' : code === 2 ? 'FULL' : 'GONE';
  return { outcome, memberCount: Number(memberCount), rev: Number(rev) };
}

// --- sync -------------------------------------------------------------------------------------

/**
 * The hot path, as one `EVALSHA`.
 *
 * §4.5: a naïve sync is `GET meta` + `HSET pos` + `HGETALL pos` = 3 commands, and managed Redis
 * bills per command, so this is a 3× cut in the dominant Redis cost line (§7.2). It also does
 * work three round trips could not: the read is atomic with respect to the write, so no member
 * ever sees a half-updated group.
 *
 * In order: existence, authorisation, write-rate floor, own position write, ghost sweep, read,
 * revision, conditional roster.
 *
 * **Authorisation, not just crypto.** §5.2's "departed member keeps polling" — they still hold
 * the derived key, so the API is the enforcement point. `HEXISTS` on the members hash is that
 * enforcement, and it runs before anything is read.
 *
 * **The sweep.** §2.6: after ten minutes a member drops off the map but stays in the roster.
 * Doing it here rather than client-side means the response stays small and Redis never
 * accumulates ghosts — and it costs nothing, since the read has to walk the hash anyway.
 *
 * Returns { code, rev, recordJson, positionsFlat, rosterFlat }:
 *   0 ok · 1 not a member · 2 group gone · 3 writing too fast
 */
const SYNC_SCRIPT_BODY = `
-- KEYS 1..4 = group:{id} · :members · :rev · :pos
-- ARGV      = uid, positionField(''=skip), nowMs, ghostCutoffMs, clientRev, minWriteIntervalMs
local record = redis.call('GET', KEYS[1])
if not record then
  return { 2, 0, '', {}, {} }
end

if redis.call('HEXISTS', KEYS[2], ARGV[1]) == 0 then
  return { 1, 0, '', {}, {} }
end

local now = tonumber(ARGV[3])

if ARGV[2] ~= '' then
  local existing = redis.call('HGET', KEYS[4], ARGV[1])
  if existing then
    local prevTs = tonumber(string.match(existing, '^(%d+)%.'))
    if prevTs and (now - prevTs) < tonumber(ARGV[6]) then
      return { 3, 0, '', {}, {} }
    end
  end
  redis.call('HSET', KEYS[4], ARGV[1], ARGV[2])
  -- Derive the position key's lifetime from what the group key has left, rather than taking an
  -- absolute expiry as an argument: the caller cannot know it before this script has read the
  -- record, and passing a placeholder would expire the key on the spot.
  local ttl = redis.call('PTTL', KEYS[1])
  if ttl > 0 then
    redis.call('PEXPIRE', KEYS[4], ttl)
  end
end

local cutoff = tonumber(ARGV[4])
local raw = redis.call('HGETALL', KEYS[4])
local fresh = {}
local stale = {}
for i = 1, #raw, 2 do
  local ts = tonumber(string.match(raw[i + 1], '^(%d+)%.'))
  if ts and ts >= cutoff then
    fresh[#fresh + 1] = raw[i]
    fresh[#fresh + 1] = raw[i + 1]
  else
    stale[#stale + 1] = raw[i]
  end
end
if #stale > 0 then
  redis.call('HDEL', KEYS[4], unpack(stale))
end

local rev = tonumber(redis.call('GET', KEYS[3]) or '0')

local roster = {}
if tonumber(ARGV[5]) ~= rev then
  roster = redis.call('HGETALL', KEYS[2])
end

return { 0, rev, record, fresh, roster }
`;

export const SYNC_SCRIPT: GroupScript = {
  name: 'group:sync', body: SYNC_SCRIPT_BODY, keys: 4, args: 6,
};

export interface SyncOutcome {
  code: 'OK' | 'NOT_A_MEMBER' | 'GONE' | 'TOO_FAST';
  rev: number;
  record: GroupRecord | null;
  /** Raw `"<ts>.<envelope>"` values, keyed by uid. Decoded by the caller. */
  positions: Record<string, string>;
  /** Present only when the caller's `rev` was stale. */
  roster: Record<string, GroupMember> | null;
}

export async function syncGroup(input: {
  groupId: string;
  uid: string;
  /** Empty string when the member is in the group but not sharing (§8, permission revoked). */
  positionField: string;
  nowMs: number;
  ghostCutoffMs: number;
  clientRev: number;
  minWriteIntervalMs: number;
}): Promise<SyncOutcome> {
  const raw = (await runScript(
    SYNC_SCRIPT,
    [
      groupKey(input.groupId),
      groupMembersKey(input.groupId),
      groupRevKey(input.groupId),
      groupPosKey(input.groupId),
    ],
    [
      input.uid,
      input.positionField,
      String(input.nowMs),
      String(input.ghostCutoffMs),
      String(input.clientRev),
      String(input.minWriteIntervalMs),
    ],
  )) as [number, number, string, string[], string[]];

  const [code, rev, recordJson, positionsFlat, rosterFlat] = raw;
  const outcome: SyncOutcome['code'] =
    code === 0 ? 'OK' : code === 1 ? 'NOT_A_MEMBER' : code === 2 ? 'GONE' : 'TOO_FAST';

  return {
    code: outcome,
    rev: Number(rev),
    record: parseRecord(recordJson, input.groupId),
    positions: flatToObject(positionsFlat),
    roster: rosterFlat.length > 0 ? parseRoster(rosterFlat) : null,
  };
}

function flatToObject(flat: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < flat.length; i += 2) out[flat[i]] = flat[i + 1];
  return out;
}

function parseRoster(flat: string[]): Record<string, GroupMember> {
  const out: Record<string, GroupMember> = {};
  for (let i = 0; i + 1 < flat.length; i += 2) {
    try {
      out[flat[i]] = JSON.parse(flat[i + 1]) as GroupMember;
    } catch {
      // One unreadable member must not take down everyone else's roster — §8's
      // "skip that member, log, don't crash the map", applied one layer earlier.
      console.error('Unparseable member record', { uid: flat[i] });
    }
  }
  return out;
}

function parseRecord(raw: string, groupId: string): GroupRecord | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as GroupRecord;
  } catch {
    console.error('Unparseable group record', { groupId });
    return null;
  }
}

// --- state ------------------------------------------------------------------------------------

/**
 * Compare-and-swap on the record, so a state change cannot lose to a concurrent write.
 *
 * The comparison is against the **raw string Redis returned**, not a re-serialised object.
 * `JSON.stringify(JSON.parse(x)) === x` happens to hold for records we wrote, but relying on it
 * would make every state change fail the day a field is reordered — a total feature failure with
 * a very indirect cause.
 *
 * `SET` clears a key's TTL. Re-applying the remaining `PTTL` is what stops "Start group" quietly
 * turning a 4-hour session into an immortal one, which would break §5.1.2 — the invariant that
 * every group expires — in the least visible way possible.
 *
 * Returns 1 swapped, 0 group gone, 2 changed underneath us.
 */
const STATE_SCRIPT_BODY = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
if current ~= ARGV[1] then return 2 end

local ttl = redis.call('PTTL', KEYS[1])
redis.call('SET', KEYS[1], ARGV[2])
if ttl > 0 then
  redis.call('PEXPIRE', KEYS[1], ttl)
end
return 1
`;

export const STATE_SCRIPT: GroupScript = {
  name: 'group:state', body: STATE_SCRIPT_BODY, keys: 1, args: 2,
};

export type StateSwapOutcome = 'SWAPPED' | 'GONE' | 'CONFLICT';

export async function swapGroupState(
  groupId: string,
  expectedRaw: string,
  next: GroupRecord,
): Promise<StateSwapOutcome> {
  const result = await runScript(
    STATE_SCRIPT,
    [groupKey(groupId)],
    [expectedRaw, JSON.stringify(next)],
  );
  if (result === 0) return 'GONE';
  if (result === 2) return 'CONFLICT';
  return 'SWAPPED';
}

/**
 * §2.7 and §5.1.5: ending a group deletes every server-side key for it, immediately.
 *
 * One `DEL` over `allGroupKeys()`, which is unit-tested to cover everything the store writes —
 * so §10's "after a group ends, no key matching `group:*` remains" is verified by construction
 * rather than by remembering to add each new key here.
 */
export async function endGroup(record: GroupRecord): Promise<number> {
  const redis = await getStrictRedisClient();
  return redis.del(allGroupKeys(record.groupId, record.tokenHash, record.joinCode));
}

// --- leave ------------------------------------------------------------------------------------

/**
 * §5.1.3, the single most important line in the spec: *the exit is sacred and silent.*
 *
 * This removes the caller and **emits nothing to anyone**. There is no notification, no event,
 * no "X left the group" — a person who needs to go dark must be able to, without escalation.
 * Any future change that adds a broadcast here for engagement reasons is a safety regression,
 * not a feature.
 *
 * When the last member leaves, the whole group is deleted in the same script rather than left
 * to the TTL: an empty group is not a group, and nothing should outlive it (§5.1.5).
 *
 * Returns { code, remaining, rev } — code 0 left, 1 not a member, 2 group gone.
 */
const LEAVE_SCRIPT_BODY = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return { 2, 0, 0 }
end
if redis.call('HEXISTS', KEYS[2], ARGV[1]) == 0 then
  return { 1, 0, 0 }
end

redis.call('HDEL', KEYS[2], ARGV[1])
redis.call('HDEL', KEYS[4], ARGV[1])

local remaining = redis.call('HLEN', KEYS[2])
if remaining == 0 then
  redis.call('DEL', KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5], KEYS[6])
  return { 0, 0, 0 }
end

local rev = redis.call('INCR', KEYS[3])
-- INCR preserves an existing TTL, and the rev key is always created with one -- but if it ever
-- expired ahead of the group, INCR would recreate it unbounded and leave a group: key behind
-- forever, breaking the "nothing outlives the session" invariant in the least visible way there
-- is. Re-derive it from the group key. (No backticks in Lua comments: these bodies are TS
-- template literals, and a backtick ends the string.)
local ttl = redis.call('PTTL', KEYS[1])
if ttl > 0 then
  redis.call('PEXPIRE', KEYS[3], ttl)
end
return { 0, remaining, rev }
`;

export const LEAVE_SCRIPT: GroupScript = {
  name: 'group:leave', body: LEAVE_SCRIPT_BODY, keys: 6, args: 1,
};

export interface LeaveResult {
  outcome: 'LEFT' | 'NOT_A_MEMBER' | 'GONE';
  remaining: number;
  rev: number;
}

export async function leaveGroup(record: GroupRecord, uid: string): Promise<LeaveResult> {
  const [code, remaining, rev] = (await runScript(
    LEAVE_SCRIPT,
    allGroupKeys(record.groupId, record.tokenHash, record.joinCode),
    [uid],
  )) as [number, number, number];

  const outcome = code === 0 ? 'LEFT' : code === 1 ? 'NOT_A_MEMBER' : 'GONE';
  return { outcome, remaining: Number(remaining), rev: Number(rev) };
}

// --- remove (leader only) ---------------------------------------------------------------------

/**
 * Removes one member, at the leader's request.
 *
 * Not in the scope, and worth being explicit about why it is safe to add. §5.1 governs *visibility*
 * symmetry — no watching without being watched — and removal does not touch that: a removed member
 * loses access entirely rather than becoming invisible while still seeing others. §5.2 already
 * makes the API the enforcement point (*"every sync checks the caller's uid against the plaintext
 * members set. Removed uid → 403"*), so this is that path, driven deliberately.
 *
 * It also closes a real gap. §5.2's threat model includes a brute-forced or leaked join code; until
 * now the leader's only answer to a stranger in the group was to end it for everybody. Removing one
 * person is the proportionate tool.
 *
 * The removed member learns immediately — their next sync 403s and the client shows "You're no
 * longer in this group." That matters: silent removal would be its own kind of dishonesty.
 *
 * Reuses LEAVE_SCRIPT: removing someone is exactly leaving, performed by another authenticated
 * caller. Same atomicity, same last-member-deletes-the-group behaviour, no second script to drift.
 */
export async function removeMember(record: GroupRecord, uid: string): Promise<LeaveResult> {
  return leaveGroup(record, uid);
}

// --- reads ------------------------------------------------------------------------------------

/** The record plus the exact bytes Redis held, for the compare-and-swap above. */
export async function readGroupRaw(
  groupId: string,
): Promise<{ raw: string; record: GroupRecord } | null> {
  const redis = await getStrictRedisClient();
  const raw = await redis.get(groupKey(groupId));
  if (!raw) return null;
  const record = parseRecord(raw, groupId);
  return record ? { raw, record } : null;
}

export async function readGroup(groupId: string): Promise<GroupRecord | null> {
  const redis = await getStrictRedisClient();
  // A record we cannot parse is indistinguishable from a missing one to every caller, and
  // pretending otherwise would turn corruption into a 500 on the hot path.
  return parseRecord((await redis.get(groupKey(groupId))) || '', groupId);
}

export async function resolveGroupIdByToken(tokenHash: string): Promise<string | null> {
  const redis = await getStrictRedisClient();
  return redis.get(groupTokenKey(tokenHash));
}

/** Value stored at `group:code:{joinCode}`. */
export interface CodeEntry {
  groupId: string;
  wrappedToken: string;
}

export async function resolveCodeEntry(joinCode: string): Promise<CodeEntry | null> {
  const redis = await getStrictRedisClient();
  const raw = await redis.get(groupCodeKey(joinCode));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CodeEntry;
    return parsed?.groupId && parsed?.wrappedToken ? parsed : null;
  } catch {
    console.error('Unparseable group code entry');
    return null;
  }
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

/** Every Lua script in this file, so the arity guard can walk them all. */
export const ALL_GROUP_SCRIPTS: readonly GroupScript[] = [
  CREATE_SCRIPT,
  JOIN_SCRIPT,
  SYNC_SCRIPT,
  STATE_SCRIPT,
  LEAVE_SCRIPT,
];
