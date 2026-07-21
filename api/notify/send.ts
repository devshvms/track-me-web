import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireUser, sendAuthError, AuthError } from '../../lib/auth';
import { getRedisClient } from '../../lib/redis';
import { EMAIL_TYPES, isValidEmailType, renderEmail, type EmailType } from '../../lib/notifications/templates';

// D3 — transactional email endpoint (Resend as a dumb API pipe).
//
// Security posture:
//   - The client passes ONLY a `type` enum (welcome | delete_account). The
//     server owns the subject + HTML, so there is no way to make us send
//     attacker-controlled content.
//   - The recipient is taken from the VERIFIED Firebase token, never the body —
//     a user can only email themselves (self-only send).
//   - Rate limited to <=3 sends per user per day via Redis.
//   - No recipient address is ever logged (redacted) and none is synced to a
//     provider Audience/CRM — the address is used ephemerally in memory only.

const DAILY_LIMIT = 3;
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const DEFAULT_FROM = 'TrackMe <noreply@trackme.shvms.in>';

/** Mask an address for logs: keep first char + tld, drop everything else.
 *  e.g. "jane.doe@gmail.com" -> "j***@***.com". Never log the raw value. */
export function redactEmail(email: string): string {
  const at = email.indexOf('@');
  if (at < 1) return '***';
  const first = email[0];
  const dot = email.lastIndexOf('.');
  const tld = dot > at ? email.slice(dot) : '';
  return `${first}***@***${tld}`;
}

/** UTC day bucket so the per-user daily window is stable across regions. */
export function dayBucket(now: number): string {
  return new Date(now).toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Increment + check the per-user daily counter. Returns whether this send is
 * allowed and the post-increment count. The 4th call in a day returns
 * allowed=false. Best-effort: callers decide how to treat Redis errors.
 */
export async function consumeDailyQuota(
  redis: any,
  uid: string,
  now: number,
  limit = DAILY_LIMIT,
): Promise<{ allowed: boolean; count: number }> {
  const key = `notify:rl:${uid}:${dayBucket(now)}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, 60 * 60 * 25); // ~1 day (+slack) then auto-clears
  }
  return { allowed: count <= limit, count };
}

async function dispatchViaResend(to: string, type: EmailType): Promise<{ ok: boolean; status: number }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error('RESEND_API_KEY is not configured');
  }
  const { subject, html, text } = renderEmail(type);
  const res = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM || DEFAULT_FROM,
      to: [to],
      subject,
      html,
      text,
    }),
  });
  return { ok: res.ok, status: res.status };
}

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method Not Allowed' });
  }

  // 1) Authenticate — recipient comes from the verified token, not the body.
  let uid: string;
  let email: string | undefined;
  try {
    const decoded = await requireUser(request);
    uid = decoded.uid;
    email = decoded.email;
  } catch (error) {
    if (sendAuthError(response, error)) return;
    console.error('Notify auth error:', error);
    return response.status(500).json({ error: 'Internal Server Error' });
  }

  if (!email) {
    return response.status(400).json({ error: 'Authenticated account has no email address.' });
  }

  // 2) Validate the type enum. Clients may pass ONLY this.
  const type = request.body?.type;
  if (!isValidEmailType(type)) {
    return response.status(400).json({ error: `Invalid type. Allowed: ${EMAIL_TYPES.join(', ')}` });
  }

  // 3) Rate limit: <=3 per user per day.
  try {
    const redis = await getRedisClient();
    const { allowed, count } = await consumeDailyQuota(redis, uid, Date.now());
    if (!allowed) {
      console.warn(`Notify rate limit hit for uid=${uid} (count=${count})`);
      return response.status(429).json({ error: 'Daily email limit reached.' });
    }
  } catch (e) {
    // A rate-limiter outage must not silently open the floodgates: fail closed.
    console.error('Notify rate-limit error (failing closed):', e);
    return response.status(503).json({ error: 'Email service temporarily unavailable.' });
  }

  // 4) Dispatch via Resend. Recipient is redacted in every log line.
  try {
    const { ok, status } = await dispatchViaResend(email, type);
    if (!ok) {
      console.error(`Notify send failed: type=${type} to=${redactEmail(email)} providerStatus=${status}`);
      return response.status(502).json({ error: 'Email provider rejected the request.' });
    }
    console.log(`Notify sent: type=${type} to=${redactEmail(email)}`);
    return response.status(200).json({ success: true });
  } catch (error) {
    console.error(`Notify dispatch error: type=${type} to=${redactEmail(email)}`, (error as Error).message);
    return response.status(500).json({ error: 'Could not send email.' });
  }
}
