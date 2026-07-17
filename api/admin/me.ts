import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAdmin, sendAuthError } from '../../lib/auth';

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
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
