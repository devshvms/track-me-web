import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createReadStream, createWriteStream } from 'fs';
import { mkdtemp, rm, stat } from 'fs/promises';
import os from 'os';
import path from 'path';
import { getRedisClient } from '../../lib/redis';
import { auth, db } from '../../lib/firebase';
import { assertOwnsUserId, requireUser, sendAuthError } from '../../lib/auth';

function hasValidDownloadToken(data: any, token: unknown): boolean {
  return typeof token === 'string'
    && typeof data.downloadToken === 'string'
    && data.downloadToken.length >= 32
    && token === data.downloadToken;
}

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
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

    const firstDownload = !data.downloadAccessedAt;
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

    // Stage the ZIP before sending response headers. Vercel's temporary filesystem
    // keeps the archive out of memory while preserving a structured error path.
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'trackme-export-'));
    const archivePath = path.join(tempDir, `TrackMe_Archive_${data.userId}.zip`);
    const archiver = require('archiver');
    const archive = archiver('zip', {
      zlib: { level: 6 },
    });
    const output = createWriteStream(archivePath);

    try {
      const archiveWritten = new Promise<void>((resolve, reject) => {
        archive.once('error', reject);
        output.once('error', reject);
        output.once('close', resolve);
      });

      archive.pipe(output);
      archive.append(JSON.stringify(metadata, null, 2), { name: 'metadata.json' });

      const ridesSummary: any[] = [];
      const ridesRef = db.collection('users').doc(data.userId).collection('rides');
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
        if (Array.isArray(ride.points)) {
          for (const loc of ride.points) {
            const ele = loc.altitude !== undefined ? `\n        <ele>${loc.altitude}</ele>` : '';
            const time = loc.timestamp ? `\n        <time>${new Date(loc.timestamp).toISOString()}</time>` : '';
            const speed = loc.speed !== undefined ? `\n        <speed>${loc.speed}</speed>` : '';
            trkpts += `      <trkpt lat="${loc.lat || 0}" lon="${loc.lng || 0}">${ele}${time}${speed}\n      </trkpt>\n`;
          }
        }

        const gpxTrace = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="TrackMe v1.5.0">
  <metadata>
    <name>${ride.title || `Ride Trace Archive - ${doc.id}`}</name>
    <time>${ride.startTime ? new Date(ride.startTime).toISOString() : new Date().toISOString()}</time>
  </metadata>
  <trk>
    <name>${ride.title || `Ride ${doc.id}`}</name>
    <trkseg>
${trkpts}    </trkseg>
  </trk>
</gpx>`;
        archive.append(gpxTrace, { name: `traces/ride_${doc.id}.gpx` });
      }

      archive.append(JSON.stringify(ridesSummary, null, 2), { name: 'rides_history.json' });
      await archive.finalize();
      await archiveWritten;

      const archiveStats = await stat(archivePath);
      response.setHeader('Content-Type', 'application/zip');
      response.setHeader('Content-Length', archiveStats.size.toString());
      response.setHeader('Content-Disposition', `attachment; filename="TrackMe_Archive_${data.userId}.zip"`);

      let responseFinished = false;
      await new Promise<void>((resolve, reject) => {
        const input = createReadStream(archivePath);
        let settled = false;
        const finish = () => {
          if (!settled) {
            settled = true;
            responseFinished = true;
            resolve();
          }
        };
        const close = () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        };
        input.once('error', reject);
        response.once('finish', finish);
        response.once('close', close);
        input.pipe(response);
      });

      if (firstDownload && responseFinished) {
        data.downloadAccessedAt = new Date().toISOString();
        data.expiresAt = downloadExpiry;

        const ttlSeconds = 6 * 60 * 60;
        await Promise.all([
          data.userId ? redis.set(`export:user:${data.userId}`, JSON.stringify(data), { EX: ttlSeconds }) : Promise.resolve(),
          data.requestId ? redis.set(`export:request:${data.requestId}`, JSON.stringify(data), { EX: ttlSeconds }) : Promise.resolve(),
        ]);
      }
    } catch (err) {
      console.error('Error assembling archive before download:', err);
      if (!response.headersSent) {
        return response.status(502).json({
          error: 'Unable to read or assemble archive data from Firestore. Archive export was not generated.',
        });
      }
      response.end();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  } catch (error) {
    if (sendAuthError(response, error)) return;
    console.error('Error generating archive download:', error);
    if (!response.headersSent) {
      return response.status(500).json({ error: 'Internal Server Error while assembling archive.' });
    }
  }
}
