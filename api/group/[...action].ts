import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireUser, sendAuthError } from '../../lib/auth';
import { sendRedisError } from '../../lib/redis';
import { captureTelemetryEvent } from '../../lib/posthog';
import { checkCodeLookupLimit, checkJoinAttemptLimit } from '../../lib/group/rate-limit';
import {
  GHOST_TTL_MS,
  MIN_WRITE_INTERVAL_MS,
  nextSyncIntervalSec,
} from '../../lib/group/cadence';
import {
  DEFAULT_SYNC_INTERVAL_SEC,
  GroupMember,
  GroupRecord,
  GroupState,
  JOIN_CODE_TTL_SECONDS,
  MAX_META_ENVELOPE_CHARS,
  MAX_POSITION_ENVELOPE_CHARS,
  MAX_ROSTER_ENVELOPE_CHARS,
  MAX_WRAPPED_TOKEN_CHARS,
  decideJoin,
  decodePositionField,
  encodePositionField,
  isValidEnvelope,
  isValidGroupId,
  isValidTokenHash,
  newGroupId,
  normalizeJoinCode,
  resolveDurationMinutes,
  resolveMaxMembers,
  toPublicView,
} from '../../lib/group/model';
import {
  createGroup,
  isMember,
  joinGroup,
  readGroup,
  readMemberCount,
  endGroup,
  leaveGroup,
  removeMember,
  readGroupRaw,
  resolveCodeEntry,
  resolveGroupIdByToken,
  swapGroupState,
  syncGroup,
} from '../../lib/group/store';

/**
 * Every Group Ride route, as one catch-all function.
 *
 * §4.5 says `api/` holds 10 functions. It held 11, so this file is #12 — **exactly the Hobby
 * cap**, confirmed by the 2026-08-08 architecture audit. Shipping six routes as six files would
 * have blown it outright, and would have duplicated auth, membership and TTL logic six ways.
 * Same shape as `api/export/[...action].ts`.
 *
 * `sync`, `state` and `leave` land in this same file and add no functions, so Group Ride is
 * complete within the cap. But there is now **zero headroom**: the next new endpoint anywhere in
 * the project needs `api/admin/*.ts` collapsed into `api/admin/[...action].ts` first, which
 * frees three slots.
 */

// All six routes are live: create, resolve, join, sync, state, leave.

/**
 * Join-by-code and E2E encryption, reconciled (architecture decision, 2026-08-08).
 *
 * §2.4 makes the 6-character code the guaranteed join path and §15.1 defers join-by-link to
 * 1.7.1, so in 1.7.x the code is the only path a customer has — but §5.3 derives the group key
 * from the invite *token*, which a code-joiner never sees. Left alone, a code-joiner would be
 * authorised by the relay and able to decrypt nothing.
 *
 * Resolution: the creating client mints the code as well as the token, and stores the token
 * sealed under a key derived from the code. The relay holds ciphertext for which it has neither
 * input. `resolve?c=` hands that wrapper back; only someone who knows the code can open it.
 *
 * The honest consequence: **the join code is now a security boundary**, which §5.2 currently
 * denies and needs updating for. 30 bits is weak in the abstract. What makes it acceptable is
 * that there is no offline attack — a wrapper cannot be obtained without already knowing its
 * code — so the only route is `resolve?c=`, which is rate-limited to 5/min per client and stops
 * working when the code expires after 30 minutes.
 */

const GONE_MESSAGE = 'This invite has expired.';

/**
 * §8: "Never 'wrong code' — don't leak whether the group exists." Every miss, expiry, ended
 * group, bad token and rate-limit rejection resolves to the same 404 body. The rate limit is
 * the only one that also sets a header, because a client that is being throttled needs to know
 * to back off rather than retry into the wall.
 */
function sendGone(response: VercelResponse) {
  return response.status(404).json({ error: GONE_MESSAGE, code: 'GROUP_NOT_FOUND' });
}

function sendError(response: VercelResponse, error: unknown, context: string) {
  if (sendAuthError(response, error)) return;
  if (sendRedisError(response, error)) return;
  console.error(`Group route error (${context}):`, error);
  return response.status(500).json({ error: 'Internal Server Error' });
}

