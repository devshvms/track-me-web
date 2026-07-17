import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';
import { getRedisClient } from '../../lib/redis';
import { captureTelemetryEvent } from '../../lib/posthog';
import { absoluteUrl } from '../../lib/http';
import { requireUser, sendAuthError } from '../../lib/auth';

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const decoded = await requireUser(request);
    const { durationMinutes, username } = request.body || {};
    let duration = parseInt(durationMinutes, 10);
    if (isNaN(duration) || duration <= 0) {
      duration = 1440;
    } else if (duration > 1440) {
      return response.status(400).json({ error: 'Duration cannot exceed 24 hours (1440 minutes).' });
    }

    const redis = await getRedisClient();

    const now = Date.now();
    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(now + duration * 60 * 1000);
    
    const sessionData = {
      sessionId,
      ownerUid: decoded.uid,
      ownerEmail: decoded.email || null,
      username: username || 'Anonymous',
      initialDuration: duration,
      startedAt: now,
      expiresAt: expiresAt.toISOString(),
      status: 'active',
      lastLocation: null
    };

    await redis.set(`session:${sessionId}`, JSON.stringify(sessionData), {
      EX: duration * 60
    });

    try {
      await redis.incr('stats:total_shares');
      await redis.zAdd('stats:shares_24h', { score: now, value: sessionId });
      await redis.zRemRangeByScore('stats:shares_24h', 0, now - 24 * 60 * 60 * 1000);
    } catch (e) {
      console.error('Stats update error:', e);
    }

    const country = (request.headers['x-vercel-ip-country'] as string) || 'unknown';
    await captureTelemetryEvent(sessionId, 'live_share_started', {
      sessionId,
      username: sessionData.username,
      durationMinutes: duration,
      country,
    });

    const shareLink = absoluteUrl(request, `/live/${sessionId}`);

    return response.status(200).json({
      sessionId,
      shareLink,
      expiresAt: sessionData.expiresAt
    });
  } catch (error) {
    if (sendAuthError(response, error)) return;
    console.error('Error starting session:', error);
    return response.status(500).json({ error: 'Internal Server Error' });
  }
}
