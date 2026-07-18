import type { VercelRequest, VercelResponse } from '@vercel/node';
import { captureTelemetryEvent } from '../lib/posthog';
import { getRedisClient } from '../lib/redis';

// Single function serving /api/telemetry/event and /api/telemetry/stats via
// the vercel.json rewrite that maps /api/telemetry/:route to ?route=:route.
// Consolidated to stay within the Hobby-plan serverless function limit.
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
  return response.status(404).json({ error: 'Not Found' });
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
