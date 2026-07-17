import type { VercelRequest, VercelResponse } from '@vercel/node';
import { captureTelemetryEvent } from '../../lib/posthog';
import { getRedisClient } from '../../lib/redis';

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
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
