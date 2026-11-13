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

/**
 * Computes remaining TTL in seconds from a stored session's ISO8601 `expiresAt`.
 * Deriving TTL from the stored session data eliminates an explicit network roundtrip
 * to redis.ttl on every location push.
 *
 * @param sessionData The parsed session record containing `expiresAt`
 * @param nowMs Current epoch timestamp in milliseconds (defaults to Date.now())
 * @returns Remaining TTL in whole seconds, or 0 if expired/invalid/absent.
 */
export function deriveSessionTtlSeconds(sessionData: any, nowMs: number = Date.now()): number {
  if (!sessionData || typeof sessionData.expiresAt !== 'string') return 0;
  const expiresAtMs = new Date(sessionData.expiresAt).getTime();
  if (!Number.isFinite(expiresAtMs)) return 0;
  return Math.max(0, Math.floor((expiresAtMs - nowMs) / 1000));
}

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

      // Calculate remaining TTL directly from sessionData.expiresAt.
      // Every session created via start.ts stores `expiresAt` as an ISO8601 string.
      // Deriving remaining seconds directly from the stored timestamp eliminates a separate network roundtrip
      // to redis.ttl on every single location POST (saving 20-50ms latency inside Vercel serverless).
      let remainingTtlSeconds = deriveSessionTtlSeconds(sessionData);

      // Defensive fallback: If expiresAt was absent or clock skew caused <= 0, query redis.ttl
      if (remainingTtlSeconds <= 0) {
        const queriedTtl = await redis.ttl(`session:${sessionId}`);
        if (queriedTtl > 0) {
          remainingTtlSeconds = queriedTtl;
        }
      }

      // Persist updated session state:
      // If remainingTtlSeconds > 0, retain the precise expiration with EX.
      // If remainingTtlSeconds <= 0 (e.g. mock Redis in dev/test, or key without expiry), persist without EX
      // so updates are never silently discarded.
      if (remainingTtlSeconds > 0) {
        await redis.set(`session:${sessionId}`, JSON.stringify(sessionData), {
          EX: remainingTtlSeconds,
        });
      } else {
        await redis.set(`session:${sessionId}`, JSON.stringify(sessionData));
      }

      // Batch prune stale viewers and count active viewers in a single roundtrip via multi() when supported.
      let activeViewers = 0;
      try {
        const viewersKey = `session:${sessionId}:viewers`;
        const cutoff = Date.now() - STALE_VIEWER_WINDOW_MS;
        if (typeof redis.multi === 'function') {
          const multi = redis.multi();
          multi.zRemRangeByScore(viewersKey, 0, cutoff);
          multi.zCard(viewersKey);
          const results = await multi.exec();
          // results[1] corresponds to the zCard count
          activeViewers = typeof results?.[1] === 'number' ? results[1] : 0;
        } else {
          await redis.zRemRangeByScore(viewersKey, 0, cutoff);
          activeViewers = await redis.zCard(viewersKey);
        }
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
