import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';
import { getRedisClient, redisMGet } from '../../lib/redis';
import { auth, db } from '../../lib/firebase';
import { assertOwnsUserId, requireUser, sendAuthError, requireAdmin } from '../../lib/auth';
import { escapeXml, finiteCoordinate, isoTimestamp } from '../../lib/exportXml';
import { absoluteUrl } from '../../lib/http';
import { captureTelemetryEvent } from '../../lib/posthog';

const EXPORT_TTL_SECONDS = 48 * 60 * 60;

// Shared helper functions

function getDownloadToken(data: any): string {
  return typeof data.downloadToken === 'string' && data.downloadToken.length >= 32
    ? data.downloadToken
    : crypto.randomBytes(32).toString('base64url');
}

function hasValidDownloadToken(data: any, token: unknown): boolean {
  return typeof token === 'string'
    && typeof data.downloadToken === 'string'
    && data.downloadToken.length >= 32
    && token === data.downloadToken;
}

function downloadPath(requestId: string, token: string): string {
  return `/api/export/download?${new URLSearchParams({ requestId, token }).toString()}`;
}

function completedExportRequest(request: VercelRequest, data: any) {
  const now = new Date();
  const requestId = data.requestId || crypto.randomUUID();
  const token = getDownloadToken(data);

  return {
    ...data,
    requestId,
    downloadToken: token,
    status: 'COMPLETED',
    completedAt: data.completedAt || now.toISOString(),
    expiresAt: data.expiresAt || new Date(Date.now() + EXPORT_TTL_SECONDS * 1000).toISOString(),
    downloadUrl: absoluteUrl(request, downloadPath(requestId, token)),
    message: 'Your historical data archive (.zip containing GPX traces and JSON metadata) is ready for download.',
  };
}

function markCompleted(request: VercelRequest, exportRequest: any) {
  const now = new Date();
  const token = getDownloadToken(exportRequest);
  exportRequest.status = 'COMPLETED';
  exportRequest.completedAt = exportRequest.completedAt || now.toISOString();
  exportRequest.expiresAt = exportRequest.expiresAt || new Date(Date.now() + EXPORT_TTL_SECONDS * 1000).toISOString();
  exportRequest.downloadToken = token;
  delete exportRequest.archiveSizeBytes;
  exportRequest.downloadUrl = absoluteUrl(request, downloadPath(exportRequest.requestId, token));
  exportRequest.message = 'Your historical data archive (.zip containing GPX traces and JSON metadata) is ready for download.';
  return exportRequest;
}

// Handler implementations

