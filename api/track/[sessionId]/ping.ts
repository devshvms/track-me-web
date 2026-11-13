import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getRedisClient } from '../../../lib/redis';

const MAX_CONCURRENT_VIEWERS = parseInt(process.env.MAX_CONCURRENT_VIEWERS || '10', 10);

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method Not Allowed' });
  }

  const { sessionId } = request.query;
  const { viewerId } = request.body || {};

  if (typeof sessionId !== 'string') {
    return response.status(400).json({ error: 'Missing or invalid sessionId' });
  }

  if (typeof viewerId !== 'string' || !viewerId) {
    return response.status(400).json({ error: 'Missing viewerId in body' });
  }

  try {
    const redis = await getRedisClient();
    
    // PAYLOAD & EGRESS OPTIMIZATION:
    // This endpoint is public and only verifies session existence.
    // Using redis.exists rather than redis.get avoids downloading the full session
    // JSON (which often contains 50-200 KB of coordinate breadcrumbs), cutting Redis egress
    // and network latency by >99% per presence ping on active rides.
    const sessionExists = await redis.exists(`session:${sessionId}`);
    if (!sessionExists) {
      return response.status(404).json({ error: 'Session not found or expired' });
    }

    const viewersKey = `session:${sessionId}:viewers`;
    const now = Date.now();
    
    // Remove viewers who haven't pinged in the last 40 seconds (polling is every 15s)
    await redis.zRemRangeByScore(viewersKey, 0, now - 40000);
    
    const isExistingViewer = await redis.zScore(viewersKey, viewerId);
    const currentViewerCount = await redis.zCard(viewersKey);

    if (isExistingViewer === null && currentViewerCount >= MAX_CONCURRENT_VIEWERS) {
       return response.status(429).json({ error: 'Maximum concurrent viewers reached for this session.' });
    }

    // Add or update the viewer's last ping timestamp
    await redis.zAdd(viewersKey, { score: now, value: viewerId });
    
    // COST & LATENCY OPTIMIZATION (Upstash Free-Tier Command Budget):
    // Only refresh the viewers set TTL when a new viewer joins (isExistingViewer === null).
    // For existing viewers pinging every 15s, the TTL is already established on the set,
    // so avoiding redundant redis.ttl + redis.expire network roundtrips eliminates ~2,400
    // unnecessary Redis commands per hour for a 5-viewer session.
    if (isExistingViewer === null) {
      try {
        const ttl = await redis.ttl(`session:${sessionId}`);
        if (ttl > 0) {
          await redis.expire(viewersKey, ttl);
        } else {
          // 24h safety TTL fallback if parent session TTL is indefinite or in test/dev
          await redis.expire(viewersKey, 86400);
        }
      } catch (ttlErr) {
        console.warn('Failed to set viewersKey expiration safely:', ttlErr);
      }
    }

    return response.status(200).json({ success: true, viewers: currentViewerCount });

  } catch (error) {
    console.error('Error handling ping:', error);
    return response.status(500).json({ error: 'Internal Server Error' });
  }
}
