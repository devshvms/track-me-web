import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getRedisClient } from '../../../lib/redis';
import { captureTelemetryEvent } from '../../../lib/posthog';
import { AuthError, requireUser, sendAuthError } from '../../../lib/auth';
import { deriveSessionTtlSeconds } from './location';
import { parseTimestampMs } from '../../../lib/track/duration';

export const MAX_STOP_REASON_LENGTH = 256;
export const DEFAULT_STOP_REASON = 'The rider has ended this live trip.';
export const MIN_POST_RIDE_BUFFER_SECONDS = 3600; // 1 hour post-ride viewing buffer
export const MAX_SESSION_TTL_SECONDS = 86400; // 24 hours max session retention

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method Not Allowed' });
  }

  const { sessionId } = request.query;

  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    return response.status(400).json({ error: 'Missing or invalid sessionId' });
  }

  const cleanSessionId = sessionId.trim();

  try {
    const decoded = await requireUser(request);
    const redis = await getRedisClient();
    
    const sessionDataStr = await redis.get(`session:${cleanSessionId}`);
    if (!sessionDataStr) {
      return response.status(404).json({ error: 'Session not found or already expired' });
    }
    const { stopReason } = request.body || {};

    const sessionData = JSON.parse(sessionDataStr);
    if (sessionData.ownerUid && sessionData.ownerUid !== decoded.uid) {
      throw new AuthError(403, 'Forbidden. You do not own this live share session.');
    }

    sessionData.status = 'stopped';
    const rawReason = typeof stopReason === 'string' ? stopReason.trim() : '';
    sessionData.stopReason = rawReason.length > 0
      ? rawReason.slice(0, MAX_STOP_REASON_LENGTH)
      : DEFAULT_STOP_REASON;
    sessionData.endedAt = sessionData.endedAt || new Date().toISOString();

    const parsedStart = parseTimestampMs(sessionData.startedAt);
    const startTimestamp = parsedStart ?? (Date.now() - (sessionData.initialDuration || 0) * 60 * 1000);
    const elapsedMinutes = Math.max(0, (Date.now() - startTimestamp) / (1000 * 60));
    const elapsedHours = Math.round((elapsedMinutes / 60) * 100) / 100;

    // POST-RIDE VIEWING BUFFER:
    // When a trip completes or is stopped by the rider, viewers frequently inspect the share link
    // shortly after arrival. Retain the stopped session for at least 1 hour (3600s) or until the
    // original scheduled expiration (whichever is greater, capped at 24 hours), avoiding premature
    // session expiration if the rider stopped sharing near the end of their duration.
    let remainingTtl = deriveSessionTtlSeconds(sessionData);
    if (remainingTtl <= 0) {
      const queriedTtl = await redis.ttl(`session:${cleanSessionId}`);
      if (queriedTtl > 0) remainingTtl = queriedTtl;
    }
    const finalTtl = Math.min(MAX_SESSION_TTL_SECONDS, Math.max(remainingTtl, MIN_POST_RIDE_BUFFER_SECONDS));

    // Pipelined Redis persistence:
    // Execute state update and stats increment in a single roundtrip via multi() when available,
    // reducing serverless invocation time and defending free-tier Redis command budget.
    try {
      if (typeof redis.multi === 'function') {
        const multi = redis.multi();
        multi.set(`session:${cleanSessionId}`, JSON.stringify(sessionData), {
          EX: finalTtl,
        });
        if (elapsedHours > 0) {
          multi.incrByFloat('stats:total_hours', elapsedHours);
        }
        await multi.exec();
      } else {
        await redis.set(`session:${cleanSessionId}`, JSON.stringify(sessionData), {
          EX: finalTtl,
        });
        if (elapsedHours > 0) {
          await redis.incrByFloat('stats:total_hours', elapsedHours);
        }
      }
    } catch (pipelineErr) {
      console.error('Error saving stopped session in pipeline, falling back:', pipelineErr);
      await redis.set(`session:${cleanSessionId}`, JSON.stringify(sessionData), {
        EX: finalTtl,
      });
    }

    await captureTelemetryEvent(cleanSessionId, 'web_live_share_session_stopped', {
      sessionId: cleanSessionId,
      session_id: cleanSessionId,
      username: sessionData.username,
      stopReason: sessionData.stopReason,
      initialDurationMinutes: sessionData.initialDuration,
      actualDurationMinutes: Math.round(elapsedMinutes * 10) / 10,
    });

    return response.status(200).json({ success: true, message: 'Sharing stopped' });

  } catch (error) {
    if (sendAuthError(response, error)) return;
    console.error('Error stopping session:', error);
    return response.status(500).json({ error: 'Internal Server Error' });
  }
}
