import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getRedisClient } from '../../lib/redis';
import AdmZip from 'adm-zip';
import { db } from '../../lib/firebase';
import { assertOwnsUserId, requireUser, sendAuthError } from '../../lib/auth';

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  if (request.method !== 'GET') {
    return response.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const decoded = await requireUser(request);
    const { requestId, userId } = request.query;

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
    assertOwnsUserId(decoded, data.userId);

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

    const zip = new AdmZip();

    let userData: Record<string, unknown>;
    try {
      const userDoc = await db.collection('users').doc(data.userId).get();
      if (!userDoc.exists) {
        return response.status(404).json({
          error: 'User data was not found in Firestore. Archive export cannot be generated.',
        });
      }
      userData = userDoc.data() || {};
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
      expiresAt: data.expiresAt,
      retentionPolicy: 'Archive files expire 6 hours after retrieval (or max 48 hours unaccessed).',
      platformVersion: 'TrackMe Mobile & Web v1.5.0',
      profile: userData,
    };

    const ridesSummary: any[] = [];
    const metadataOtherCollections: Record<string, any> = {};

    try {
      const emergencyConfigSnapshot = await db.collection('users').doc(data.userId).collection('emergency_config').get();
      if (!emergencyConfigSnapshot.empty) {
        metadataOtherCollections['emergency_config'] = {};
        for (const doc of emergencyConfigSnapshot.docs) {
          metadataOtherCollections['emergency_config'][doc.id] = doc.data();
        }
      }

      const ridesSnapshot = await db.collection('users').doc(data.userId).collection('rides').get();

      for (const doc of ridesSnapshot.docs) {
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
        zip.addFile(`traces/ride_${doc.id}.gpx`, Buffer.from(gpxTrace, 'utf8'));
      }
    } catch (err) {
      console.error('Error fetching archive collections from Firestore:', err);
      return response.status(502).json({
        error: 'Unable to read archive data from Firestore. Archive export was not generated.',
      });
    }

    metadata.otherCollections = metadataOtherCollections;
    zip.addFile('metadata.json', Buffer.from(JSON.stringify(metadata, null, 2), 'utf8'));

    zip.addFile('rides_history.json', Buffer.from(JSON.stringify(ridesSummary, null, 2), 'utf8'));

    const zipBuffer = zip.toBuffer();

    if (!data.downloadAccessedAt) {
      data.downloadAccessedAt = new Date().toISOString();
      data.expiresAt = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();

      const ttlSeconds = 6 * 60 * 60;
      await Promise.all([
        data.userId ? redis.set(`export:user:${data.userId}`, JSON.stringify(data), { EX: ttlSeconds }) : Promise.resolve(),
        data.requestId ? redis.set(`export:request:${data.requestId}`, JSON.stringify(data), { EX: ttlSeconds }) : Promise.resolve(),
      ]);
    }

    response.setHeader('Content-Type', 'application/zip');
    response.setHeader('Content-Disposition', `attachment; filename="TrackMe_Archive_${data.userId}.zip"`);
    response.setHeader('Content-Length', zipBuffer.length);

    return response.send(zipBuffer);
  } catch (error) {
    if (sendAuthError(response, error)) return;
    console.error('Error generating archive download:', error);
    return response.status(500).json({ error: 'Internal Server Error while assembling archive.' });
  }
}
