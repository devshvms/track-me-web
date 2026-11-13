export const MAX_AUTO_WATCHERS = 5;

export interface WatcherInvitePayload {
  sessionId: string;
  shareUrl: string;
  riderName: string;
  startedAt: number;
  expiresAt: string;
}

export interface DispatchWatcherParams {
  ownerUid: string;
  riderName: string;
  sessionId: string;
  shareUrl: string;
  startedAt: number;
  expiresAt: string;
  ttlSeconds: number;
  watcherUids?: unknown;
  db: any;
  messaging: any;
  redis: any;
}

/** Sanitizes and caps caller-provided watcher UIDs (deduped, no self-notify, max 5). */
export function normalizeWatcherUids(watcherUids: unknown, ownerUid: string): string[] {
  if (!Array.isArray(watcherUids)) return [];
  const unique: string[] = [];
  for (const raw of watcherUids) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed || trimmed === ownerUid || trimmed.length > 128) continue;
    if (!unique.includes(trimmed)) {
      unique.push(trimmed);
    }
    if (unique.length >= MAX_AUTO_WATCHERS) break;
  }
  return unique;
}

/**
 * Verifies Trusted Watchers in Firestore, writes ephemeral watcher_inbox keys in Redis,
 * and dispatches free FCM multicast notifications ($0 recurring cost).
 */
export async function dispatchTrustedWatcherNotifications(
  params: DispatchWatcherParams,
): Promise<number> {
  const targetUids = normalizeWatcherUids(params.watcherUids, params.ownerUid);
  if (targetUids.length === 0 || !params.db) {
    return 0;
  }

  // CIE-023: Concurrently verify all target watchers via Promise.all
  // Rather than sequential relation reads followed by user token reads (~360ms latency for 5 watchers),
  // execute all Firestore lookups in parallel to minimize serverless duration ($0/mo cost mandate).
  const lookupResults = await Promise.all(
    targetUids.map(async (watcherUid): Promise<{ uid: string; fcmToken?: string } | null> => {
      try {
        const relationSnap = await params.db
          .collection('users')
          .doc(params.ownerUid)
          .collection('trusted_watchers')
          .doc(watcherUid)
          .get();

        if (!relationSnap?.exists) return null;
        const relationData = relationSnap.data?.() || {};
        if (relationData.autoNotify === false) return null;

        const userSnap = await params.db.collection('users').doc(watcherUid).get();
        const token = userSnap?.data?.()?.fcmToken;
        const fcmToken =
          typeof token === 'string' && token.trim().length > 0 ? token.trim() : undefined;

        return { uid: watcherUid, fcmToken };
      } catch (err) {
        console.error(`Watcher verification error for watcherUid=${watcherUid}:`, err);
        return null;
      }
    }),
  );

  const verifiedUids: string[] = [];
  const fcmTokens: string[] = [];

  for (const res of lookupResults) {
    if (res) {
      verifiedUids.push(res.uid);
      if (res.fcmToken) {
        fcmTokens.push(res.fcmToken);
      }
    }
  }

  if (verifiedUids.length === 0) {
    return 0;
  }

  const inboxPayload: WatcherInvitePayload = {
    sessionId: params.sessionId,
    shareUrl: params.shareUrl,
    riderName: params.riderName,
    startedAt: params.startedAt,
    expiresAt: params.expiresAt,
  };

  if (params.redis && params.ttlSeconds > 0 && verifiedUids.length > 0) {
    const ttl = Math.min(params.ttlSeconds, 24 * 60 * 60);
    const payloadStr = JSON.stringify(inboxPayload);
    try {
      if (typeof params.redis.multi === 'function') {
        const multi = params.redis.multi();
        for (const watcherUid of verifiedUids) {
          multi.set(`watcher_inbox:${watcherUid}`, payloadStr, { EX: ttl });
        }
        await multi.exec();
      } else {
        for (const watcherUid of verifiedUids) {
          await params.redis.set(`watcher_inbox:${watcherUid}`, payloadStr, { EX: ttl });
        }
      }
    } catch (err) {
      console.error('Watcher inbox Redis batch write error:', err);
    }
  }

  if (params.messaging && fcmTokens.length > 0) {
    try {
      await params.messaging.sendEachForMulticast({
        tokens: fcmTokens,
        notification: {
          title: `📍 ${params.riderName} is sharing live location`,
          body: 'Tap to watch their live route in TrackMe.',
        },
        data: {
          type: 'live_share_started',
          sessionId: params.sessionId,
          shareUrl: params.shareUrl,
          riderName: params.riderName,
        },
        android: {
          priority: 'high',
        },
        apns: {
          payload: {
            aps: {
              sound: 'default',
            },
          },
        },
      });
    } catch (err) {
      console.error('Trusted watcher FCM multicast error:', err);
    }
  }

  return verifiedUids.length;
}
