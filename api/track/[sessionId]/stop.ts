import type { VercelRequest, VercelResponse } from '@vercel/node';
import { expectsDurableStore, getRedisClient, isDurableStore, setWithScopedExpiry } from '../../../lib/redis';
import { captureTelemetryEvent } from '../../../lib/posthog';
import { AuthError, requireUser, sendAuthError } from '../../../lib/auth';
import { computeClosureTtlSeconds } from '../../../lib/tripExpiry';

/**
 * TASK-172 / DEFECT-A. Why a live-share session ended is a safety signal, not a
 * label. The viewer renders each value differently, because "the rider ended
 * the ride" is the safe signal and "the session timed out" is the absence of
 * any signal at all. Rendering one string for both destroys the signal.
 *
 * `marked_safe` is the ONLY value that may be shown as an all-clear, and it is
 * written only when the client explicitly asks for it after the rider
 * confirmed. There is no path that infers it.
 *
 * `expired` is accepted for completeness but is not normally written here: real
 * expiry is the Redis key disappearing, which the viewer sees as a 404.
 */
export const SESSION_END_REASONS = ['marked_safe', 'ride_ended', 'expired'] as const;
export type SessionEndReason = (typeof SESSION_END_REASONS)[number];

/**
 * Map a request body onto the enum.
 *
 * Older clients send a free-form `stopReason` (e.g. "manual_stop") and no
 * `endReason` at all. Those collapse to `ride_ended`, which is true of every
 * call that reaches this endpoint — it is authenticated, owner-only and
 * deliberate. Nothing unrecognised may ever collapse to `marked_safe`: an
 * unknown reason rendered as an all-clear is the exact failure this task
 * exists to prevent.
 */
export function resolveEndReason(body: any): SessionEndReason {
  const candidate = body?.endReason;
  if (typeof candidate === 'string' && (SESSION_END_REASONS as readonly string[]).includes(candidate)) {
    return candidate as SessionEndReason;
  }
  return 'ride_ended';
}

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method Not Allowed' });
  }

  const { sessionId } = request.query;

  if (typeof sessionId !== 'string') {
    return response.status(400).json({ error: 'Missing or invalid sessionId' });
  }

  try {
    const decoded = await requireUser(request);
    const redis = await getRedisClient();

    const sessionDataStr = await redis.get(`session:${sessionId}`);
    if (!sessionDataStr) {
      return response.status(404).json({ error: 'Session not found or already expired' });
    }
    const { stopReason } = request.body || {};
    const endReason = resolveEndReason(request.body);

    const sessionData = JSON.parse(sessionDataStr);
    if (sessionData.ownerUid && sessionData.ownerUid !== decoded.uid) {
      throw new AuthError(403, 'Forbidden. You do not own this live share session.');
    }

    sessionData.status = 'stopped';
    // Legacy free-form field, retained so existing telemetry and any older
    // consumer keep working. It is never rendered to a viewer any more.
    sessionData.stopReason = stopReason;
    sessionData.endReason = endReason;
    sessionData.endedAt = new Date().toISOString();

    const startTimestamp = sessionData.startedAt || (Date.now() - (sessionData.initialDuration || 0) * 60 * 1000);
    const elapsedMinutes = Math.max(0, (Date.now() - startTimestamp) / (1000 * 60));

    // TASK-170. The closure has to be stored before anything reports it as
    // done. A rider who believes they marked themselves safe while no viewer
    // can see it is the worst outcome this endpoint has, so the write comes
    // first and its failure is returned to the caller.
    if (!isDurableStore(redis) && expectsDurableStore()) {
      console.error(
        `Live-share stop refused: no durable store (see the [redis] DEGRADED warning) session=${sessionId}`,
      );
      return response.status(503).json({ error: 'Location store unavailable. Sharing was not stopped.' });
    }

    // TASK-171 / D5. Ride end re-scopes the session's lifetime: visible for a
    // set window after this moment, or through deadline + window if that is
    // later — the guardian who checks at the deadline must find the closure,
    // not a 404. A stopped share also no longer lingers for the remainder of a
    // long duration window.
    const closureTtlSeconds = computeClosureTtlSeconds(
      sessionData.deadlineAt ? new Date(sessionData.deadlineAt).getTime() : null,
      Date.now(),
    );

    const written = await setWithScopedExpiry(
      redis,
      `session:${sessionId}`,
      JSON.stringify(sessionData),
      closureTtlSeconds,
    );

    if (!written.ok) {
      if (written.reason === 'key_missing') {
        // Expired between the read above and this write; there is no session
        // left to close, and the viewer already sees the expiry.
        return response.status(404).json({ error: 'Session not found or already expired' });
      }
      console.error(
        `Live-share stop write failed session=${sessionId} ttl=${written.ttl}`,
        written.error,
      );
      return response.status(503).json({ error: 'Location store unavailable. Sharing was not stopped.' });
    }

    const elapsedHours = Math.round((elapsedMinutes / 60) * 100) / 100;
    try {
      if (elapsedHours > 0) {
        await redis.incrByFloat('stats:total_hours', elapsedHours);
      }
    } catch (e) {
      console.error('Error incrementing total_hours on stop:', e);
    }

    await captureTelemetryEvent(sessionId, 'web_live_share_session_stopped', {
      sessionId,
      username: sessionData.username,
      stopReason: stopReason || 'manual_stop',
      endReason,
      initialDurationMinutes: sessionData.initialDuration,
      actualDurationMinutes: Math.round(elapsedMinutes * 10) / 10,
    });

    return response.status(200).json({ success: true, message: 'Sharing stopped', endReason });

  } catch (error) {
    if (sendAuthError(response, error)) return;
    console.error('Error stopping session:', error);
    return response.status(500).json({ error: 'Internal Server Error' });
  }
}
