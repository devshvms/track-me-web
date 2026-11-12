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

  const verifiedUids: string[] = [];
  const fcmTokens: string[] = [];

  for (const watcherUid of targetUids) {
    try {
      const relationSnap = await params.db
        .collection('users')
        .doc(params.ownerUid)
        .collection('trusted_watchers')
        .doc(watcherUid)
        .get();

      if (!relationSnap?.exists) continue;
      const relationData = relationSnap.data?.() || {};
      if (relationData.autoNotify === false) continue;

      verifiedUids.push(watcherUid);

      const userSnap = await params.db.collection('users').doc(watcherUid).get();
      const token = userSnap?.data?.()?.fcmToken;
      if (typeof token === 'string' && token.trim().length > 0) {
        fcmTokens.push(token.trim());
      }
    } catch (err) {
      console.error(`Watcher verification error for watcherUid=${watcherUid}:`, err);
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

  if (params.redis && params.ttlSeconds > 0) {
    for (const watcherUid of verifiedUids) {
      try {
        await params.redis.set(
          `watcher_inbox:${watcherUid}`,
          JSON.stringify(inboxPayload),
          { EX: Math.min(params.ttlSeconds, 24 * 60 * 60) },
        );
      } catch (err) {
        console.error(`Watcher inbox Redis write error for watcherUid=${watcherUid}:`, err);
      }
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