async function handleDownload(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'GET') {
    return response.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { requestId, userId, token } = request.query;

    if (!requestId && !userId) {
      return response.status(400).json({ error: 'Missing requestId or userId parameter.' });
    }

    const redis = await getRedisClient();
    let requestDataStr: string | null = null;

    if (typeof requestId === 'string') {
      requestDataStr = await redis.get(`export:request:${requestId}`);
    } else if (typeof userId === 'string') {
      requestDataStr = await redis.get(`export:user:${userId}`);
    }

    if (!requestDataStr) {
      return response.status(404).json({ error: 'Archive export request not found.' });
    }

    const data = JSON.parse(requestDataStr);

    if (!hasValidDownloadToken(data, token)) {
      const decoded = await requireUser(request);
      assertOwnsUserId(decoded, data.userId);
    }

    if (data.status !== 'COMPLETED') {
      return response.status(400).json({
        error: 'Archive is currently processing or queued. Please wait until status is COMPLETED.',
        status: data.status,
      });
    }

    const now = Date.now();
    const expiresAtMs = data.expiresAt ? new Date(data.expiresAt).getTime() : now + 48 * 60 * 60 * 1000;

    if (expiresAtMs <= now) {
      if (data.userId) await redis.del(`export:user:${data.userId}`);
      if (data.requestId) await redis.del(`export:request:${data.requestId}`);
      return response.status(410).json({ error: 'This archive has expired and was permanently deleted from server storage. Please request a new export.' });
    }

    if (!db) {
      return response.status(503).json({
        error: 'Archive export is temporarily unavailable because Firestore is not configured.',
      });
    }

    let firstDownload = !data.downloadAccessedAt;
    const downloadExpiry = firstDownload
      ? new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString()
      : data.expiresAt;

    let userData: Record<string, unknown>;
    try {
      const userDoc = await db.collection('users').doc(data.userId).get();
      userData = userDoc.exists ? userDoc.data() || {} : {};

      if (!userDoc.exists && auth) {
        try {
          const authUser = await auth.getUser(data.userId);
          userData = {
            uid: authUser.uid,
            email: authUser.email || data.userEmail || null,
            displayName: authUser.displayName || null,
            photoURL: authUser.photoURL || null,
            phoneNumber: authUser.phoneNumber || null,
            createdAt: authUser.metadata.creationTime || null,
            lastLoginAt: authUser.metadata.lastSignInTime || null,
            profileSource: 'firebase_auth',
          };
        } catch {
          userData = {
            uid: data.userId,
            email: data.userEmail || null,
            profileSource: 'export_request',
          };
        }
      }
    } catch (err) {
      console.error('Error fetching user from Firestore:', err);
      return response.status(502).json({
        error: 'Unable to read user data from Firestore. Archive export was not generated.',
      });
    }

    const metadata: any = {
      archiveId: data.requestId,
      userEmail: (userData as any).email || data.userEmail || `${data.userId}@trackme.user`,
      userId: data.userId,
      generatedAt: data.completedAt || new Date().toISOString(),
      expiresAt: downloadExpiry,
      retentionPolicy: 'Archive files expire 6 hours after retrieval (or max 48 hours unaccessed).',
      platformVersion: 'TrackMe Mobile & Web v1.5.0',
      profile: userData,
    };

    const metadataOtherCollections: Record<string, any> = {};
    try {
      const emergencyConfigSnapshot = await db.collection('users').doc(data.userId).collection('emergency_config').get();
      if (!emergencyConfigSnapshot.empty) {
        metadataOtherCollections['emergency_config'] = {};
        for (const doc of emergencyConfigSnapshot.docs) {
          metadataOtherCollections['emergency_config'][doc.id] = doc.data();
        }
      }
    } catch (err) {
      console.error('Error fetching emergency_config:', err);
      return response.status(502).json({
        error: 'Unable to read archive data (emergency_config) from Firestore. Archive export was not generated.',
      });
    }
    metadata.otherCollections = metadataOtherCollections;

    // Set up headers for streaming ZIP download
    response.setHeader('Content-Type', 'application/zip');
    response.setHeader('Content-Disposition', `attachment; filename="TrackMe_Archive_${data.userId}.zip"`);

    // Create archiver instance
    const archiver = require('archiver');
    const archive = archiver('zip', {
      zlib: { level: 6 } // moderate compression to save CPU/memory
    });

    archive.on('error', (err: Error) => {
      console.error('Archiver error:', err);
      if (!response.headersSent) {
        response.status(500).json({ error: 'Internal Server Error while assembling archive.' });
      } else {
        response.end();
      }
    });

    // Pipe archive data directly to VercelResponse (which is a Writable Stream)
    archive.pipe(response);

    // Append metadata.json
    archive.append(JSON.stringify(metadata, null, 2), { name: 'metadata.json' });

    // Stream rides and build rides_history.json summary
    const ridesSummary: any[] = [];

    try {
      const ridesRef = db.collection('users').doc(data.userId).collection('rides');
      // Stream documents one by one to prevent loading everything into memory
      const stream = ridesRef.stream();

      for await (const doc of stream as any) {
        const ride = doc.data();
        ridesSummary.push({
          rideId: doc.id,
          title: ride.title || `Ride ${doc.id}`,
          startTime: ride.startTime ? new Date(ride.startTime).toISOString() : new Date().toISOString(),
          endTime: ride.endTime ? new Date(ride.endTime).toISOString() : null,
          distanceKm: ride.distance || 0,
          avgSpeedKmh: ride.avgSpeed || 0,
          maxSpeedKmh: ride.maxSpeed || 0,
          pauseDuration: ride.pauseDuration || 0,
          sourceInfo: ride.sourceInfo || 'Cloud Sync',
          persona: ride.persona || 'AUTO',
        });

        let trkpts = '';
        const pointsSnapshot = await doc.ref.collection('points').orderBy('timestamp').get();
        const points = pointsSnapshot.empty ? (ride.points || []) : pointsSnapshot.docs.map((p: any) => p.data());

        if (Array.isArray(points)) {
          for (const loc of points) {
            const lat = loc.lat ?? loc.latitude;
            const lng = loc.lng ?? loc.longitude;
            const ele = loc.altitude !== undefined ? `\n        <ele>${finiteCoordinate(loc.altitude)}</ele>` : '';
            const timestamp = isoTimestamp(loc.timestamp);
            const time = timestamp ? `\n        <time>${timestamp}</time>` : '';
            const speed = loc.speed !== undefined ? `\n        <speed>${finiteCoordinate(loc.speed)}</speed>` : '';
            trkpts += `      <trkpt lat="${finiteCoordinate(lat)}" lon="${finiteCoordinate(lng)}">${ele}${time}${speed}\n      </trkpt>\n`;
          }
        }

        const title = escapeXml(ride.title || `Ride Trace Archive - ${doc.id}`);
        const summaryTitle = escapeXml(ride.title || `Ride ${doc.id}`);
        const startTimestamp = isoTimestamp(ride.startTime) || new Date().toISOString();
        const gpxTrace = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TrackMe v1.5.0">
  <metadata>
    <name>${title}</name>
    <time>${startTimestamp}</time>
  </metadata>
  <trk>
    <name>${summaryTitle}</name>
    <trkseg>
${trkpts}    </trkseg>
</trk>
</gpx>`;
        // Append GPX file for each ride
        archive.append(gpxTrace, { name: `traces/ride_${doc.id}.gpx` });
      }

      // Append the summary after iterating all rides
      archive.append(JSON.stringify(ridesSummary, null, 2), { name: 'rides_history.json' });

    } catch (err) {
      console.error('Error streaming rides from Firestore:', err);
      archive.append('Error reading rides from Firestore mid-stream. The archive may be incomplete.', { name: 'EXPORT_FAILED.txt' });
      firstDownload = false; // Prevent setting downloadAccessedAt if archive failed mid-stream
    } finally {
      // Finalize the archive (closes the stream)
      await archive.finalize();

      if (firstDownload) {
        data.downloadAccessedAt = new Date().toISOString();
        data.expiresAt = downloadExpiry;

        const ttlSeconds = 6 * 60 * 60;
        await Promise.all([
          data.userId ? redis.set(`export:user:${data.userId}`, JSON.stringify(data), { EX: ttlSeconds }) : Promise.resolve(),
          data.requestId ? redis.set(`export:request:${data.requestId}`, JSON.stringify(data), { EX: ttlSeconds }) : Promise.resolve(),
        ]);
      }
    }
  } catch (error) {
    if (sendAuthError(response, error)) return;
    console.error('Error generating archive download:', error);
    if (!response.headersSent) {
      return response.status(500).json({ error: 'Internal Server Error while assembling archive.' });
    }
  }
}

async function handleProcess(request: VercelRequest, response: VercelResponse) {
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
              data.downloadToken = getDownloadToken(data);
              delete data.archiveSizeBytes;
              data.downloadUrl = absoluteUrl(request, `/api/export/download?${new URLSearchParams({
                requestId: data.requestId,
                token: data.downloadToken,
              }).toString()}`);

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

async function handleRequest(request: VercelRequest, response: VercelResponse) {
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
            const normalizedRequest = completedExportRequest(request, existingRequest);
            delete normalizedRequest.archiveSizeBytes;

            await Promise.all([
              redis.set(userKey, JSON.stringify(normalizedRequest), { EX: Math.max(1, Math.floor((expiresAtMs - now) / 1000)) }),
              redis.set(`export:request:${normalizedRequest.requestId}`, JSON.stringify(normalizedRequest), { EX: Math.max(1, Math.floor((expiresAtMs - now) / 1000)) }),
            ]);

            return response.status(200).json({
              requestId: normalizedRequest.requestId,
              userId: normalizedRequest.userId,
              status: 'COMPLETED',
              completedAt: normalizedRequest.completedAt || normalizedRequest.requestedAt,
              downloadAccessedAt: normalizedRequest.downloadAccessedAt,
              downloadUrl: normalizedRequest.downloadUrl,
              expiresAt: normalizedRequest.expiresAt,
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

async function handleStatus(request: VercelRequest, response: VercelResponse) {
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

export default async function handler(request: VercelRequest, response: VercelResponse) {
  let actionStr: string | undefined;
  if (Array.isArray(request.query.action)) {
    actionStr = request.query.action[0];
  } else {
    actionStr = request.query.action;
  }

  switch (actionStr) {
    case 'download': return handleDownload(request, response);
    case 'process': return handleProcess(request, response);
    case 'request': return handleRequest(request, response);
    case 'status': return handleStatus(request, response);
    default: return response.status(404).json({ error: 'Not Found' });
  }
}
