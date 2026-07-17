import type { VercelRequest, VercelResponse } from '@vercel/node';
import { auth, db } from '../../lib/firebase';
import { requireAdmin, sendAuthError } from '../../lib/auth';

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
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
