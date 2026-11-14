import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';
import { getRedisClient } from '../../lib/redis';
import { captureTelemetryEvent } from '../../lib/posthog';
import { absoluteUrl } from '../../lib/http';
import { requireUser, sendAuthError } from '../../lib/auth';
import { db, messaging } from '../../lib/firebase';
import {
  dispatchTrustedWatcherNotifications,
  normalizeWatcherUids,
  MAX_AUTO_WATCHERS,
} from '../../lib/track/watchers';

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  if (request.method === 'GET' && request.query?.inbox === '1') {
    response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    try {
      const decoded = await requireUser(request);
      const redis = await getRedisClient();
      const rawInvite = await redis.get(`watcher_inbox:${decoded.uid}`);
      if (!rawInvite) {
        return response.status(200).json({ activeInvite: null });
      }
      let invite: any = null;
      try {
        invite = JSON.parse(rawInvite);
      } catch (parseErr) {
        console.error('Malformed watcher inbox JSON, purging key:', parseErr);
        await redis.del(`watcher_inbox:${decoded.uid}`);
        return response.status(200).json({ activeInvite: null });
      }

      if (!invite?.sessionId) {
        await redis.del(`watcher_inbox:${decoded.uid}`);
        return response.status(200).json({ activeInvite: null });
      }

      const sessionStr = await redis.get(`session:${invite.sessionId}`);
      if (!sessionStr) {
        await redis.del(`watcher_inbox:${decoded.uid}`);
        return response.status(200).json({ activeInvite: null });
      }

      let session: any = null;
      try {
        session = JSON.parse(sessionStr);
      } catch {
        session = null;
      }

      if (!session || (session.status && session.status !== 'active')) {
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

    if (request.body?.action === 'create_watcher_invite') {
      const redis = await getRedisClient();
      const rawName = typeof request.body?.displayName === 'string' && request.body.displayName.trim()
        ? request.body.displayName.trim()
        : (decoded.name || decoded.email?.split('@')[0] || 'Rider');
      const inviterName = rawName.slice(0, 64);
      const code = crypto.randomBytes(16).toString('base64url');
      const ttlSeconds = 86400; // 24h single-use invite

      await redis.set(
        `watcher_invite:${code}`,
        JSON.stringify({
          inviterUid: decoded.uid,
          inviterName,
          createdAt: Date.now(),
        }),
        { EX: ttlSeconds },
      );

      const inviteUrl = absoluteUrl(
        request,
        `/live/watcher?code=${encodeURIComponent(code)}&inviterName=${encodeURIComponent(inviterName)}`,
      );
      return response.status(200).json({
        success: true,
        code,
        inviteUrl,
        expiresInSeconds: ttlSeconds,
      });
    }

    if (request.body?.action === 'accept_watcher') {
      const code = typeof request.body?.code === 'string' ? request.body.code.trim() : '';
      if (!code || !/^[A-Za-z0-9_-]{12,128}$/.test(code)) {
        return response.status(400).json({
          error: 'Valid single-use invite code is required. Ask the rider for a fresh invite.',
        });
      }

      if (!db) {
        return response.status(503).json({ error: 'Watcher pairing service temporarily unavailable.' });
      }

      const redis = await getRedisClient();
      const inviteKey = `watcher_invite:${code}`;
      let rawInvite: string | null = null;
      if (typeof redis.getDel === 'function') {
        rawInvite = await redis.getDel(inviteKey);
      } else if (typeof redis.multi === 'function') {
        const multi = redis.multi();
        multi.get(inviteKey);
        multi.del(inviteKey);
        const execRes = await multi.exec();
        rawInvite = typeof execRes?.[0] === 'string' ? execRes[0] : null;
      } else {
        rawInvite = await redis.get(inviteKey);
        if (rawInvite !== null) {
          await redis.del(inviteKey);
        }
      }

      if (!rawInvite) {
        return response.status(410).json({
          error: 'Invite link expired or already used. Ask the rider for a new invite.',
        });
      }

      let inviteRecord: any = null;
      try {
        inviteRecord = JSON.parse(rawInvite);
      } catch {
        inviteRecord = null;
      }

      const inviterUid = typeof inviteRecord?.inviterUid === 'string' ? inviteRecord.inviterUid.trim() : '';
      if (!inviterUid) {
        return response.status(410).json({ error: 'Invalid or corrupted invite.' });
      }

      const claimedInviterUid = typeof request.body?.inviterUid === 'string' ? request.body.inviterUid.trim() : '';
      if (claimedInviterUid && claimedInviterUid !== inviterUid) {
        return response.status(403).json({ error: 'Invite owner mismatch.' });
      }

      if (inviterUid === decoded.uid) {
        return response.status(400).json({ error: 'You cannot accept your own watcher invite.' });
      }

      const inviterName = typeof inviteRecord?.inviterName === 'string' && inviteRecord.inviterName.trim()
        ? inviteRecord.inviterName.trim().slice(0, 64)
        : (typeof request.body?.inviterName === 'string' && request.body.inviterName.trim()
          ? request.body.inviterName.trim().slice(0, 64)
          : 'Rider');
      const watcherDisplayName = typeof request.body?.displayName === 'string' && request.body.displayName.trim()
        ? request.body.displayName.trim().slice(0, 64)
        : (decoded.name || decoded.email?.split('@')[0] || 'TrackMe Watcher');

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

      return response.status(200).json({ success: true, paired: true, inviterUid, inviterName });
    }

    const { durationMinutes, username, watcherUids } = request.body || {};
    let duration = parseInt(durationMinutes, 10);
    if (isNaN(duration) || duration <= 0) {
      duration = 1440;
    } else if (duration > 1440) {
      return response.status(400).json({ error: 'Duration cannot exceed 24 hours (1440 minutes).' });
    }

    const cleanUsername = typeof username === 'string' && username.trim().length > 0
      ? username.trim().slice(0, 64)
      : 'Anonymous';

    const cleanWatcherUids = normalizeWatcherUids(watcherUids, decoded.uid);

    const redis = await getRedisClient();

    const now = Date.now();
    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(now + duration * 60 * 1000);
    
    const sessionData = {
      sessionId,
      ownerUid: decoded.uid,
      ownerEmail: decoded.email || null,
      username: cleanUsername,
      initialDuration: duration,
      startedAt: now,
      expiresAt: expiresAt.toISOString(),
      status: 'active',
      lastLocation: null,
      path: [] as [number, number][]
    };

    // CIE-017: Pipeline initial session persistence and 24h stats tracking
    // in a single atomic roundtrip via multi() when supported.
    try {
      if (typeof redis.multi === 'function') {
        const multi = redis.multi();
        multi.set(`session:${sessionId}`, JSON.stringify(sessionData), {
          EX: duration * 60,
        });
        multi.incr('stats:total_shares');
        multi.zAdd('stats:shares_24h', { score: now, value: sessionId });
        multi.zRemRangeByScore('stats:shares_24h', 0, now - 24 * 60 * 60 * 1000);
        await multi.exec();
      } else {
        await redis.set(`session:${sessionId}`, JSON.stringify(sessionData), {
          EX: duration * 60,
        });
        await redis.incr('stats:total_shares');
        await redis.zAdd('stats:shares_24h', { score: now, value: sessionId });
        await redis.zRemRangeByScore('stats:shares_24h', 0, now - 24 * 60 * 60 * 1000);
      }
    } catch (e) {
      console.error('Session write / stats update error:', e);
      try {
        await redis.set(`session:${sessionId}`, JSON.stringify(sessionData), {
          EX: duration * 60,
        });
      } catch (fallbackErr) {
        console.error('Fallback session write error:', fallbackErr);
      }
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
        watcherUids: cleanWatcherUids,
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
