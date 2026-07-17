import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { auth, db } from './firebase';

export class AuthError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export const SUPER_ADMIN_EMAILS = (process.env.SUPER_ADMIN_EMAILS || 'dev.shvms@gmail.com,shivam@shvms.in')
  .split(',')
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);

export function getBearerToken(request: VercelRequest): string {
  const header = request.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || !value.startsWith('Bearer ')) {
    throw new AuthError(401, 'Unauthorized. Missing Bearer token.');
  }
  return value.slice('Bearer '.length).trim();
}

export async function requireUser(request: VercelRequest): Promise<DecodedIdToken> {
  if (!auth) {
    throw new AuthError(503, 'Authentication is temporarily unavailable.');
  }

  try {
    return await auth.verifyIdToken(getBearerToken(request));
  } catch {
    throw new AuthError(401, 'Invalid or expired token.');
  }
}

export async function requireAdmin(request: VercelRequest): Promise<DecodedIdToken> {
  const decoded = await requireUser(request);
  const email = (decoded.email || '').toLowerCase();

  if (SUPER_ADMIN_EMAILS.includes(email)) {
    return decoded;
  }

  if (!db) {
    throw new AuthError(503, 'Admin authorization is temporarily unavailable.');
  }

  try {
    const adminSnap = await db.collection('admin_users').where('email', '==', decoded.email || '').limit(1).get();
    if (!adminSnap.empty) {
      return decoded;
    }
  } catch {
    throw new AuthError(403, 'Forbidden. You are not an admin.');
  }

  throw new AuthError(403, 'Forbidden. You are not an admin.');
}

export function sendAuthError(response: VercelResponse, error: unknown): boolean {
  if (error instanceof AuthError) {
    response.status(error.statusCode).json({ error: error.message });
    return true;
  }
  return false;
}

export function assertOwnsUserId(decoded: DecodedIdToken, userId: string) {
  if (decoded.uid !== userId) {
    throw new AuthError(403, 'Forbidden. You can only access your own data.');
  }
}