// --- POST /api/group/create -------------------------------------------------------------------

async function handleCreate(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const decoded = await requireUser(request);
    const body = request.body || {};

    // The invite token itself never arrives here — the client mints it, derives the group key
    // from it, and sends only sha256(token). A relay that could see the token could read every
    // position it stores, which would void §5.3 entirely. See doc/group-crypto-contract.md §1.
    if (!isValidTokenHash(body.tokenHash)) {
      return response.status(400).json({ error: 'A valid tokenHash is required.' });
    }
    if (!isValidEnvelope(body.meta, MAX_META_ENVELOPE_CHARS)) {
      return response.status(400).json({ error: 'meta must be a v1 envelope.' });
    }
    if (!isValidEnvelope(body.roster, MAX_ROSTER_ENVELOPE_CHARS)) {
      return response.status(400).json({ error: 'roster must be a v1 envelope.' });
    }

    // The client mints the join code too, because the wrapper below is keyed on it — the server
    // cannot generate a code the client has already wrapped a token under.
    const joinCode = normalizeJoinCode(body.joinCode);
    if (!joinCode) {
      return response.status(400).json({ error: 'joinCode must be 6 Crockford base32 characters.' });
    }
    if (!isValidEnvelope(body.wrappedToken, MAX_WRAPPED_TOKEN_CHARS)) {
      return response.status(400).json({ error: 'wrappedToken must be a v1 envelope.' });
    }

    const duration = resolveDurationMinutes(body.durationMinutes);
    if (!duration.ok) return response.status(400).json({ error: duration.error });

    const size = resolveMaxMembers(body.maxMembers);
    if (!size.ok) return response.status(400).json({ error: size.error });

    const now = Date.now();
    const expiresAt = now + duration.value * 60 * 1000;
    // §4.4: the code dies at 30 minutes or with the group, whichever comes first.
    const codeExpiresAt = Math.min(expiresAt, now + JOIN_CODE_TTL_SECONDS * 1000);

    const owner: GroupMember = {
      role: 'PARTICIPANT',
      joinedAt: now,
      roster: body.roster,
    };

    const record: GroupRecord = {
      v: 1,
      groupId: newGroupId(),
      ownerUid: decoded.uid,
      state: 'PREPARING',
      createdAt: now,
      expiresAt,
      maxMembers: size.value,
      syncIntervalSec: DEFAULT_SYNC_INTERVAL_SEC,
      tokenHash: body.tokenHash,
      joinCode,
      meta: body.meta,
    };

    const outcome = await createGroup(record, owner, codeExpiresAt, body.wrappedToken);

    if (outcome === 'CODE_TAKEN') {
      // ~1 in 1e9, but silent corruption if unhandled — the loser's code would resolve to the
      // winner's group. The client retries with a fresh code, which means a fresh wrapper; the
      // server cannot do that retry on its behalf any more.
      return response.status(409).json({
        error: 'That join code is already in use.',
        code: 'CODE_IN_USE',
      });
    }
    if (outcome === 'TOKEN_TAKEN') {
      // The client reused a token. Retrying with the same one cannot succeed, and silently
      // attaching them to someone else's group would be a serious visibility bug.
      return response.status(409).json({
        error: 'That invite token is already in use.',
        code: 'TOKEN_IN_USE',
      });
    }
    if (outcome !== 'CREATED') {
      console.error('Group create failed', { outcome });
      return response.status(500).json({ error: 'Could not create the group. Please try again.' });
    }

    // §9: aggregate counts only. distinctId is the ephemeral groupId, never a uid — nothing here
    // may support an inference about who rides with whom.
    await captureTelemetryEvent(record.groupId, 'group_created', {
      durationMinutes: duration.value,
      maxMembers: size.value,
    });

    return response.status(200).json({
      groupId: record.groupId,
      joinCode: record.joinCode,
      state: record.state,
      expiresAt: record.expiresAt,
      maxMembers: record.maxMembers,
      syncIntervalSec: record.syncIntervalSec,
      memberCount: 1,
      rev: 1,
    });
  } catch (error) {
    return sendError(response, error, 'create');
  }
}

