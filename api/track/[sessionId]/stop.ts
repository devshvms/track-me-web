import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getRedisClient } from '../../../lib/redis';
import { captureTelemetryEvent } from '../../../lib/posthog';
import { AuthError, requireUser, sendAuthError } from '../../../lib/auth';
import { deriveSessionTtlSeconds } from './location';

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

    const sessionData = JSON.parse(sessionDataStr);
    if (sessionData.ownerUid && sessionData.ownerUid !== decoded.uid) {
      throw new AuthError(403, 'Forbidden. You do not own this live share session.');
    }

    sessionData.status = 'stopped';
    sessionData.stopReason = (typeof stopReason === 'string' && stopReason.trim().length > 0)
      ? stopReason.trim()
      : 'The rider has ended this live trip.';
    sessionData.endedAt = sessionData.endedAt || new Date().toISOString();

    const startTimestamp = sessionData.startedAt || (Date.now() - (sessionData.initialDuration || 0) * 60 * 1000);
    const elapsedMinutes = Math.max(0, (Date.now() - startTimestamp) / (1000 * 60));
    const elapsedHours = Math.round((elapsedMinutes / 60) * 100) / 100;

    try {
      if (elapsedHours > 0) {
        await redis.incrByFloat('stats:total_hours', elapsedHours);
      }
    } catch (e) {
      console.error('Error incrementing total_hours on stop:', e);
    }

    // POST-RIDE VIEWING BUFFER:
    // When a trip completes or is stopped by the rider, viewers frequently inspect the share link
    // shortly after arrival. Retain the stopped session for at least 1 hour (3600s) or until the
    // original scheduled expiration (whichever is greater, capped at 24 hours), avoiding premature
    // session expiration if the rider stopped sharing near the end of their duration.
    let remainingTtl = deriveSessionTtlSeconds(sessionData);
    if (remainingTtl <= 0) {
      const queriedTtl = await redis.ttl(`session:${sessionId}`);
      if (queriedTtl > 0) remainingTtl = queriedTtl;
    }
    const finalTtl = Math.min(86400, Math.max(remainingTtl, 3600));

    await redis.set(`session:${sessionId}`, JSON.stringify(sessionData), {
      EX: finalTtl,
    });

    await captureTelemetryEvent(sessionId, 'web_live_share_session_stopped', {
      sessionId,
      session_id: sessionId,
      username: sessionData.username,
      stopReason: stopReason || 'manual_stop',
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
