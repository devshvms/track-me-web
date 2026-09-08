import type { VercelRequest, VercelResponse } from '@vercel/node';
import { FieldValue } from 'firebase-admin/firestore';
import {
  AdminConfigValidationError,
  normalizeStoredAdminConfig,
  parseAdminConfig,
} from '../../lib/admin-config';
import { requireAdmin, sendAuthError } from '../../lib/auth';
import { auth, db, messaging } from '../../lib/firebase';
import { getRedisClient, redisMGet } from '../../lib/redis';
import {
  BroadcastValidationError,
  parseOperatorBroadcast,
  toFcmMessage,
} from '../../lib/operator-broadcast';

/**
 * Every admin route, as one catch-all function.
 *
 * ### Why this file exists
 *
 * Vercel's Hobby plan caps a deployment at **12 serverless functions**. The 2026-08-08 architecture
 * audit recorded that `api/group/[...action].ts` took the project to exactly 12 with zero headroom,
 * and named the remedy in advance: *"the next new endpoint anywhere in the project needs
 * `api/admin/*.ts` collapsed into `api/admin/[...action].ts` first."*
 *
 * SCOPE_1.8.7 §6.3's broadcast endpoint was that next endpoint. It made 13, and the 1.8.7 deploy
 * failed on the cap exactly as predicted. Collapsing the five admin files into this one takes the
 * project from 13 to 9 and restores the headroom the audit asked for.
 *
 * ### The URLs do not change
 *
 * A file-level catch-all still serves `/api/admin/me`, `/api/admin/config`, and the rest — the
 * segment arrives as the captured action and is dispatched below. `public/admin/admin.js` is
 * untouched, and so is any bookmark or script pointing at these paths. That is the whole reason
 * this shape was chosen over renaming routes.
 *
 * Each handler keeps its original behaviour verbatim, including where it calls `requireAdmin` and
 * what it says when that fails: these are the only authenticated write paths in the project, and a
 * refactor done to satisfy a plan limit is not the place to quietly adjust an auth boundary.
 */

/** Every install with notification permission subscribes itself to this. */
export const BROADCAST_TOPIC = 'broadcasts';

/**
 * Vercel's file-level catch-all injects the captured segment under the literal key `...action`
 * (ellipsis retained), not `action` — confirmed against `vercel dev` and production logs (E15).
 * `action` is checked too in case that convention ever changes; without this every admin request
 * 404s before reaching a handler. Same helper as `api/group/[...action].ts`.
 */
function extractAction(request: VercelRequest): string | undefined {
  const raw = request.query['...action'] ?? request.query.action;
  const segment = Array.isArray(raw) ? raw[0] : raw;
  return typeof segment === 'string' ? segment : undefined;
}

export default async function handler(request: VercelRequest, response: VercelResponse) {
  switch (extractAction(request)) {
    case 'me': return handleMe(request, response);
    case 'config': return handleConfig(request, response);
    case 'export-metrics': return handleExportMetrics(request, response);
    case 'user-search': return handleUserSearch(request, response);
    case 'broadcast': return handleBroadcast(request, response);
    default:
      console.error('Unmatched admin action route', { url: request.url, query: request.query });
      return response.status(404).json({ error: 'Not Found' });
  }
}

// ---------------------------------------------------------------------------------------------
// me
// ---------------------------------------------------------------------------------------------

async function handleMe(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'GET') {
    return response.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const decoded = await requireAdmin(request);
    return response.status(200).json({
      uid: decoded.uid,
      email: decoded.email || null,
      admin: true,
    });
  } catch (error) {
    if (sendAuthError(response, error)) return;
    console.error('Error verifying admin:', error);
    return response.status(500).json({ error: 'Internal server error' });
  }
}

// ---------------------------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------------------------

async function handleConfig(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'GET' && request.method !== 'PUT') {
    response.setHeader('Allow', 'GET, PUT');
    return response.status(405).json({ error: 'Method Not Allowed' });
  }

  response.setHeader('Cache-Control', 'no-store');

  try {
    const admin = await requireAdmin(request);
    if (!db) {
      return response.status(503).json({ error: 'Remote Config storage is unavailable.' });
    }

    const configRef = db.collection('app_config').doc('global_settings');

    if (request.method === 'GET') {
      const configSnap = await configRef.get();
      return response.status(200).json({
        config: normalizeStoredAdminConfig(configSnap.exists ? configSnap.data() : null),
      });
    }

    let config;
    try {
      config = parseAdminConfig(request.body);
    } catch (error) {
      if (error instanceof AdminConfigValidationError) {
        return response.status(400).json({ error: error.message });
      }
      throw error;
    }

    await configRef.set(
      {
        ...config,
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: admin.email || admin.uid,
      },
      { merge: true },
    );

    return response.status(200).json({ ok: true, config });
  } catch (error) {
    if (sendAuthError(response, error)) return;
    console.error('Error handling Remote Config:', error);
    return response.status(500).json({ error: 'Could not update Remote Config.' });
  }
}