// --- GET /api/group/resolve -------------------------------------------------------------------

async function handleResolve(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'GET') {
    return response.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const rawToken = request.query.t;
    const rawCode = request.query.c;
    const tokenHash = Array.isArray(rawToken) ? rawToken[0] : rawToken;
    const queriedCode = normalizeJoinCode(Array.isArray(rawCode) ? rawCode[0] : rawCode);

    let groupId: string | null = null;
    // Returned on the code path only. A caller resolving by token already holds the token, so
    // handing them a wrapper of it would be noise; a caller resolving by code needs it to derive
    // the group key at all.
    let wrappedToken: string | null = null;
    // Returned on the token path only, for the /g/ landing page: without the app installed and
    // without App Links (deferred to 1.7.1), typing the code is the only way in, so the page has
    // to be able to show it. Safe because a valid token hash proves possession of the token, and
    // the token is the stronger credential — the code is a weaker one they already effectively
    // hold.
    let joinCode: string | null = null;

    if (tokenHash) {
      // `t` is the token *hash*, computed client-side — never the token. A raw token in a query
      // string lands in every access log, which §10 forbids outright.
      if (!isValidTokenHash(tokenHash)) return sendGone(response);
      groupId = await resolveGroupIdByToken(tokenHash);
    } else if (queriedCode) {
      const limit = await checkCodeLookupLimit(request);
      if (!limit.allowed) {
        response.setHeader('Retry-After', String(limit.retryAfterSec));
        // Same body as a miss: a distinct "rate limited" response would confirm to a brute
        // forcer that they had found the right endpoint and were merely going too fast.
        return sendGone(response);
      }
      const entry = await resolveCodeEntry(queriedCode);
      groupId = entry?.groupId ?? null;
      wrappedToken = entry?.wrappedToken ?? null;
    } else {
      return response.status(400).json({ error: 'Provide either t (token hash) or c (join code).' });
    }

    if (!groupId) return sendGone(response);

    const record = await readGroup(groupId);
    if (!record || record.state === 'ENDED' || record.expiresAt <= Date.now()) {
      return sendGone(response);
    }

    // Never cached. The member count changes as people join, and a stale count on the join
    // sheet is the difference between "3 people are here" and joining a group that is full.
    response.setHeader('Cache-Control', 'no-store');

    const memberCount = await readMemberCount(groupId);
    // Only on the token path — a caller who typed the code already has it.
    if (tokenHash) joinCode = record.joinCode;

    // `meta` is ciphertext, and every caller who reaches this point can already decrypt it —
    // by token on one path, by unwrapping the code on the other. §4.5 says resolve returns no
    // ciphertext, which is right against *enumeration*: neither a 64-hex token hash nor a
    // rate-limited 6-character code is reachable by guessing. Returning it costs nothing and
    // is the only way any client learns the group's name.
    const payload: Record<string, unknown> = { ...toPublicView(record, memberCount), meta: record.meta };
    if (wrappedToken) payload.wrappedToken = wrappedToken;
    if (joinCode) payload.joinCode = joinCode;

    return response.status(200).json(payload);
  } catch (error) {
    return sendError(response, error, 'resolve');
  }
}

// --- POST /api/group/join ---------------------------------------------------------------------

