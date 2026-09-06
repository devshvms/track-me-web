import type { VercelRequest, VercelResponse } from '@vercel/node';
import { FieldValue } from 'firebase-admin/firestore';
import { requireAdmin, sendAuthError } from '../../lib/auth';
import { db, messaging } from '../../lib/firebase';
import {
  BroadcastValidationError,
  parseOperatorBroadcast,
  toFcmData,
} from '../../lib/operator-broadcast';

/**
 * SCOPE_1.8.7 §6.3 / OPERATOR_BROADCAST.md — the operator broadcast endpoint.
 *
 * The only path in TrackMe that sends a person's words to every install. It is small on purpose;
 * everything interesting about it is a refusal.
 *
 * ### Record first, send second
 *
 * Firestore is written before FCM is called, and a write failure aborts the send. A message that
 * went out with no record is unauditable — and the audit trail is what answers a store review or a
 * user asking "why did TrackMe notify me". The reverse failure is survivable: a recorded broadcast
 * that failed to push is still delivered, because both clients read `broadcasts` on foreground.
 * Push is the fast path here, not the only one.
 *
 * ### Topics, not a token registry
 *
 * Sent to the `broadcasts` FCM topic. The alternative — collecting a push token per install — would
 * mean holding a device identifier for every user, declaring it on both stores, and deleting it on
 * sign-out and account deletion. A topic needs none of that: the client subscribes itself when
 * notification permission is granted and unsubscribes when it is revoked, and the server never
 * learns who is subscribed. It also makes per-user targeting impossible rather than merely
 * forbidden, which is a better way to keep a promise than remembering to.
 *
 * The cost is honest: no delivery receipts and no per-user retry. For "the build you are running
 * has a defect", that is the right trade.
 *
 * ### Data-only payload
 *
 * No `notification` block. A notification payload is rendered by the system before the app is
 * involved, which would put an unvalidated string from the network straight onto a HIGH-importance
 * channel and skip the client parsers this contract exists to run.
 */

/** Every install with notification permission subscribes itself to this. */
export const BROADCAST_TOPIC = 'broadcasts';

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'POST' && request.method !== 'GET') {
    response.setHeader('Allow', 'GET, POST');
    return response.status(405).json({ error: 'Method Not Allowed' });
  }

  response.setHeader('Cache-Control', 'no-store');

  try {
    const admin = await requireAdmin(request);
    if (!db) {
      return response.status(503).json({ error: 'Broadcast storage is unavailable.' });
    }

    const collection = db.collection('broadcasts');

    // The history is part of the feature, not a debugging aid. Someone about to interrupt every
    // user should see what was already sent, and when — most bad broadcasts are duplicates of a
    // good one sent an hour earlier.
    if (request.method === 'GET') {
      const snapshot = await collection.orderBy('created_at_millis', 'desc').limit(25).get();
      return response.status(200).json({
        broadcasts: snapshot.docs.map((doc) => doc.data()),
      });
    }

    let broadcast;
    try {
      broadcast = parseOperatorBroadcast({
        ...(request.body as Record<string, unknown>),
        // The id and the timestamp are the server's to assign. Accepting them from the client
        // would let a replayed request overwrite an existing record — the one thing the audit
        // trail must not permit.
        id: collection.doc().id,
        created_at_millis: Date.now(),
      });
    } catch (error) {
      if (error instanceof BroadcastValidationError) {
        return response.status(400).json({ error: error.message });
      }
      throw error;
    }

    await collection.doc(broadcast.id).create({
      ...broadcast,
      sent_by: admin.email || admin.uid,
      recorded_at: FieldValue.serverTimestamp(),
    });

    if (!messaging) {
      // Recorded but not pushed. Say so rather than reporting success: the operator needs to know
      // whether people were interrupted or will merely find it on next open.
      return response.status(202).json({
        ok: true,
        broadcast,
        pushed: false,
        detail: 'Recorded. Push is unavailable, so it will appear when people next open the app.',
      });
    }

    try {
      await messaging.send({
        topic: BROADCAST_TOPIC,
        data: toFcmData(broadcast),
        android: { priority: 'high' },
        apns: {
          headers: { 'apns-priority': '10', 'apns-push-type': 'background' },
          payload: { aps: { 'content-available': 1 } },
        },
      });
    } catch (error) {
      console.error('Broadcast recorded but push failed:', error);
      return response.status(202).json({
        ok: true,
        broadcast,
        pushed: false,
        detail: 'Recorded, but the push failed. It will appear when people next open the app.',
      });
    }

    return response.status(200).json({ ok: true, broadcast, pushed: true });
  } catch (error) {
    if (sendAuthError(response, error)) return;
    console.error('Error sending broadcast:', error);
    return response.status(500).json({ error: 'Could not send the broadcast.' });
  }
}
