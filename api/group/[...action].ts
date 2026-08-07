import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireUser, sendAuthError } from '../../lib/auth';
import { sendRedisError } from '../../lib/redis';
import { captureTelemetryEvent } from '../../lib/posthog';
import { checkCodeLookupLimit } from '../../lib/group/rate-limit';
import {
  DEFAULT_SYNC_INTERVAL_SEC,
  GroupMember,
  GroupRecord,
  JOIN_CODE_TTL_SECONDS,
  MAX_META_ENVELOPE_CHARS,
  MAX_ROSTER_ENVELOPE_CHARS,
  MAX_WRAPPED_TOKEN_CHARS,
  decideJoin,
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
  resolveCodeEntry,
  resolveGroupIdByToken,
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

// GR-03 ships create/resolve/join. sync, state and leave land in GR-04/GR-05.

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
    const joinCode = normalizeJoinCode(Array.isArray(rawCode) ? rawCode[0] : rawCode);

    let groupId: string | null = null;
    // Returned on the code path only. A caller resolving by token already holds the token, so
    // handing them a wrapper of it would be noise; a caller resolving by code needs it to derive
    // the group key at all.
    let wrappedToken: string | null = null;

    if (tokenHash) {
      // `t` is the token *hash*, computed client-side — never the token. A raw token in a query
      // string lands in every access log, which §10 forbids outright.
      if (!isValidTokenHash(tokenHash)) return sendGone(response);
      groupId = await resolveGroupIdByToken(tokenHash);
    } else if (joinCode) {
      const limit = await checkCodeLookupLimit(request);
      if (!limit.allowed) {
        response.setHeader('Retry-After', String(limit.retryAfterSec));
        // Same body as a miss: a distinct "rate limited" response would confirm to a brute
        // forcer that they had found the right endpoint and were merely going too fast.
        return sendGone(response);
      }
      const entry = await resolveCodeEntry(joinCode);
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
    const view = toPublicView(record, memberCount);
    return response.status(200).json(wrappedToken ? { ...view, wrappedToken } : view);
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
    });
  } catch (error) {
    return sendError(response, error, 'join');
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
    default:
      console.error('Unmatched group action route', { url: request.url, query: request.query });
      return response.status(404).json({ error: 'Not Found' });
  }
}
