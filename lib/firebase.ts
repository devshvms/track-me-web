import { getApps, initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';

const fallbackProjectId = 'trackme-android-1234';

if (!getApps().length) {
  try {
    const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (serviceAccount) {
      initializeApp({ credential: cert(JSON.parse(serviceAccount)) });
    } else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
      initializeApp({
        credential: cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        }),
      });
    } else {
      initializeApp({
        projectId: process.env.FIREBASE_PROJECT_ID || fallbackProjectId,
      });
    }
  } catch (error) {
    console.error('Firebase admin initialization error', error);
  }
}

export const db = getApps().length ? getFirestore() : null;

/**
 * FCM sender for Class D operator broadcasts (SCOPE_1.8.7 §6.3).
 *
 * Null when the admin app failed to initialise, exactly like `db` — every caller already has to
 * handle a 503 for storage, and a broadcast that cannot be recorded must not be sent anyway.
 */
export const messaging = getApps().length ? getMessaging() : null;
export const auth = getApps().length ? getAuth() : null;
