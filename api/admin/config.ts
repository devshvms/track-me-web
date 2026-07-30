import type { VercelRequest, VercelResponse } from '@vercel/node';
import { FieldValue } from 'firebase-admin/firestore';
import {
  AdminConfigValidationError,
  normalizeStoredAdminConfig,
  parseAdminConfig,
} from '../../lib/admin-config';
import { requireAdmin, sendAuthError } from '../../lib/auth';
import { db } from '../../lib/firebase';

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
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