async function handleJoin(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const decoded = await requireUser(request);
    const body = request.body || {};

    if (!isValidGroupId(body.groupId)) {
      return response.status(400).json({ error: 'A valid groupId is required.' });
    }
    if (!isValidTokenHash(body.tokenHash)) {
      // A code-joiner reaches this point too: they unwrap the token from `resolve?c=` first and
      // then arrive here with a real hash. There is no separate code path through join.
      return response.status(400).json({
        error: 'A valid tokenHash is required.',
        code: 'TOKEN_HASH_REQUIRED',
      });
    }
    if (!isValidEnvelope(body.roster, MAX_ROSTER_ENVELOPE_CHARS)) {
      return response.status(400).json({ error: 'roster must be a v1 envelope.' });
    }

    // §5.2's per-account bound. `resolve?c=` is unauthenticated so it can only be limited by IP;
    // this is where a uid limit can exist, and it caps how far a guessed code can actually get.
    const attempts = await checkJoinAttemptLimit(decoded.uid);
    if (!attempts.allowed) {
      response.setHeader('Retry-After', String(attempts.retryAfterSec));
      return response.status(429).json({
        error: 'Too many join attempts. Try again later.',
        code: 'JOIN_RATE_LIMITED',
      });
    }

    const record = await readGroup(body.groupId);
    const existing = record ? await isMember(body.groupId, decoded.uid) : false;
    const memberCount = record ? await readMemberCount(body.groupId) : 0;

    const decision = decideJoin({
      record,
      tokenHash: body.tokenHash,
      uid: decoded.uid,
      isExistingMember: existing,
      memberCount,
      nowMs: Date.now(),
    });

    if (!decision.allowed) {
      if (decision.reason === 'FULL') {
        return response.status(409).json({
          error: `This group is full (${memberCount} of ${record!.maxMembers}).`,
          code: 'GROUP_FULL',
          memberCount,
          maxMembers: record!.maxMembers,
        });
      }
      // NOT_FOUND, BAD_TOKEN, ENDED and EXPIRED all collapse to the same 404 (§8).
      return sendGone(response);
    }

    const member: GroupMember = {
      role: 'PARTICIPANT',
      joinedAt: Date.now(),
      roster: body.roster,
    };

    const result = await joinGroup(
      body.groupId,
      decoded.uid,
      member,
      record!.maxMembers,
      record!.expiresAt,
    );

    // The store re-checks capacity and existence atomically, so it can still refuse after
    // decideJoin said yes — that is the race being closed, not a contradiction.
    if (result.outcome === 'GONE') return sendGone(response);
    if (result.outcome === 'FULL') {
      return response.status(409).json({
        error: `This group is full (${result.memberCount} of ${record!.maxMembers}).`,
        code: 'GROUP_FULL',
        memberCount: result.memberCount,
        maxMembers: record!.maxMembers,
      });
    }

    if (result.outcome === 'JOINED') {
      await captureTelemetryEvent(body.groupId, 'member_joined', {
        memberCount: result.memberCount,
        viaCode: body.viaCode === true,
      });
    }

    return response.status(200).json({
      groupId: record!.groupId,
      state: record!.state,
      expiresAt: record!.expiresAt,
      maxMembers: record!.maxMembers,
      syncIntervalSec: record!.syncIntervalSec,
      memberCount: result.memberCount,
      rev: result.rev,
      rejoined: result.outcome === 'REJOINED',
      // Without this the joiner has no group name to show — `meta` is the only place it exists,
      // and they cannot read it from anywhere else. It is immutable after create, so this is the
      // one time they need it (sync re-sends it if their rev goes stale after a crash).
      meta: record!.meta,
    });
  } catch (error) {
    return sendError(response, error, 'join');
  }
}

// --- POST /api/group/sync ---------------------------------------------------------------------

/**
 * The hot path. One call, both directions (§4.3): the member posts their own encrypted position
 * and the response carries the whole group's. That beats a separate push endpoint plus a polled
 * pull on every axis — half the invocations, one round trip to see a change, and worst-case
 * staleness bounded by the push interval alone rather than push + poll + cache TTL.
 *
 * Everything below is one `EVALSHA`. See `syncGroup` for why.
 */
