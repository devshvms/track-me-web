import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getRedisClient } from '../../../lib/redis';
import { captureTelemetryEvent } from '../../../lib/posthog';
import { AuthError, requireUser, sendAuthError } from '../../../lib/auth';

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
    sessionData.stopReason = stopReason;

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

    const ttl = await redis.ttl(`session:${sessionId}`);
    if (ttl > 0) {
      await redis.set(`session:${sessionId}`, JSON.stringify(sessionData), {
        EX: ttl
      });
    }

    await captureTelemetryEvent(sessionId, 'live_share_stopped', {
      sessionId,
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
