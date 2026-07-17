import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getRedisClient, redisMGet } from '../../lib/redis';
import { requireAdmin, sendAuthError } from '../../lib/auth';

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  if (request.method !== 'GET') {
    return response.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    await requireAdmin(request);
    const redis = await getRedisClient();
    
    const keys = await redis.keys('export:user:*');
    
    let queued = 0;
    let processing = 0;
    let completed = 0;

    if (keys.length > 0) {
      const values = await redisMGet(redis, keys);
      
      if (Array.isArray(values)) {
        for (const valStr of values) {
          if (typeof valStr !== 'string') continue;
          try {
              const data = JSON.parse(valStr);
              if (data.status === 'QUEUED') queued++;
              else if (data.status === 'PROCESSING') processing++;
              else if (data.status === 'COMPLETED') completed++;
          } catch (e) {
              continue;
          }
        }
      }
    }

    return response.status(200).json({
      queued,
      processing,
      completed
    });

  } catch (error: any) {
    if (sendAuthError(response, error)) return;
    console.error('Error fetching export metrics:', error);
    return response.status(500).json({ error: 'Internal server error' });
  }
}