async function handleSync(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const decoded = await requireUser(request);
    const body = request.body || {};

    if (!isValidGroupId(body.groupId)) {
      return response.status(400).json({ error: 'A valid groupId is required.' });
    }

    // `pos` is optional on purpose. §8: when location permission is revoked mid-session the
    // member stops pushing but stays in the group as a viewer, and the app says so plainly —
    // "You're not sharing your location. Others can't see you." Symmetry made visible rather
    // than hidden. A member with nothing to send simply syncs without a position.
    let positionField = '';
    if (body.pos !== undefined && body.pos !== null) {
      if (!isValidEnvelope(body.pos, MAX_POSITION_ENVELOPE_CHARS)) {
        return response.status(400).json({ error: 'pos must be a v1 envelope.' });
      }
      // Server-stamped, always. §4.4 and §8: staleness must be computable without decrypting,
      // and a client with a skewed clock must not be able to poison freshness for the group.
      positionField = encodePositionField(Date.now(), body.pos);
    }

    const now = Date.now();
    const clientRev = Number.isFinite(Number(body.rev)) ? Number(body.rev) : -1;

    const result = await syncGroup({
      groupId: body.groupId,
      uid: decoded.uid,
      positionField,
      nowMs: now,
      ghostCutoffMs: now - GHOST_TTL_MS,
      clientRev,
      minWriteIntervalMs: MIN_WRITE_INTERVAL_MS,
    });

    if (result.code === 'GONE' || !result.record) return sendGone(response);

    // §5.2, "departed member keeps polling": they still hold the derived key, so authorisation
    // is the enforcement point, not crypto. A removed uid gets 403 regardless of what they can
    // decrypt — defence in depth, and the client treats it as "you are out of this group".
    if (result.code === 'NOT_A_MEMBER') {
      return response.status(403).json({
        error: 'You are no longer in this group.',
        code: 'NOT_A_MEMBER',
      });
    }

    if (result.code === 'TOO_FAST') {
      response.setHeader('Retry-After', '1');
      return response.status(429).json({
        error: 'Slow down.',
        code: 'SYNC_TOO_FAST',
        nextSyncInSec: result.record.syncIntervalSec,
      });
    }

    const record = result.record;

    // The TTL is the backstop and it always fires (§5.2). A record that outlives its expiry —
    // a sweep that has not run yet — must still read as ended to every client.
    const expired = record.expiresAt <= now;
    const state = expired ? 'ENDED' : record.state;

    if (state === 'ENDED') {
      // §8: Group Mode switches off cleanly and **the ride keeps recording**. The client needs a
      // definite answer here, not an error it might retry.
      return response.status(200).json({
        groupId: record.groupId,
        state: 'ENDED',
        expiresAt: record.expiresAt,
        rev: result.rev,
        positions: {},
        nextSyncInSec: 0,
      });
    }

    const positions: Record<string, { e: string; ts: number }> = {};
    for (const [uid, raw] of Object.entries(result.positions)) {
      const decoded_ = decodePositionField(raw);
      // §8: a member we cannot read is skipped and logged, never a failed response. Here that
      // means a malformed field costs one absent marker, not everyone's map.
      if (decoded_) positions[uid] = { e: decoded_.e, ts: decoded_.ts };
      else console.error('Unparseable position field', { groupId: record.groupId });
    }

    // §4.1: the caller's own entry is left in. One filter client-side is free, and because the
    // relay is opaque to us by construction (§15.4) it is the only way a client can confirm its
    // own push landed — which is the diagnostic that has to exist before the first support
    // ticket, not after.
    const payload: Record<string, unknown> = {
      groupId: record.groupId,
      state,
      expiresAt: record.expiresAt,
      rev: result.rev,
      maxMembers: record.maxMembers,
      positions,
      nextSyncInSec: nextSyncIntervalSec({
        state,
        foreground: body.foreground === true,
        moving: body.moving === true,
      }),
    };

    // Only when the caller's revision is stale — §4.5. On most syncs this is absent, which is
    // what keeps the response near §7.3's 1.5 KB budget.
    if (result.roster) {
      payload.roster = Object.fromEntries(
        Object.entries(result.roster).map(([uid, m]) => [uid, m.roster]),
      );
      payload.meta = record.meta;
    }

    return response.status(200).json(payload);
  } catch (error) {
    return sendError(response, error, 'sync');
  }
}

// --- POST /api/group/state --------------------------------------------------------------------

/**
 * Leader-only lifecycle. `PREPARING → LIVE` starts Group Mode for everyone; `→ ENDED` deletes
 * every server-side key for the group immediately (§2.7).
 */
