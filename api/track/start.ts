import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';
import { getRedisClient } from '../../lib/redis';
import { captureTelemetryEvent } from '../../lib/posthog';
import { absoluteUrl } from '../../lib/http';
import { requireUser, sendAuthError } from '../../lib/auth';
import {
  MAX_SESSION_MINUTES,
  computeStartTtlSeconds,
  parseTripPlan,
} from '../../lib/tripExpiry';

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

    // TASK-171 / D5. The fixed 24-hour cap is gone; a session is scoped to the
    // trip when the client sends one (destination / etaAt / deadlineAt), and
    // the only remaining ceiling is the anti-typo guard in lib/tripExpiry.ts.
    const parsed = parseInt(durationMinutes, 10);
    const duration = isNaN(parsed) || parsed <= 0 ? null : parsed;
    if (duration !== null && duration > MAX_SESSION_MINUTES) {
      return response.status(400).json({
        error: `Duration cannot exceed ${MAX_SESSION_MINUTES} minutes (${MAX_SESSION_MINUTES / (24 * 60)} days).`,
      });
    }

    const now = Date.now();
    const trip = parseTripPlan(request.body, now);
    if (!trip.ok) {
      return response.status(400).json({ error: trip.error });
    }
    const { destination, etaAt, deadlineAt } = trip.plan;

    const ttlSeconds = computeStartTtlSeconds(
      {
        durationMinutes: duration,
        deadlineAtMs: deadlineAt ? new Date(deadlineAt).getTime() : null,
      },
      now,
    );

    const redis = await getRedisClient();

    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(now + ttlSeconds * 1000);

    const sessionData: Record<string, unknown> = {
      sessionId,
      ownerUid: decoded.uid,
      ownerEmail: decoded.email || null,
      username: username || 'Anonymous',
      initialDuration: Math.round(ttlSeconds / 60),
      startedAt: now,
      expiresAt: expiresAt.toISOString(),
      status: 'active',
      lastLocation: null
    };
    // Only trip sessions carry trip fields; the viewer renders them (TASK-173)
    // and the closure TTL is computed from deadlineAt (TASK-171).
    if (destination) sessionData.destination = destination;
    if (etaAt) sessionData.etaAt = etaAt;
    if (deadlineAt) sessionData.deadlineAt = deadlineAt;

    await redis.set(`session:${sessionId}`, JSON.stringify(sessionData), {
      EX: ttlSeconds
    });

    try {
      await redis.incr('stats:total_shares');
      await redis.zAdd('stats:shares_24h', { score: now, value: sessionId });
      await redis.zRemRangeByScore('stats:shares_24h', 0, now - 24 * 60 * 60 * 1000);
    } catch (e) {
      console.error('Stats update error:', e);
    }

    const country = (request.headers['x-vercel-ip-country'] as string) || 'unknown';
    // Trip details stay out of telemetry — a guardian deadline and destination
    // are the rider's business; only their presence is worth counting.
    await captureTelemetryEvent(sessionId, 'web_live_share_session_started', {
      sessionId,
      username: sessionData.username,
      durationMinutes: Math.round(ttlSeconds / 60),
      tripScoped: Boolean(deadlineAt),
      hasDestination: Boolean(destination),
      hasEta: Boolean(etaAt),
      country,
    });

    const shareLink = absoluteUrl(request, `/live/${sessionId}`);

    return response.status(200).json({
      sessionId,
      shareLink,
      expiresAt: sessionData.expiresAt,
      etaAt,
      deadlineAt
    });
  } catch (error) {
    if (sendAuthError(response, error)) return;
    console.error('Error starting session:', error);
    return response.status(500).json({ error: 'Internal Server Error' });
  }
}
