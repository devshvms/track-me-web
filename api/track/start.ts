import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';
import { getRedisClient } from '../../lib/redis';
import { captureTelemetryEvent } from '../../lib/posthog';
import { absoluteUrl } from '../../lib/http';
import { requireUser, sendAuthError } from '../../lib/auth';
import { db, messaging } from '../../lib/firebase';
import {
  dispatchTrustedWatcherNotifications,
  MAX_AUTO_WATCHERS,
} from '../../lib/track/watchers';

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  if (request.method === 'GET' && request.query?.inbox === '1') {
    try {
      const decoded = await requireUser(request);
      const redis = await getRedisClient();
      const rawInvite = await redis.get(`watcher_inbox:${decoded.uid}`);
      if (!rawInvite) {
        return response.status(200).json({ activeInvite: null });
      }
      const invite = JSON.parse(rawInvite);
      const sessionStr = invite?.sessionId ? await redis.get(`session:${invite.sessionId}`) : null;
      if (!sessionStr) {
        await redis.del(`watcher_inbox:${decoded.uid}`);
        return response.status(200).json({ activeInvite: null });
      }
      const session = JSON.parse(sessionStr);
      if (session?.status && session.status !== 'active') {
        await redis.del(`watcher_inbox:${decoded.uid}`);
        return response.status(200).json({ activeInvite: null });
      }
      return response.status(200).json({ activeInvite: invite });
    } catch (error) {
      if (sendAuthError(response, error)) return;
      console.error('Error reading watcher inbox:', error);
      return response.status(500).json({ error: 'Internal Server Error' });
    }
  }

  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const decoded = await requireUser(request);

    if (request.body?.action === 'accept_watcher') {
      const inviterUid = typeof request.body?.inviterUid === 'string' ? request.body.inviterUid.trim() : '';
      const inviterName = typeof request.body?.inviterName === 'string' && request.body.inviterName.trim()
        ? request.body.inviterName.trim().slice(0, 64)
        : 'Rider';
      const watcherDisplayName = typeof request.body?.displayName === 'string' && request.body.displayName.trim()
        ? request.body.displayName.trim().slice(0, 64)
        : (decoded.name || decoded.email?.split('@')[0] || 'TrackMe Watcher');

      if (!inviterUid || inviterUid === decoded.uid) {
        return response.status(400).json({ error: 'Invalid inviterUid.' });
      }
      if (!db) {
        return response.status(503).json({ error: 'Watcher pairing service temporarily unavailable.' });
      }

      const watchersRef = db.collection('users').doc(inviterUid).collection('trusted_watchers');
      const existingDoc = await watchersRef.doc(decoded.uid).get();
      if (!existingDoc.exists) {
        const snapshot = await watchersRef.limit(MAX_AUTO_WATCHERS).get();
        if (snapshot.size >= MAX_AUTO_WATCHERS) {
          return response.status(409).json({ error: `Maximum ${MAX_AUTO_WATCHERS} Trusted Watchers reached.` });
        }
      }

      const now = Date.now();
      await watchersRef.doc(decoded.uid).set({
        uid: decoded.uid,
        displayName: watcherDisplayName,
        photoUrl: decoded.picture || null,
        autoNotify: true,
        addedAt: now,
      }, { merge: true });

      await db.collection('users').doc(decoded.uid).collection('watching_riders').doc(inviterUid).set({
        uid: inviterUid,
        displayName: inviterName,
        addedAt: now,
      }, { merge: true });

      return response.status(200).json({ success: true, paired: true, inviterUid });
    }

    const { durationMinutes, username, watcherUids } = request.body || {};
    let duration = parseInt(durationMinutes, 10);
    if (isNaN(duration) || duration <= 0) {
      duration = 1440;
    } else if (duration > 1440) {
      return response.status(400).json({ error: 'Duration cannot exceed 24 hours (1440 minutes).' });
    }

    const redis = await getRedisClient();

    const now = Date.now();
    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(now + duration * 60 * 1000);
    
    const sessionData = {
      sessionId,
      ownerUid: decoded.uid,
      ownerEmail: decoded.email || null,
      username: username || 'Anonymous',
      initialDuration: duration,
      startedAt: now,
      expiresAt: expiresAt.toISOString(),
      status: 'active',
      lastLocation: null,
      path: [] as [number, number][]
    };

    await redis.set(`session:${sessionId}`, JSON.stringify(sessionData), {
      EX: duration * 60
    });

    try {
      await redis.incr('stats:total_shares');
      await redis.zAdd('stats:shares_24h', { score: now, value: sessionId });
      await redis.zRemRangeByScore('stats:shares_24h', 0, now - 24 * 60 * 60 * 1000);
    } catch (e) {
      console.error('Stats update error:', e);
    }

    const shareLink = absoluteUrl(request, `/live/${sessionId}`);

    let notifiedWatchersCount = 0;
    try {
      notifiedWatchersCount = await dispatchTrustedWatcherNotifications({
        ownerUid: decoded.uid,
        riderName: sessionData.username,
        sessionId,
        shareUrl: shareLink,
        startedAt: now,
        expiresAt: sessionData.expiresAt,
        ttlSeconds: duration * 60,
        watcherUids,
        db,
        messaging,
        redis,
      });
    } catch (watchErr) {
      console.error('Trusted watcher dispatch failed safely:', watchErr);
    }

    const country = (request.headers['x-vercel-ip-country'] as string) || 'unknown';
    await captureTelemetryEvent(sessionId, 'web_live_share_session_started', {
      sessionId,
      session_id: sessionId,
      username: sessionData.username,
      durationMinutes: duration,
      notifiedWatchersCount,
      recipient_count: notifiedWatchersCount,
      country,
    });

    return response.status(200).json({
      sessionId,
      shareLink,
      expiresAt: sessionData.expiresAt,
      notifiedWatchersCount,
    });
  } catch (error) {
    if (sendAuthError(response, error)) return;
    console.error('Error starting session:', error);
    return response.status(500).json({ error: 'Internal Server Error' });
  }
}