async function handleState(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const decoded = await requireUser(request);
    const body = request.body || {};

    if (!isValidGroupId(body.groupId)) {
      return response.status(400).json({ error: 'A valid groupId is required.' });
    }
    const next: GroupState | undefined =
      body.state === 'LIVE' || body.state === 'ENDED' ? body.state : undefined;
    if (!next) {
      return response.status(400).json({ error: 'state must be LIVE or ENDED.' });
    }

    const current = await readGroupRaw(body.groupId);
    if (!current) return sendGone(response);
    const { raw, record } = current;

    if (record.ownerUid !== decoded.uid) {
      return response.status(403).json({
        error: 'Only the group leader can do that.',
        code: 'NOT_THE_LEADER',
      });
    }

    if (next === 'ENDED') {
      const deleted = await endGroup(record);
      await captureTelemetryEvent(record.groupId, 'group_ended', {
        reason: 'leader',
        durationSec: Math.round((Date.now() - record.createdAt) / 1000),
        keysDeleted: deleted,
      });
      // §2.7: an honest confirmation, and every key already gone by the time we answer.
      return response.status(200).json({ groupId: record.groupId, state: 'ENDED' });
    }

    if (record.state === 'ENDED' || record.expiresAt <= Date.now()) return sendGone(response);
    if (record.state === 'LIVE') {
      // Idempotent: a retried "Start group" after a dropped response must not be an error.
      return response.status(200).json({ groupId: record.groupId, state: 'LIVE' });
    }

    // §8: "A group of one never enters LIVE; there is nothing to be co-present with." Enforced
    // here rather than only in the UI so it is a property of the feature, not of one client.
    const memberCount = await readMemberCount(record.groupId);
    if (memberCount < 2) {
      return response.status(409).json({
        error: "You're the only one here.",
        code: 'GROUP_OF_ONE',
        memberCount,
      });
    }

    const outcome = await swapGroupState(record.groupId, raw, { ...record, state: 'LIVE' });
    if (outcome === 'GONE') return sendGone(response);
    if (outcome === 'CONFLICT') {
      return response.status(409).json({
        error: 'The group changed. Try again.',
        code: 'STATE_CONFLICT',
      });
    }

    await captureTelemetryEvent(record.groupId, 'group_started', { memberCount });

    return response.status(200).json({ groupId: record.groupId, state: 'LIVE', memberCount });
  } catch (error) {
    return sendError(response, error, 'state');
  }
}

// --- POST /api/group/leave --------------------------------------------------------------------

/**
 * §5.1.3 — **the exit is sacred and silent.**
 *
 * One tap, always reachable, and it **emits no notification to anyone**. The member simply
 * ceases to appear. This is the single most important line in the spec: a person who needs to go
 * dark must be able to, without escalation. If a future change proposes broadcasting "X left the
 * group" for engagement reasons, this is the paragraph to point at — it is a safety regression,
 * not a feature.
 *
 * The `rev` bump is not a notification. It tells other clients the roster changed, which is
 * unavoidable — the leaver must stop appearing — but nobody is told that anyone left, or who.
 * §5.2 already accepts that absence is visible: "a silent lurker is not achievable without also
 * being visibly absent."
 *
 * The analytics event is likewise not a broadcast. §9 requires leave-rate and time-to-first-leave
 * to be tracked *with equal seriousness* to the growth funnel, and is explicit that heavy use of
 * the exit is a healthy signal — nobody should ever be tasked with reducing it.
 */
