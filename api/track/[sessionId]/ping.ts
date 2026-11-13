import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getRedisClient } from '../../../lib/redis';

export const MAX_CONCURRENT_VIEWERS = parseInt(process.env.MAX_CONCURRENT_VIEWERS || '10', 10);
export const STALE_VIEWER_WINDOW_MS = 40_000; // 40s prune cutoff (clients ping every 15s)
export const MAX_VIEWER_ID_LENGTH = 128;

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method Not Allowed' });
  }

  const { sessionId } = request.query;
  const { viewerId } = request.body || {};

  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    return response.status(400).json({ error: 'Missing or invalid sessionId' });
  }

  if (typeof viewerId !== 'string' || !viewerId.trim()) {
    return response.status(400).json({ error: 'Missing viewerId in body' });
  }

  const cleanSessionId = sessionId.trim();
  const cleanViewerId = viewerId.trim().slice(0, MAX_VIEWER_ID_LENGTH);

  try {
    const redis = await getRedisClient();
    
    // PAYLOAD & EGRESS OPTIMIZATION:
    // This endpoint is public and only verifies session existence.
    // Using redis.exists rather than redis.get avoids downloading the full session
    // JSON (which often contains 50-200 KB of coordinate breadcrumbs), cutting Redis egress
    // and network latency by >99% per presence ping on active rides.
    const sessionExists = await redis.exists(`session:${cleanSessionId}`);
    if (!sessionExists) {
      return response.status(404).json({ error: 'Session not found or expired' });
    }

    const viewersKey = `session:${cleanSessionId}:viewers`;
    const now = Date.now();
    const cutoff = now - STALE_VIEWER_WINDOW_MS;
    
    let isExistingViewer: number | null = null;
    let currentViewerCount = 0;

    // PIPELINED VIEWER CAPACITY CHECK ($0/mo Free-Tier Command Budget):
    // Prune stale viewers, check membership, and count active viewers in a single roundtrip via multi().
    if (typeof redis.multi === 'function') {
      const multi = redis.multi();
      multi.zRemRangeByScore(viewersKey, 0, cutoff);
      multi.zScore(viewersKey, cleanViewerId);
      multi.zCard(viewersKey);
      const results = await multi.exec();
      // results[0] = removed count
      // results[1] = zScore result (number or null)
      // results[2] = zCard count (number)
      isExistingViewer = results?.[1] !== undefined ? results[1] : null;
      currentViewerCount = typeof results?.[2] === 'number' ? results[2] : 0;
    } else {
      await redis.zRemRangeByScore(viewersKey, 0, cutoff);
      isExistingViewer = await redis.zScore(viewersKey, cleanViewerId);
      currentViewerCount = await redis.zCard(viewersKey);
    }

    if (isExistingViewer === null && currentViewerCount >= MAX_CONCURRENT_VIEWERS) {
      return response.status(429).json({ error: 'Maximum concurrent viewers reached for this session.' });
    }

    // Add or update the viewer's last ping timestamp
    await redis.zAdd(viewersKey, { score: now, value: cleanViewerId });
    
    // COST & LATENCY OPTIMIZATION (Upstash Free-Tier Command Budget):
    // Only refresh the viewers set TTL when a new viewer joins (isExistingViewer === null).
    // For existing viewers pinging every 15s, the TTL is already established on the set,
    // avoiding redundant redis.ttl + redis.expire network roundtrips.
    if (isExistingViewer === null) {
      try {
        const ttl = await redis.ttl(`session:${cleanSessionId}`);
        const finalSetTtl = ttl > 0 ? ttl : 86400;
        await redis.expire(viewersKey, finalSetTtl);
      } catch (ttlErr) {
        console.warn('Failed to set viewersKey expiration safely:', ttlErr);
      }
    }

    const activeCount = isExistingViewer === null ? currentViewerCount + 1 : currentViewerCount;
    return response.status(200).json({ success: true, viewers: activeCount });

  } catch (error) {
    console.error('Error handling ping:', error);
    return response.status(500).json({ error: 'Internal Server Error' });
  }
}
