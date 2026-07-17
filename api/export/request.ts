import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';
import { absoluteUrl } from '../../lib/http';
import { getRedisClient } from '../../lib/redis';
import { captureTelemetryEvent } from '../../lib/posthog';
import { assertOwnsUserId, requireUser, sendAuthError } from '../../lib/auth';

const EXPORT_TTL_SECONDS = 48 * 60 * 60;

function completedExportRequest(request: VercelRequest, data: any) {
  const now = new Date();
  const requestId = data.requestId || crypto.randomUUID();

  return {
    ...data,
    requestId,
    status: 'COMPLETED',
    completedAt: data.completedAt || now.toISOString(),
    expiresAt: data.expiresAt || new Date(Date.now() + EXPORT_TTL_SECONDS * 1000).toISOString(),
    downloadUrl: absoluteUrl(request, `/api/export/download?requestId=${requestId}`),
    message: 'Your historical data archive (.zip containing GPX traces and JSON metadata) is ready for download.',
  };
}

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const decoded = await requireUser(request);
    const { userId, userEmail, clientOS, exportFormats, metadata } = request.body || {};

    if (!userId || typeof userId !== 'string') {
      return response.status(401).json({
        error: 'Unauthorized: Authenticated userId is required to request data archive export.',
      });
    }
    assertOwnsUserId(decoded, userId);

    const redis = await getRedisClient();
    const userKey = `export:user:${userId}`;

    const existingRequestStr = await redis.get(userKey);
    if (existingRequestStr) {
      try {
        const existingRequest = JSON.parse(existingRequestStr);

        assertOwnsUserId(decoded, existingRequest.userId);

        if (existingRequest.status === 'QUEUED' || existingRequest.status === 'PROCESSING') {
          const normalizedRequest = completedExportRequest(request, existingRequest);
          delete normalizedRequest.archiveSizeBytes;

          await Promise.all([
            redis.set(userKey, JSON.stringify(normalizedRequest), { EX: EXPORT_TTL_SECONDS }),
            redis.set(`export:request:${normalizedRequest.requestId}`, JSON.stringify(normalizedRequest), { EX: EXPORT_TTL_SECONDS }),
            redis.zRem('export:queue', normalizedRequest.requestId),
          ]);

          return response.status(200).json({
            requestId: normalizedRequest.requestId,
            userId: normalizedRequest.userId,
            status: 'COMPLETED',
            completedAt: normalizedRequest.completedAt,
            downloadUrl: normalizedRequest.downloadUrl,
            expiresAt: normalizedRequest.expiresAt,
            retentionPolicy: 'Archive expires 6 hours after retrieval (max 48 hours unaccessed).',
            message: normalizedRequest.message,
          });
        }

        if (existingRequest.status === 'COMPLETED') {
          const now = Date.now();
          const expiresAtMs = existingRequest.expiresAt
            ? new Date(existingRequest.expiresAt).getTime()
            : now + 48 * 60 * 60 * 1000;

          // If archive has expired (>48h uncalled or >6h after download accessed), delete and allow new request
          if (expiresAtMs <= now) {
            await Promise.all([
              redis.del(userKey),
              redis.del(`export:request:${existingRequest.requestId}`),
            ]);
          } else {
            return response.status(200).json({
              requestId: existingRequest.requestId,
              userId: existingRequest.userId,
              status: 'COMPLETED',
              completedAt: existingRequest.completedAt || existingRequest.requestedAt,
              downloadAccessedAt: existingRequest.downloadAccessedAt,
              downloadUrl:
                existingRequest.downloadUrl && /^https?:\/\//i.test(existingRequest.downloadUrl)
                  ? existingRequest.downloadUrl
                  : absoluteUrl(request, existingRequest.downloadUrl || `/api/export/download?requestId=${existingRequest.requestId}`),
              expiresAt: existingRequest.expiresAt,
              retentionPolicy: 'Archive expires 6 hours after retrieval (max 48 hours unaccessed).',
              message: 'Your historical data archive (.zip containing GPX traces and JSON metadata) is ready for download.',
            });
          }
        }
      } catch (err) {
        console.warn('Could not parse existing user export request, creating new one.', err);
      }
    }

    const requestId = crypto.randomUUID();
    const now = new Date();

    const exportRequest = completedExportRequest(request, {
      requestId,
      userId,
      userEmail: userEmail || decoded.email || `${userId}@trackme.user`,
      requestedAt: now.toISOString(),
      clientOS: clientOS || 'Web',
      exportFormats: Array.isArray(exportFormats) ? exportFormats : ['GPX', 'JSON_ARCHIVE'],
      metadata: {
        appVersion: metadata?.appVersion || '1.3.0',
      },
    });

    await Promise.all([
      redis.set(userKey, JSON.stringify(exportRequest), { EX: EXPORT_TTL_SECONDS }),
      redis.set(`export:request:${requestId}`, JSON.stringify(exportRequest), { EX: EXPORT_TTL_SECONDS }),
      redis.zRem('export:queue', requestId),
    ]);

    await captureTelemetryEvent(userId, 'data_export_requested', {
      requestId,
      userId,
      clientOS: exportRequest.clientOS,
      exportFormats: exportRequest.exportFormats,
    });

    return response.status(200).json({
      requestId,
      userId,
      status: 'COMPLETED',
      requestedAt: exportRequest.requestedAt,
      completedAt: exportRequest.completedAt,
      downloadUrl: exportRequest.downloadUrl,
      expiresAt: exportRequest.expiresAt,
      retentionPolicy: 'Archive expires 6 hours after retrieval (max 48 hours unaccessed).',
      message: exportRequest.message,
    });
  } catch (error) {
    if (sendAuthError(response, error)) return;
    console.error('Error handling data export request:', error);
    return response.status(500).json({ error: 'Internal Server Error' });
  }
}