async function handleLeave(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const decoded = await requireUser(request);
    const body = request.body || {};

    if (!isValidGroupId(body.groupId)) {
      return response.status(400).json({ error: 'A valid groupId is required.' });
    }

    const record = await readGroup(body.groupId);
    // Already gone, or never there. Either way the caller is out, which is what they asked for —
    // 200, not an error. Leaving must never fail in a way that leaves someone stuck visible.
    if (!record) return response.status(200).json({ left: true, endedGroup: false });

    const secondsInGroup = Math.round((Date.now() - record.createdAt) / 1000);

    // §8: "The leader leaves their own group → ends the group for everyone, and the confirm
    // dialog says exactly that." The client is responsible for having said so before calling.
    if (record.ownerUid === decoded.uid) {
      await endGroup(record);
      await captureTelemetryEvent(record.groupId, 'group_ended', {
        reason: 'leader_left',
        durationSec: secondsInGroup,
      });
      return response.status(200).json({ left: true, endedGroup: true });
    }

    const result = await leaveGroup(record, decoded.uid);

    await captureTelemetryEvent(record.groupId, 'member_left', {
      secondsInGroup,
      remaining: result.remaining,
    });

    // Deliberately minimal. The response says only what happened to *you* — no roster, no member
    // count, nothing that would let a departing client tell the group anything on its way out.
    return response.status(200).json({
      left: true,
      endedGroup: result.remaining === 0,
    });
  } catch (error) {
    return sendError(response, error, 'leave');
  }
}

// --- POST /api/group/remove -------------------------------------------------------------------

/**
 * Leader removes a member.
 *
 * The one asymmetric power in the feature, and bounded deliberately:
 * - **Leader only.** Anyone else gets 403.
 * - **The leader cannot remove themselves.** That is `leave`, which ends the group for everyone
 *   (§8) — routing it through here would end the group by a path whose confirm dialog never said so.
 * - **The removed member finds out.** Their next sync 403s and the client says "You're no longer in
 *   this group." Silent removal would be its own dishonesty, and §5.1's whole posture is that
 *   people know where they stand.
 *
 * §5.2 already anticipates the enforcement — "removed uid → 403, regardless of key possession" —
 * because a removed member still holds the derived key. Authorisation is the boundary, not crypto.
 */
async function handleRemove(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const decoded = await requireUser(request);
    const body = request.body || {};

    if (!isValidGroupId(body.groupId)) {
      return response.status(400).json({ error: 'A valid groupId is required.' });
    }
    const target = typeof body.uid === 'string' ? body.uid.trim() : '';
    if (!target) {
      return response.status(400).json({ error: 'A uid is required.' });
    }

    const record = await readGroup(body.groupId);
    if (!record) return sendGone(response);

    if (record.ownerUid !== decoded.uid) {
      return response.status(403).json({
        error: 'Only the group leader can do that.',
        code: 'NOT_THE_LEADER',
      });
    }
    if (target === record.ownerUid) {
      return response.status(400).json({
        error: 'The leader cannot remove themselves. Leaving ends the group.',
        code: 'CANNOT_REMOVE_LEADER',
      });
    }

    const result = await removeMember(record, target);
    if (result.outcome === 'GONE') return sendGone(response);

    await captureTelemetryEvent(record.groupId, 'group_member_removed', {
      remaining: result.remaining,
    });

    return response.status(200).json({ removed: true, memberCount: result.remaining, rev: result.rev });
  } catch (error) {
    return sendError(response, error, 'remove');
  }
}

// --- Routing ----------------------------------------------------------------------------------

/**
 * Vercel's file-level catch-all injects the captured segment under the literal key `...action`
 * (ellipsis retained), not `action` — confirmed against `vercel dev` and production logs (E15).
 * `action` is checked too in case that convention ever changes; without this every group request
 * 404s before reaching a handler. Same helper as `api/export/[...action].ts`.
 */
function extractAction(request: VercelRequest): string | undefined {
  const raw = request.query['...action'] ?? request.query.action;
  return Array.isArray(raw) ? raw[0] : raw;
}

export default async function handler(request: VercelRequest, response: VercelResponse) {
  switch (extractAction(request)) {
    case 'create': return handleCreate(request, response);
    case 'resolve': return handleResolve(request, response);
    case 'join': return handleJoin(request, response);
    case 'sync': return handleSync(request, response);
    case 'state': return handleState(request, response);
    case 'leave': return handleLeave(request, response);
    case 'remove': return handleRemove(request, response);
    default:
      console.error('Unmatched group action route', { url: request.url, query: request.query });
      return response.status(404).json({ error: 'Not Found' });
  }
}
