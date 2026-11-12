import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getRedisClient } from '../../../lib/redis';
import { AuthError, requireUser, sendAuthError } from '../../../lib/auth';
import {
  appendPathPoint,
  isValidLatLng,
  STALE_VIEWER_WINDOW_MS,
} from '../../../lib/track/trail';


/**
 * The share link is public; the stored session blob is not. It carries the
 * owner's account identity (ownerUid, ownerEmail — written by start.ts) and
 * internal fields (startedAt) that anyone holding the link must never see.
 * The GET response is built from this whitelist; adding a field here publishes
 * it to every viewer.
 */
export const VIEWER_VISIBLE_FIELDS = [
  'username',
  'status',
  'stopReason',
  'endReason',
  'endedAt',
  'initialDuration',
  'destination',
  'etaAt',
  'deadlineAt',
  'lastLocation',
  'path',
] as const;

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  const { sessionId } = request.query;

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

      const { lat, lng, lon, batteryLevel, speed, heading, timestamp, powerSaveMode } = request.body || {};
      // Canonical field is `lng`; `lon` is accepted for backward compatibility with
      // mobile clients (<= v1.5.7) that still send it. Do not drop `lon` support
      // until both stores' installed bases have migrated.
      const longitude = lng !== undefined ? lng : lon;

      if (lat === undefined || longitude === undefined) {
        return response.status(400).json({ error: 'Missing lat or lng in body' });
      }
      if (!isValidLatLng(lat, longitude)) {
        return response.status(400).json({ error: 'Invalid lat or lng coordinate values' });
      }

      const { path, heading: resolvedHeading } = appendPathPoint(
        sessionData.path,
        lat,
        longitude,
        heading,
      );
      sessionData.path = path;

      sessionData.lastLocation = {
        lat,
        lng: longitude,
        batteryLevel,
        speed,
        heading: resolvedHeading !== null ? resolvedHeading : heading,
        powerSaveMode: typeof powerSaveMode === 'boolean' ? powerSaveMode : false,
        timestamp: timestamp || new Date().toISOString()
      };

      const ttl = await redis.ttl(`session:${sessionId}`);
      if (ttl > 0) {
        await redis.set(`session:${sessionId}`, JSON.stringify(sessionData), {
          EX: ttl
        });
      }

      let activeViewers = 0;
      try {
        const viewersKey = `session:${sessionId}:viewers`;
        await redis.zRemRangeByScore(viewersKey, 0, Date.now() - STALE_VIEWER_WINDOW_MS);
        activeViewers = await redis.zCard(viewersKey);
      } catch (viewerErr) {
        console.error('Active viewer count lookup error:', viewerErr);
      }

      return response.status(200).json({ success: true, activeViewers });
    }

    return response.status(405).json({ error: 'Method Not Allowed' });

  } catch (error) {
    if (sendAuthError(response, error)) return;
    console.error('Error handling location:', error);
    return response.status(500).json({ error: 'Internal Server Error' });
  }
}
