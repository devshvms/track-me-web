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

export interface DispatchWatcherTripEndedParams {
  ownerUid: string;
  riderName: string;
  sessionId: string;
  shareUrl: string;
  stopKind: 'rider_confirmed' | 'auto_dwell_ended' | 'expired';
  notifyWatchersOnEnd?: boolean;
  elapsedMinutes?: number;
  distanceKm?: number | null;
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

interface VerifiedWatcherTarget {
  uid: string;
  fcmToken?: string;
}

/** Resolves verified Trusted Watchers whose `autoNotify` toggle is enabled in Firestore. */
async function resolveVerifiedWatchers(
  ownerUid: string,
  watcherUids: unknown,
  db: any,
): Promise<VerifiedWatcherTarget[]> {
  const targetUids = normalizeWatcherUids(watcherUids, ownerUid);
  if (targetUids.length === 0 || !db) {
    return [];
  }

  // CIE-023: Concurrently verify all target watchers via Promise.all
  // Rather than sequential relation reads followed by user token reads (~360ms latency for 5 watchers),
  // execute all Firestore lookups in parallel to minimize serverless duration ($0/mo cost mandate).
  const lookupResults = await Promise.all(
    targetUids.map(async (watcherUid): Promise<VerifiedWatcherTarget | null> => {
      try {
        const relationSnap = await db
          .collection('users')
          .doc(ownerUid)
          .collection('trusted_watchers')
          .doc(watcherUid)
          .get();

        if (!relationSnap?.exists) return null;
        const relationData = relationSnap.data?.() || {};
        if (relationData.autoNotify === false) return null;

        const userSnap = await db.collection('users').doc(watcherUid).get();
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

  return lookupResults.filter((item): item is VerifiedWatcherTarget => item !== null);
}

/** Formats honest trip-ended summary metrics for trusted watcher push notifications. */
export function formatTripEndedWatcherSummary(
  elapsedMinutes?: number,
  distanceKm?: number | null,
): string {
  const parts: string[] = [];
  if (typeof distanceKm === 'number' && Number.isFinite(distanceKm) && distanceKm >= 0.05) {
    parts.push(`${distanceKm.toFixed(1)} km`);
  }
  if (typeof elapsedMinutes === 'number' && Number.isFinite(elapsedMinutes) && elapsedMinutes >= 1) {
    const roundedMins = Math.max(1, Math.round(elapsedMinutes));
    if (roundedMins >= 60) {
      const hours = Math.floor(roundedMins / 60);
      const mins = roundedMins % 60;
      parts.push(mins > 0 ? `${hours}h ${mins}m` : `${hours}h`);
    } else {
      parts.push(`${roundedMins} min`);
    }
  }
  if (parts.length > 0) {
    return `${parts.join(' · ')} · Tap to view the concluded route on TrackMe.`;
  }
  return 'Tap to view the concluded route on TrackMe.';
}

/** Removes ephemeral watcher inbox invites from Redis when a live-share session concludes. */
export async function clearWatcherInboxKeys(redis: any, uids: string[]): Promise<void> {
  if (!redis || uids.length === 0) return;
  try {
    if (typeof redis.multi === 'function') {
      const multi = redis.multi();
      for (const uid of uids) {
        multi.del(`watcher_inbox:${uid}`);
      }
      await multi.exec();
    } else {
      for (const uid of uids) {
        await redis.del(`watcher_inbox:${uid}`);
      }
    }
  } catch (err) {
    console.error('Watcher inbox Redis cleanup error:', err);
  }
}

/**
 * Verifies Trusted Watchers in Firestore, writes ephemeral watcher_inbox keys in Redis,
 * and dispatches free FCM multicast notifications ($0 recurring cost).
 */
export async function dispatchTrustedWatcherNotifications(
  params: DispatchWatcherParams,
): Promise<number> {
  const verifiedTargets = await resolveVerifiedWatchers(params.ownerUid, params.watcherUids, params.db);
  if (verifiedTargets.length === 0) {
    return 0;
  }
  const verifiedUids = verifiedTargets.map((t) => t.uid);
  const fcmTokens = verifiedTargets.map((t) => t.fcmToken).filter((t): t is string => Boolean(t));

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

/**
 * TASK-382: Clears active watcher inbox keys and dispatches an honest trip-ended update
 * via free FCM multicast ONLY when the rider explicitly confirms stopping (`rider_confirmed`)
 * and `notifyWatchersOnEnd` is enabled. Never claims "arrived safely" from inferred stops.
 */
export async function dispatchTrustedWatcherTripEndedNotifications(
  params: DispatchWatcherTripEndedParams,
): Promise<number> {
  const targetUids = normalizeWatcherUids(params.watcherUids, params.ownerUid);
  await clearWatcherInboxKeys(params.redis, targetUids);

  if (params.stopKind !== 'rider_confirmed' || params.notifyWatchersOnEnd === false) {
    return 0;
  }

  const verifiedTargets = await resolveVerifiedWatchers(params.ownerUid, targetUids, params.db);
  if (verifiedTargets.length === 0) {
    return 0;
  }

  const fcmTokens = verifiedTargets.map((t) => t.fcmToken).filter((t): t is string => Boolean(t));
  if (!params.messaging || fcmTokens.length === 0) {
    return 0;
  }

  const summaryBody = formatTripEndedWatcherSummary(params.elapsedMinutes, params.distanceKm);
  try {
    await params.messaging.sendEachForMulticast({
      tokens: fcmTokens,
      notification: {
        title: `🏁 ${params.riderName} ended their shared trip`,
        body: summaryBody,
      },
      data: {
        type: 'live_share_ended',
        stopKind: params.stopKind,
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
    return fcmTokens.length;
  } catch (err) {
    console.error('Trusted watcher trip-ended FCM multicast error:', err);
    return 0;
  }
}
