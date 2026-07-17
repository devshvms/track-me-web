import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getRedisClient } from '../../../lib/redis';
import { AuthError, requireUser, sendAuthError } from '../../../lib/auth';

const MAX_CONCURRENT_VIEWERS = parseInt(process.env.MAX_CONCURRENT_VIEWERS || '10', 10);

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
      if (typeof viewerId !== 'string' || !viewerId) {
         return response.status(400).json({ error: 'Missing viewerId' });
      }

      const viewersKey = `session:${sessionId}:viewers`;
      const now = Date.now();
      
      // Remove viewers who haven't pinged in the last 15 seconds (polling is every 5s)
      await redis.zRemRangeByScore(viewersKey, 0, now - 15000);
      
      const isExistingViewer = await redis.zScore(viewersKey, viewerId);
      const currentViewerCount = await redis.zCard(viewersKey);

      if (isExistingViewer === null && currentViewerCount >= MAX_CONCURRENT_VIEWERS) {
         return response.status(429).json({ error: 'Maximum concurrent viewers reached for this session.' });
      }

      // Add or update the viewer's last ping timestamp
      await redis.zAdd(viewersKey, { score: now, value: viewerId });
      
      // Ensure the viewers list expires when the session expires
      const ttl = await redis.ttl(`session:${sessionId}`);
      if (ttl > 0) {
        await redis.expire(viewersKey, ttl);
      }

      return response.status(200).json(sessionData);
    } 
    
    if (request.method === 'POST') {
      const decoded = await requireUser(request);
      if (sessionData.ownerUid && sessionData.ownerUid !== decoded.uid) {
        throw new AuthError(403, 'Forbidden. You do not own this live share session.');
      }

      const { lat, lon, batteryLevel, speed, heading, timestamp } = request.body || {};
      
      if (lat === undefined || lon === undefined) {
        return response.status(400).json({ error: 'Missing lat or lon in body' });
      }

      sessionData.lastLocation = {
        lat,
        lon,
        batteryLevel,
        speed,
        heading,
        timestamp: timestamp || new Date().toISOString()
      };

      const ttl = await redis.ttl(`session:${sessionId}`);
      if (ttl > 0) {
        await redis.set(`session:${sessionId}`, JSON.stringify(sessionData), {
          EX: ttl
        });
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
