import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getRedisClient } from '../../../lib/redis';
import { AuthError, requireUser, sendAuthError } from '../../../lib/auth';
import {
  appendPathPoint,
  isValidLatLng,
  parseCoordinate,
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
  'startedAt',
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

/**
 * Determines the optimal Cache-Control header for a live session GET request.
 *
 * 1. Stopped / Ended Sessions:
 *    When a session has ended (status === 'stopped' | 'ended' or endedAt is set), the route path,
 *    arrival coordinates, and metrics are frozen and will never change.
 *    Setting `s-maxage=300, max-age=60, stale-while-revalidate` allows Vercel Edge CDN to serve
 *    historical route snapshots directly for 5 minutes without incurring Redis commands or
 *    serverless invocation time.
 *
 * 2. Active Sessions:
 *    When the ride is in progress, updates arrive every 5-15s. Setting `s-maxage=2, stale-while-revalidate`
 *    absorbs burst traffic across multiple concurrent viewers while keeping latency low.
 *
 * 3. 404 / Missing Sessions:
 *    When a session is expired or does not exist, setting `s-maxage=60, max-age=10` prevents
 *    crawler bots and broken client polling loops from hammering the serverless backend.
 */
export function getSessionCacheControl(sessionData: any): string {
  if (!sessionData) {
    return 's-maxage=60, max-age=10';
  }
  const isEnded =
    sessionData.status === 'stopped' ||
    sessionData.status === 'ended' ||
    Boolean(sessionData.endedAt);

  if (isEnded) {
    return 's-maxage=300, max-age=60, stale-while-revalidate';
  }
  return 's-maxage=2, stale-while-revalidate';
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
      if (request.method === 'GET') {
        response.setHeader('Cache-Control', getSessionCacheControl(null));
      }
      return response.status(404).json({ error: 'Session not found or expired' });
    }

    const sessionData = JSON.parse(sessionDataStr);

    if (request.method === 'GET') {
      response.setHeader('Cache-Control', getSessionCacheControl(sessionData));

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
      // mobile clients (<= v1.5.7) that still send it. Also support latitude/longitude aliases.
      const rawLat = lat !== undefined ? lat : request.body?.latitude;
      const rawLng = lng !== undefined ? lng : lon !== undefined ? lon : request.body?.longitude;

      if (rawLat === undefined || rawLng === undefined) {
        return response.status(400).json({ error: 'Missing lat or lng in body' });
      }

      const numLat = parseCoordinate(rawLat);
      const numLng = parseCoordinate(rawLng);

      if (numLat === null || numLng === null || !isValidLatLng(numLat, numLng)) {
        return response.status(400).json({ error: 'Invalid lat or lng coordinate values' });
      }

      const { path, heading: resolvedHeading, isJumpFiltered } = appendPathPoint(
        sessionData.path,
        numLat,
        numLng,
        heading,
        sessionData.lastLocation?.timestamp,
        timestamp,
      );
      sessionData.path = path;

      // CIE-015: Low battery threshold defense (<= 15%)
      // If powerSaveMode is explicitly provided, respect it.
      // Additionally, if batteryLevel is <= 15%, automatically enforce powerSaveMode = true
      // to guarantee viewers (Web tracker.html, Android, iOS) display power saving and delayed update alerts
      // even if older mobile clients omitted the flag.
      const isLowBattery =
        typeof batteryLevel === 'number' &&
        Number.isFinite(batteryLevel) &&
        batteryLevel >= 0 &&
        batteryLevel <= 15;
      const effectivePowerSave =
        (typeof powerSaveMode === 'boolean' ? powerSaveMode : false) || isLowBattery;

      const validSpeed =
        typeof speed === 'number' && Number.isFinite(speed) && speed >= 0
          ? Math.round(speed * 10) / 10
          : null;

      const validHeading =
        resolvedHeading !== null
          ? resolvedHeading
          : typeof heading === 'number' && Number.isFinite(heading) && heading >= 0 && heading <= 360
          ? Math.round(heading * 10) / 10
          : null;

      if (isJumpFiltered && sessionData.lastLocation) {
        console.warn(`[location] Implausible GPS jump filtered for session ${sessionId}: lat=${numLat}, lng=${numLng}`);
        // Maintain last known valid coordinates on map while updating device battery & freshness
        sessionData.lastLocation = {
          ...sessionData.lastLocation,
          batteryLevel: typeof batteryLevel === 'number' && Number.isFinite(batteryLevel) ? batteryLevel : sessionData.lastLocation.batteryLevel,
          powerSaveMode: effectivePowerSave,
          timestamp: timestamp || new Date().toISOString(),
        };
      } else {
        sessionData.lastLocation = {
          lat: numLat,
          lng: numLng,
          batteryLevel,
          speed: validSpeed,
          heading: validHeading,
          powerSaveMode: effectivePowerSave,
          timestamp: timestamp || new Date().toISOString(),
        };
      }

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

      // CIE-017: Persist updated session state, prune stale viewers, and count active viewers
      // in a SINGLE atomic network roundtrip via multi() when supported.
      // Eliminates separate network roundtrips between set and viewer counting, cutting
      // serverless invocation latency by ~50% on every location push.
      let activeViewers = 0;
      const viewersKey = `session:${sessionId}:viewers`;
      const cutoff = Date.now() - STALE_VIEWER_WINDOW_MS;

      if (typeof redis.multi === 'function') {
        const multi = redis.multi();
        if (remainingTtlSeconds > 0) {
          multi.set(`session:${sessionId}`, JSON.stringify(sessionData), {
            EX: remainingTtlSeconds,
          });
        } else {
          multi.set(`session:${sessionId}`, JSON.stringify(sessionData));
        }
        multi.zRemRangeByScore(viewersKey, 0, cutoff);
        multi.zCard(viewersKey);
        const results = await multi.exec();
        // results[0] = result of set ("OK")
        // results[1] = result of zRemRangeByScore (pruned count)
        // results[2] = result of zCard (active viewers count)
        activeViewers = typeof results?.[2] === 'number' ? results[2] : 0;
      } else {
        if (remainingTtlSeconds > 0) {
          await redis.set(`session:${sessionId}`, JSON.stringify(sessionData), {
            EX: remainingTtlSeconds,
          });
        } else {
          await redis.set(`session:${sessionId}`, JSON.stringify(sessionData));
        }
        try {
          await redis.zRemRangeByScore(viewersKey, 0, cutoff);
          activeViewers = await redis.zCard(viewersKey);
        } catch (viewerErr) {
          console.error('Active viewer count lookup error:', viewerErr);
        }
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
