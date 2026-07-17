import type { VercelRequest, VercelResponse } from '@vercel/node';
import { absoluteUrl } from '../../lib/http';
import { getRedisClient, redisMGet } from '../../lib/redis';
import { requireAdmin, sendAuthError } from '../../lib/auth';

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  if (request.method !== 'POST' && request.method !== 'GET') {
    return response.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    await requireAdmin(request);
    const redis = await getRedisClient();
    const keys = await redis.keys('export:user:*');

    let processedCount = 0;
    const now = new Date();

    if (keys && keys.length > 0) {
      const values = await redisMGet(redis, keys);

      if (Array.isArray(values)) {
        for (let i = 0; i < values.length; i++) {
          const valStr = values[i];
          if (typeof valStr !== 'string') continue;

          try {
            const data = JSON.parse(valStr);
            if (data && (data.status === 'QUEUED' || data.status === 'PROCESSING')) {
              const completedAt = new Date().toISOString();
              const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

              data.status = 'COMPLETED';
              data.completedAt = completedAt;
              data.expiresAt = expiresAt;
              delete data.archiveSizeBytes;
              data.downloadUrl = absoluteUrl(request, `/api/export/download?requestId=${data.requestId}`);

              const userKey = keys[i];
              const requestKey = `export:request:${data.requestId}`;

              await Promise.all([
                redis.set(userKey, JSON.stringify(data), { EX: 48 * 60 * 60 }),
                redis.set(requestKey, JSON.stringify(data), { EX: 48 * 60 * 60 }),
                redis.zRem('export:queue', data.requestId)
              ]);

              processedCount++;
            }
          } catch (e) {
            console.error('Error processing export entry:', e);
          }
        }
      }
    }

    return response.status(200).json({
      success: true,
      processedCount,
      message: `Successfully processed ${processedCount} queued export requests into COMPLETED state.`,
      timestamp: now.toISOString(),
    });
  } catch (error) {
    if (sendAuthError(response, error)) return;
    console.error('Error in export batch processing:', error);
    return response.status(500).json({ error: 'Internal Server Error while processing export queue.' });
  }
}
