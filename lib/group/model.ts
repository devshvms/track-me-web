/**
 * Group Ride — key schema, limits, and the pure decisions the routes are built from.
 *
 * Everything here is side-effect free and unit-tested. The Redis-touching code in
 * `lib/group/store.ts` is deliberately thin so that what cannot be tested without a live Redis
 * stays as small and as obvious as possible.
 *
 * Spec: SCOPE_1.7.0 §4.4 (data model), §4.5 (contract), §5 (invariants), §11 (limits).
 */

import crypto from 'crypto';
import { JOIN_CODE_PATTERN } from './crypto';

// --- Keys -------------------------------------------------------------------------------------
//
// §4.4 sketches four keys per group. This is six, and the extra two are deliberate:
//
//   - `:members` as its own HASH means a join or a leave mutates one field instead of rewriting
//     a growing JSON blob, and it lets the capacity check be a single HLEN.
//   - `:rev` as its own counter makes the roster revision an atomic INCR, which removes the
//     read-modify-write race §4.5 flags on the sync path — for free, everywhere, not just in
//     one Lua script.
//
// The invariants §4.4 actually protects are untouched: every key carries the session TTL,
// positions are overwritten rather than appended, and ending the group deletes all of them in
// one DEL so §10's "no key matching group:* remains" still holds.

export const groupKey = (groupId: string) => `group:${groupId}`;
export const groupMembersKey = (groupId: string) => `group:${groupId}:members`;
export const groupRevKey = (groupId: string) => `group:${groupId}:rev`;
export const groupPosKey = (groupId: string) => `group:${groupId}:pos`;
export const groupTokenKey = (tokenHash: string) => `group:tok:${tokenHash}`;
export const groupCodeKey = (joinCode: string) => `group:code:${joinCode}`;

/** Every key belonging to one group. The argument to DEL when a group ends (§2.7, §10). */
export function allGroupKeys(groupId: string, tokenHash: string, joinCode: string): string[] {
  return [
    groupKey(groupId),
    groupMembersKey(groupId),
    groupRevKey(groupId),
    groupPosKey(groupId),
    groupTokenKey(tokenHash),
    groupCodeKey(joinCode),
  ];
}

// --- Limits -----------------------------------------------------------------------------------
//
// §11 requires these to be server-enforced and config-read, so raising them for a paid user in
// ~1.9 is a claim check rather than a migration. Defaults are D4's free tier: 5 people, 4 hours.

export const FREE_MAX_MEMBERS = Number(process.env.GROUP_MAX_MEMBERS || 5);
export const FREE_MAX_DURATION_MINUTES = Number(process.env.GROUP_MAX_DURATION_MINUTES || 240);
export const DEFAULT_DURATION_MINUTES = 240;
export const DEFAULT_SYNC_INTERVAL_SEC = Number(process.env.GROUP_SYNC_INTERVAL_SEC || 10);

/** A group of one has nobody to be co-present with (§8, "Nobody joins by start time"). */
export const MIN_MAX_MEMBERS = 2;

/** §4.4: the join code is the short-lived manual path, not the credential. */
export const JOIN_CODE_TTL_SECONDS = 30 * 60;

/**
 * Structural caps on the opaque envelopes. The server cannot validate their *contents* — it has
 * no key (§5.3) — but it can refuse something that is not shaped like an envelope at all, which
 * is a cheap guard against a client filling Redis with garbage. This is a DoS bound, and it must
 * never be described as validation.
 */
export const MAX_META_ENVELOPE_CHARS = 2048;
export const MAX_ROSTER_ENVELOPE_CHARS = 1024;
export const MAX_POSITION_ENVELOPE_CHARS = 512;

/** A wrapped invite token is 22 chars sealed: `v1.` + 16 + `.` + 51 ≈ 71. 128 is ample headroom. */
export const MAX_WRAPPED_TOKEN_CHARS = 128;

// --- Types ------------------------------------------------------------------------------------

export type GroupState = 'PREPARING' | 'LIVE' | 'ENDED';

/**
 * D5: the member record carries `role` from day one with `PARTICIPANT` as the only valid value,
 * so introducing `WATCHER` later is not a migration. Nothing in 1.7.x may branch on it — a
 * second value would be asymmetric visibility, which §5.1 puts out of the flagship surface.
 */