// ---------------------------------------------------------------------------------------------
// export-metrics
// ---------------------------------------------------------------------------------------------

async function handleExportMetrics(request: VercelRequest, response: VercelResponse) {
  try {
    await requireAdmin(request);
    const redis = await getRedisClient();

    const keys = await redis.keys('export:user:*');

    let queued = 0;
    let processing = 0;
    let completed = 0;

    if (keys.length > 0) {
      const values = await redisMGet(redis, keys);

      if (Array.isArray(values)) {
        for (const valStr of values) {
          if (typeof valStr !== 'string') continue;
          try {
            const data = JSON.parse(valStr);
            if (data.status === 'QUEUED') queued++;
            else if (data.status === 'PROCESSING') processing++;
            else if (data.status === 'COMPLETED') completed++;
          } catch (e) {
            continue;
          }
        }
      }
    }

    return response.status(200).json({
      queued,
      processing,
      completed,
    });
  } catch (error: any) {
    if (sendAuthError(response, error)) return;
    console.error('Error fetching export metrics:', error);
    return response.status(500).json({ error: 'Internal server error' });
  }
}

// ---------------------------------------------------------------------------------------------
// user-search
// ---------------------------------------------------------------------------------------------

async function handleUserSearch(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'GET') {
    return response.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    await requireAdmin(request);
  } catch (err: any) {
    if (sendAuthError(response, err)) return;
    console.error('Admin verification failed:', err.message);
    return response.status(500).json({ error: 'Internal server error verifying admin.' });
  }

  // Search for user by email
  const { email } = request.query;
  if (!email || typeof email !== 'string') {
    return response.status(400).json({ error: 'Missing required query parameter: email' });
  }

  try {
    if (!db || !auth) {
      return response.status(503).json({ error: 'Firebase Admin is not configured.' });
    }

    const usersSnap = await db.collection('users').where('email', '==', email).get();

    if (usersSnap.empty) {
      try {
        const authUser = await auth.getUserByEmail(email);
        return response.status(200).json({
          found: true,
          source: 'auth',
          user: {
            uid: authUser.uid,
            email: authUser.email,
            displayName: authUser.displayName || 'N/A',
            createdAt: authUser.metadata.creationTime || 'N/A',
            lastLoginAt: authUser.metadata.lastSignInTime || 'N/A',
            clientOS: 'Unknown',
            appVersion: 'Unknown',
          },
        });
      } catch {
        return response.status(404).json({ found: false, error: 'User not found in database or auth.' });
      }
    }

    const userDoc = usersSnap.docs[0];
    const data = userDoc.data();

    return response.status(200).json({
      found: true,
      source: 'firestore',
      user: {
        uid: userDoc.id,
        email: data.email || email,
        displayName: data.displayName || data.name || 'N/A',
        clientOS: data.clientOS || 'Unknown',
        appVersion: data.appVersion || 'Unknown',
        createdAt: data.createdAt ? data.createdAt.toDate().toISOString() : 'N/A',
        lastLoginAt: data.lastLoginAt ? data.lastLoginAt.toDate().toISOString() : 'N/A',
      },
    });
  } catch (err: any) {
    console.error('Error searching for user:', err);
    return response.status(500).json({ error: 'Internal server error searching for user.' });
  }
}

// ---------------------------------------------------------------------------------------------
// broadcast — SCOPE_1.8.7 §6.3
// ---------------------------------------------------------------------------------------------

/**
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
async function handleBroadcast(request: VercelRequest, response: VercelResponse) {
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
      // The message shape lives in lib/operator-broadcast so a test can assert the actual request
      // rather than only the data map — which is how `apns-priority: 10` on a background push
      // survived here unnoticed.
      await messaging.send(toFcmMessage(broadcast, BROADCAST_TOPIC));
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
