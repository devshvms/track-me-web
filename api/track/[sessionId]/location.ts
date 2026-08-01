import type { VercelRequest, VercelResponse } from '@vercel/node';
import { expectsDurableStore, getRedisClient, isDurableStore, setPreservingExpiry } from '../../../lib/redis';
import { AuthError, requireUser, sendAuthError } from '../../../lib/auth';

/**
 * The share link is public; the stored session blob is not. It carries the
 * owner's account identity (ownerUid, ownerEmail — written by start.ts) and
 * internal fields (stopReason, startedAt) that anyone holding the link must
 * never see. The GET response is built from this whitelist; adding a field
 * here publishes it to every viewer.
 */
export const VIEWER_VISIBLE_FIELDS = [
  'username',
  'status',
  'endReason',
  'endedAt',
  'initialDuration',
  'destination',
  'etaAt',
  'deadlineAt',
  'lastLocation',
] as const;

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  const { sessionId, viewerId } = request.query;

  if (typeof sessionId !== 'string') {
    return response.status(400).json({ error: 'Missing or invalid sessionId' });
  }

  try {
    const redis = await getRedisClient();
    
    const sessionDataStr = await redis.get(`session:${sessionId}`);
    if (!sessionDataStr) {
      return response.status(404).json({ error: 'Session not found or expired' });
    }

    const sessionData = JSON.parse(sessionDataStr);

    if (request.method === 'GET') {
      // Allow Vercel Edge to cache this response across all viewers for 2 seconds.
      // If 10k users poll every 5s, the edge cache absorbs 99.9% of the traffic.
      response.setHeader('Cache-Control', 's-maxage=2, stale-while-revalidate');

      const viewerPayload: Record<string, unknown> = {};
      for (const field of VIEWER_VISIBLE_FIELDS) {
        if (field in sessionData) viewerPayload[field] = sessionData[field];
      }
      return response.status(200).json(viewerPayload);
    }
    
    if (request.method === 'POST') {
      const decoded = await requireUser(request);
      if (sessionData.ownerUid && sessionData.ownerUid !== decoded.uid) {
        throw new AuthError(403, 'Forbidden. You do not own this live share session.');
      }

      const { lat, lng, lon, batteryLevel, speed, heading, timestamp } = request.body || {};
      // Canonical field is `lng`; `lon` is accepted for backward compatibility with
      // mobile clients (<= v1.5.7) that still send it. Do not drop `lon` support
      // until both stores' installed bases have migrated.
      const longitude = lng !== undefined ? lng : lon;

      if (lat === undefined || longitude === undefined) {
        return response.status(400).json({ error: 'Missing lat or lng in body' });
      }

      sessionData.lastLocation = {
        lat,
        lng: longitude,
        batteryLevel,
        speed,
        heading,
        timestamp: timestamp || new Date().toISOString()
      };

      // TASK-170 / DEFECT-B. This handler must never answer 200 {success:true}
      // for an update it did not store. The rider's phone treats success as
      // "delivered" and stops caring; the viewer keeps rendering the last
      // stored position, which a worried person reads as a stationary rider
      // rather than a dead feed.
      if (!isDurableStore(redis) && expectsDurableStore()) {
        console.error(
          `Live-share location write refused: no durable store (see the [redis] DEGRADED warning) session=${sessionId}`,
        );
        return response.status(503).json({ error: 'Location store unavailable. This update was not saved.' });
      }

      const written = await setPreservingExpiry(
        redis,
        `session:${sessionId}`,
        JSON.stringify(sessionData),
      );

      if (!written.ok) {
        if (written.reason === 'key_missing') {
          // The session expired between the read above and this write.
          return response.status(404).json({ error: 'Session not found or expired' });
        }
        console.error(
          `Live-share location write failed session=${sessionId} ttl=${written.ttl}`,
          written.error,
        );
        return response.status(503).json({ error: 'Location store unavailable. This update was not saved.' });
      }

      return response.status(200).json({ success: true });
    }

    return response.status(405).json({ error: 'Method Not Allowed' });

  } catch (error) {
    if (sendAuthError(response, error)) return;
    console.error('Error handling location:', error);
    return response.status(500).json({ error: 'Internal Server Error' });
  }
}