export type MemberRole = 'PARTICIPANT';

export interface GroupMember {
  role: MemberRole;
  joinedAt: number;
  /** `v1:roster:{uid}` envelope — displayName, initials, photoUrl. Opaque here. */
  roster: string;
}

/** The `group:{groupId}` value. Plaintext control fields the server needs to enforce rules. */
export interface GroupRecord {
  v: 1;
  groupId: string;
  ownerUid: string;
  state: GroupState;
  createdAt: number;
  expiresAt: number;
  maxMembers: number;
  syncIntervalSec: number;
  tokenHash: string;
  joinCode: string;
  /** `v1:meta` envelope — group name, owner display name. Opaque here. */
  meta: string;
}

/** §4.5: deliberately thin, so an enumerated token or a guessed code leaks nothing. */
export interface GroupPublicView {
  groupId: string;
  state: GroupState;
  memberCount: number;
  maxMembers: number;
  expiresAt: number;
}

// --- Validation -------------------------------------------------------------------------------

const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/;
const GROUP_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENVELOPE_PATTERN = /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}$/;

export const isValidTokenHash = (v: unknown): v is string =>
  typeof v === 'string' && TOKEN_HASH_PATTERN.test(v);

export const isValidGroupId = (v: unknown): v is string =>
  typeof v === 'string' && GROUP_ID_PATTERN.test(v);

/**
 * Shape only — `v1.<12-byte nonce>.<at least a tag>`. A pass here says nothing about whether the
 * envelope decrypts; only a client holding the token can know that.
 */
export function isValidEnvelope(v: unknown, maxChars: number): v is string {
  return typeof v === 'string' && v.length <= maxChars && ENVELOPE_PATTERN.test(v);
}

// --- Join codes -------------------------------------------------------------------------------
//
// Generation and normalisation live in `crypto.ts`, not here: under the wrapped-token design the
// join code is key material, and anything that decides the bytes fed to HKDF belongs in the file
// the other platforms port and the shared fixture pins. Re-exported so callers have one import.

export {
  CROCKFORD_ALPHABET,
  JOIN_CODE_LENGTH,
  generateJoinCode,
  normalizeJoinCode,
} from './crypto';

/** True only for an already-normalised code. Use `normalizeJoinCode` on anything user-typed. */
export function isValidJoinCode(v: unknown): v is string {
  return typeof v === 'string' && JOIN_CODE_PATTERN.test(v);
}

// --- Duration and size ------------------------------------------------------------------------

export interface LimitResult<T> {
  ok: boolean;
  value: T;
  /** Set when `ok` is false. Safe to show a user — states the cap rather than hiding it (§11.2). */
  error?: string;
}

/**
 * Missing or unparseable falls back to the default, matching `api/track/start.ts`. Over the cap
 * is a 400 that names the cap: §11 wants the limits stated positively, and a request silently
 * clamped from 8h to 4h would show the user a countdown they did not ask for.
 */
export function resolveDurationMinutes(raw: unknown): LimitResult<number> {
  const parsed = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { ok: true, value: DEFAULT_DURATION_MINUTES };
  }
  if (parsed > FREE_MAX_DURATION_MINUTES) {
    return {
      ok: false,
      value: FREE_MAX_DURATION_MINUTES,
      error: `Groups can run for up to ${FREE_MAX_DURATION_MINUTES / 60} hours.`,
    };
  }
  return { ok: true, value: Math.floor(parsed) };
}

export function resolveMaxMembers(raw: unknown): LimitResult<number> {
  const parsed = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { ok: true, value: FREE_MAX_MEMBERS };
  }
  if (parsed > FREE_MAX_MEMBERS) {
    return {
      ok: false,
      value: FREE_MAX_MEMBERS,
      error: `Groups can hold up to ${FREE_MAX_MEMBERS} people.`,
    };
  }
  if (parsed < MIN_MAX_MEMBERS) {
    return {
      ok: false,
      value: MIN_MAX_MEMBERS,
      error: `A group needs room for at least ${MIN_MAX_MEMBERS} people.`,
    };
  }
  return { ok: true, value: Math.floor(parsed) };
}

