import type { VercelRequest, VercelResponse } from '@vercel/node';
import { FieldValue } from 'firebase-admin/firestore';
import { captureTelemetryEvent } from '../lib/posthog';
import { getRedisClient } from '../lib/redis';
import { db } from '../lib/firebase';
import { parseWaitlistRequest, buildWaitlistRecord } from '../lib/waitlist';

// Single function serving /api/telemetry/{event,stats,subscribe} via the
// vercel.json rewrite that maps /api/telemetry/:route to ?route=:route.
// Consolidated to stay within the Hobby-plan serverless function limit (D1's
// waitlist capture folds in here rather than adding a 13th function).
export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  const route = request.query.route;

  if (route === 'event') {
    return handleEvent(request, response);
  }
  if (route === 'stats') {
    return handleStats(request, response);
  }
  if (route === 'subscribe') {
    return handleSubscribe(request, response);
  }
  return response.status(404).json({ error: 'Not Found' });
}

// D1 — waitlist capture. Server-side normalize + HMAC-hash of the email (the
// raw address is used ephemerally in memory and never stored/logged/sent to
// PostHog). Dedupe is idempotent via the hash-as-doc-id create() collision.
async function handleSubscribe(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method Not Allowed' });
  }

  const pepper = process.env.WAITLIST_HASH_PEPPER;
  if (!pepper) {
    // Fail closed rather than fall back to an enumerable plain hash.
    console.error('Waitlist subscribe error: WAITLIST_HASH_PEPPER not configured');
    return response.status(503).json({ error: 'Waitlist is temporarily unavailable' });
  }

  // Coarse per-IP rate limit (spam / accidental loops). Best-effort: a Redis
  // outage must not take the endpoint down, so failures here are swallowed.
  const ip =
    ((request.headers['x-forwarded-for'] as string) || '').split(',')[0].trim() ||
    request.socket.remoteAddress ||
    'unknown';
  try {
    const redis = await getRedisClient();
    const key = `waitlist:rl:${ip}`;
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, 60 * 60); // 1h window
    }
    if (count > 10) {
      return response.status(429).json({ error: 'Too many requests. Please try again later.' });
    }
  } catch (e) {
    console.error('Waitlist rate-limit check failed (allowing):', e);
  }

  const parsed = parseWaitlistRequest(request.body || {}, pepper);
  if (!parsed.ok) {
    // Honeypot hits get a generic 200 so bots learn nothing; real validation
    // errors get a 400 with a reason code that never echoes the address.
    if (parsed.error === 'bot') {
      return response.status(200).json({ success: true });
    }
    return response.status(400).json({ error: 'Please enter a valid email address.' });
  }

  const { emailHash, platform } = parsed;

  if (!db) {
    console.error('Waitlist subscribe error: Firestore unavailable');
    return response.status(503).json({ error: 'Waitlist is temporarily unavailable' });
  }

  let isNew = true;
  try {
    await db
      .collection('waitlist')
      .doc(emailHash!)
      .create({ ...buildWaitlistRecord(emailHash!, platform!), createdAt: FieldValue.serverTimestamp() });
  } catch (error: any) {
    // Firestore code 6 = ALREADY_EXISTS -> duplicate signup. Idempotent success.
    if (error?.code === 6) {
      isNew = false;
    } else {
      console.error('Waitlist Firestore write error:', error?.message || 'unknown');
      return response.status(500).json({ error: 'Could not save your signup. Please try again.' });
    }
  }

  if (isNew) {
    // PII-free funnel event. distinctId is the non-reversible hash (not the
    // address) so the signup can be de-duplicated in the funnel without PII.
    const country = (request.headers['x-vercel-ip-country'] as string) || 'unknown';
    await captureTelemetryEvent(emailHash!, 'waitlist_signup', {
      platform_interest: platform,
      page: 'home_v2',
      country,
    });
  }

  // Generic success either way — never reveals whether the address was new,
  // to avoid membership/enumeration disclosure.
  return response.status(200).json({ success: true });
}

async function handleEvent(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { event, distinctId, properties = {} } = request.body || {};

    if (!event || typeof event !== 'string') {
      return response.status(400).json({ error: 'Missing or invalid event name' });
    }

    const country = (request.headers['x-vercel-ip-country'] as string) || 'unknown';
    const enrichedProperties = {
      ...properties,
      country,
      $ip: request.headers['x-forwarded-for'] || request.socket.remoteAddress,
    };

    const id = distinctId || properties.viewerId || properties.sessionId || 'anonymous_visitor';

    await captureTelemetryEvent(id, event, enrichedProperties);

    if (event === 'live_share_viewed') {
      try {
        const redis = await getRedisClient();
        const now = Date.now();
        await redis.incr('stats:total_viewers');
        await redis.zAdd('stats:viewers_24h', { score: now, value: id });
        await redis.zRemRangeByScore('stats:viewers_24h', 0, now - 24 * 60 * 60 * 1000);
      } catch (e) {
        console.error('Redis stats incr error:', e);
      }
    }

    return response.status(200).json({ success: true });
  } catch (error) {
    console.error('Telemetry proxy error:', error);
    return response.status(500).json({ error: 'Internal Server Error' });
  }
}

async function handleStats(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'GET') {
    return response.status(405).json({ error: 'Method Not Allowed' });
  }

  // Cache response on Vercel CDN edge for 6 hours (21600 seconds) as requested
  response.setHeader(
    'Cache-Control',
    'public, s-maxage=21600, stale-while-revalidate=3600'
  );

  try {
    const redis = await getRedisClient();
    const now = Date.now();
    const last24hTimestamp = now - 24 * 60 * 60 * 1000;

    // Clean up old entries from 24h sorted sets
    await Promise.all([
      redis.zRemRangeByScore('stats:shares_24h', 0, last24hTimestamp),
      redis.zRemRangeByScore('stats:viewers_24h', 0, last24hTimestamp),
    ]);

    const [totalSharesRaw, shares24hRaw, totalViewersRaw, viewers24hRaw, totalHoursRaw] =
      await Promise.all([
        redis.get('stats:total_shares'),
        redis.zCount('stats:shares_24h', last24hTimestamp, now),
        redis.get('stats:total_viewers'),
        redis.zCount('stats:viewers_24h', last24hTimestamp, now),
        redis.get('stats:total_hours'),
      ]);

    const totalShares = parseInt(totalSharesRaw || '0', 10);
    const shares24h = shares24hRaw || 0;
    const totalViewers = parseInt(totalViewersRaw || '0', 10);
    const viewers24h = viewers24hRaw || 0;
    const totalHoursShared = parseFloat(totalHoursRaw || '0');

    return response.status(200).json({
      shares24h,
      viewers24h,
      totalShares,
      totalViewers,
      totalHoursShared: Math.round(totalHoursShared * 10) / 10,
      updatedAt: new Date(now).toISOString(),
      validUntil: new Date(now + 6 * 60 * 60 * 1000).toISOString(),
    });
  } catch (error) {
    console.error('Error fetching telemetry stats:', error);
    const fallbackTime = Date.now();
    return response.status(200).json({
      shares24h: 0,
      viewers24h: 0,
      totalShares: 0,
      totalViewers: 0,
      totalHoursShared: 0,
      updatedAt: new Date(fallbackTime).toISOString(),
      validUntil: new Date(fallbackTime + 6 * 60 * 60 * 1000).toISOString(),
    });
  }
}
