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
    
    const viewersKey = `session:${cleanSessionId}:viewers`;
    const now = Date.now();
    const cutoff = now - STALE_VIEWER_WINDOW_MS;
    
    let isExistingViewer: number | null = null;
    let currentViewerCount = 0;

    // PIPELINED SESSION EXISTENCE & VIEWER CAPACITY CHECK ($0/mo Free-Tier Command Budget):
    // Check session existence, prune stale viewers, check membership, and count active viewers
    // in a single atomic roundtrip via multi() when supported (CIE-017).
    if (typeof redis.multi === 'function') {
      const multi = redis.multi();
      multi.exists(`session:${cleanSessionId}`);
      multi.zRemRangeByScore(viewersKey, 0, cutoff);
      multi.zScore(viewersKey, cleanViewerId);
      multi.zCard(viewersKey);
      const results = await multi.exec();
      // results[0] = exists count (1 if active/exists, 0 if missing/expired)
      // results[1] = removed count
      // results[2] = zScore result (number or null)
      // results[3] = zCard count (number)
      const sessionExists = Boolean(results?.[0]);
      if (!sessionExists) {
        return response.status(404).json({ error: 'Session not found or expired' });
      }
      isExistingViewer = results?.[2] !== undefined ? results[2] : null;
      currentViewerCount = typeof results?.[3] === 'number' ? results[3] : 0;
    } else {
      const sessionExists = await redis.exists(`session:${cleanSessionId}`);
      if (!sessionExists) {
        return response.status(404).json({ error: 'Session not found or expired' });
      }
      await redis.zRemRangeByScore(viewersKey, 0, cutoff);
      isExistingViewer = await redis.zScore(viewersKey, cleanViewerId);
      currentViewerCount = await redis.zCard(viewersKey);
    }

    if (isExistingViewer === null && currentViewerCount >= MAX_CONCURRENT_VIEWERS) {
      return response.status(429).json({ error: 'Maximum concurrent viewers reached for this session.' });
    }

    // COST & LATENCY OPTIMIZATION (Upstash Free-Tier Command Budget):
    // When a new viewer joins (isExistingViewer === null), query session TTL and pipeline
    // zAdd + expire in a single roundtrip.
    // For existing viewers (99% of requests), only zAdd is called, and TTL is preserved.
    if (isExistingViewer === null) {
      try {
        const ttl = await redis.ttl(`session:${cleanSessionId}`);
        const finalSetTtl = ttl > 0 ? ttl : 86400;
        if (typeof redis.multi === 'function') {
          const multi = redis.multi();
          multi.zAdd(viewersKey, { score: now, value: cleanViewerId });
          multi.expire(viewersKey, finalSetTtl);
          await multi.exec();
        } else {
          await redis.zAdd(viewersKey, { score: now, value: cleanViewerId });
          await redis.expire(viewersKey, finalSetTtl);
        }
      } catch (ttlErr) {
        console.warn('Failed to set viewersKey expiration safely:', ttlErr);
        await redis.zAdd(viewersKey, { score: now, value: cleanViewerId });
      }
    } else {
      await redis.zAdd(viewersKey, { score: now, value: cleanViewerId });
    }

    const activeCount = isExistingViewer === null ? currentViewerCount + 1 : currentViewerCount;
    return response.status(200).json({ success: true, viewers: activeCount });

  } catch (error) {
    console.error('Error handling ping:', error);
    return response.status(500).json({ error: 'Internal Server Error' });
  }
}