// --- Position field encoding --------------------------------------------------------------------

/**
 * A position hash field is `"<serverMillis>.<envelope>"`.
 *
 * §4.4 requires the timestamp to sit **outside** the envelope so the server can compute
 * staleness and sweep ghosts without decrypting, and so a client with a skewed clock cannot
 * poison freshness for the whole group (§8). A parallel hash field would work too; one field
 * halves the writes and keeps the sweep to a single scan.
 *
 * Splitting on the *first* dot is safe: the timestamp is digits, and the envelope always begins
 * `v1.`, so the boundary is unambiguous.
 */
export function encodePositionField(serverMillis: number, envelope: string): string {
  return `${serverMillis}.${envelope}`;
}

export interface DecodedPosition {
  ts: number;
  e: string;
}

export function decodePositionField(value: unknown): DecodedPosition | null {
  if (typeof value !== 'string') return null;
  const dot = value.indexOf('.');
  if (dot <= 0) return null;
  const ts = Number(value.slice(0, dot));
  if (!Number.isFinite(ts) || !Number.isInteger(ts) || ts <= 0) return null;
  const e = value.slice(dot + 1);
  return isValidEnvelope(e, MAX_POSITION_ENVELOPE_CHARS) ? { ts, e } : null;
}

// --- Join eligibility -------------------------------------------------------------------------

/**
 * A pure decision type, following the convention the codebase already uses for exactly this kind
 * of branchy rule (`LocationStartDecision`, `RideSplitPolicy`, `AutoPausePreference`). §2.9 calls
 * this out as the thing that stops policy logic rotting: it is testable to completion without a
 * Redis, a network, or a UI.
 */
export type JoinRejection =
  | 'NOT_FOUND'
  | 'ENDED'
  | 'EXPIRED'
  | 'FULL'
  | 'BAD_TOKEN';

export interface JoinDecision {
  allowed: boolean;
  /** True when the caller is already in `members` — a rejoin, not a new seat. */
  rejoin: boolean;
  reason?: JoinRejection;
}

export function decideJoin(input: {
  record: GroupRecord | null;
  tokenHash: string;
  uid: string;
  isExistingMember: boolean;
  memberCount: number;
  nowMs: number;
}): JoinDecision {
  const { record, tokenHash, uid, isExistingMember, memberCount, nowMs } = input;

  if (!record) return { allowed: false, rejoin: false, reason: 'NOT_FOUND' };

  // Constant-time comparison: the token hash is the proof of invitation, and a timing oracle on
  // it would undo the point of using a hash at all.
  if (!safeEqual(record.tokenHash, tokenHash)) {
    return { allowed: false, rejoin: false, reason: 'BAD_TOKEN' };
  }

  if (record.state === 'ENDED') return { allowed: false, rejoin: false, reason: 'ENDED' };
  if (record.expiresAt <= nowMs) return { allowed: false, rejoin: false, reason: 'EXPIRED' };

  // §8: "The capacity check must exempt a uid already in members. A user must never be locked
  // out of their own group by the cap." This is the crash-recovery path — the member whose app
  // was killed is the one most likely to hit a full group.
  if (isExistingMember) return { allowed: true, rejoin: true };

  if (memberCount >= record.maxMembers) {
    return { allowed: false, rejoin: false, reason: 'FULL' };
  }

  // Deliberately absent: a check for state === 'LIVE'. §8 makes latecomers the common case, not
  // an error, and the owner is never a special case here — they join their own group at create.
  void uid;
  return { allowed: true, rejoin: false };
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// --- Views ------------------------------------------------------------------------------------

export function toPublicView(record: GroupRecord, memberCount: number): GroupPublicView {
  return {
    groupId: record.groupId,
    state: record.state,
    memberCount,
    maxMembers: record.maxMembers,
    expiresAt: record.expiresAt,
  };
}

/**
 * Guards against a field being added to `GroupRecord` and silently reaching an unauthenticated
 * caller. §4.5 fixes this list; the test asserts the response has exactly these keys.
 */
export const PUBLIC_VIEW_FIELDS = [
  'groupId',
  'state',
  'memberCount',
  'maxMembers',
  'expiresAt',
] as const;

export function newGroupId(): string {
  return crypto.randomUUID();
}
