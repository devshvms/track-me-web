import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getRedisClient } from '../../../lib/redis';
import { AuthError, requireUser, sendAuthError } from '../../../lib/auth';


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
      // Allow Vercel Edge to cache this response across all viewers for 2 seconds.
      // If 10k users poll every 5s, the edge cache absorbs 99.9% of the traffic.
      response.setHeader('Cache-Control', 's-maxage=2, stale-while-revalidate');

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
