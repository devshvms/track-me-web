import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';
import { absoluteUrl } from '../../lib/http';
import { getRedisClient } from '../../lib/redis';
import { assertOwnsUserId, requireUser, sendAuthError } from '../../lib/auth';

const EXPORT_TTL_SECONDS = 48 * 60 * 60;

function downloadToken(exportRequest: any): string {
  return typeof exportRequest.downloadToken === 'string' && exportRequest.downloadToken.length >= 32
    ? exportRequest.downloadToken
    : crypto.randomBytes(32).toString('base64url');
}

function downloadPath(requestId: string, token: string): string {
  return `/api/export/download?${new URLSearchParams({ requestId, token }).toString()}`;
}

function markCompleted(request: VercelRequest, exportRequest: any) {
  const now = new Date();
  const token = downloadToken(exportRequest);
  exportRequest.status = 'COMPLETED';
  exportRequest.completedAt = exportRequest.completedAt || now.toISOString();
  exportRequest.expiresAt = exportRequest.expiresAt || new Date(Date.now() + EXPORT_TTL_SECONDS * 1000).toISOString();
  exportRequest.downloadToken = token;
  delete exportRequest.archiveSizeBytes;
  exportRequest.downloadUrl = absoluteUrl(request, downloadPath(exportRequest.requestId, token));
  exportRequest.message = 'Your historical data archive (.zip containing GPX traces and JSON metadata) is ready for download.';
  return exportRequest;
}

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  if (request.method !== 'GET') {
    return response.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const decoded = await requireUser(request);
    const { userId, requestId } = request.query;

    if (!userId && !requestId) {
      return response.status(400).json({
        error: 'Missing query parameter: userId or requestId is required.',
      });
    }

    const redis = await getRedisClient();
    let requestDataStr: string | null = null;

    if (typeof userId === 'string') {
      assertOwnsUserId(decoded, userId);
      requestDataStr = await redis.get(`export:user:${userId}`);
    } else if (typeof requestId === 'string') {
      requestDataStr = await redis.get(`export:request:${requestId}`);
    }

    if (!requestDataStr) {
      return response.status(404).json({
        error: 'Data export request not found.',
      });
    }

    const exportRequest = JSON.parse(requestDataStr);
    assertOwnsUserId(decoded, exportRequest.userId);

    if (exportRequest.status === 'QUEUED' || exportRequest.status === 'PROCESSING') {
      markCompleted(request, exportRequest);

      const userKey = exportRequest.userId ? `export:user:${exportRequest.userId}` : null;
      const reqKey = exportRequest.requestId ? `export:request:${exportRequest.requestId}` : null;

      await Promise.all([
        userKey ? redis.set(userKey, JSON.stringify(exportRequest), { EX: EXPORT_TTL_SECONDS }) : Promise.resolve(),
        reqKey ? redis.set(reqKey, JSON.stringify(exportRequest), { EX: EXPORT_TTL_SECONDS }) : Promise.resolve(),
        exportRequest.requestId ? redis.zRem('export:queue', exportRequest.requestId) : Promise.resolve(),
      ]);
    }

    if (exportRequest.status === 'COMPLETED') {
      markCompleted(request, exportRequest);

      const userKey = exportRequest.userId ? `export:user:${exportRequest.userId}` : null;
      const reqKey = exportRequest.requestId ? `export:request:${exportRequest.requestId}` : null;
      const expiresAtMs = exportRequest.expiresAt
        ? new Date(exportRequest.expiresAt).getTime()
        : Date.now() + EXPORT_TTL_SECONDS * 1000;
      const ttlSeconds = Math.max(1, Math.floor((expiresAtMs - Date.now()) / 1000));

      await Promise.all([
        userKey ? redis.set(userKey, JSON.stringify(exportRequest), { EX: ttlSeconds }) : Promise.resolve(),
        reqKey ? redis.set(reqKey, JSON.stringify(exportRequest), { EX: ttlSeconds }) : Promise.resolve(),
      ]);
    }

    return response.status(200).json(exportRequest);
  } catch (error) {
    if (sendAuthError(response, error)) return;
    console.error('Error fetching data export status:', error);
    return response.status(500).json({ error: 'Internal Server Error' });
  }
}
