const RESEND_BASE = 'https://api.resend.com';

function cfg() {
  const apiKey = process.env.RESEND_API_KEY;
  const audienceId = process.env.RESEND_AUDIENCE_ID;
  return apiKey && audienceId ? { apiKey, audienceId } : null;
}

export function emailConfigured(): boolean {
  return cfg() !== null;
}

/** Idempotent: creating an existing contact returns 409/200 — treat both as success. */
export async function upsertContact(email: string, opts?: { unsubscribed?: boolean }): Promise<{ id: string | null }> {
  const c = cfg();
  if (!c) return { id: null };
  const res = await fetch(`${RESEND_BASE}/audiences/${c.audienceId}/contacts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, unsubscribed: opts?.unsubscribed ?? false }),
  });
  if (res.status === 409) return { id: null };            // already a contact — fine
  if (!res.ok) throw new Error(`resend contact upsert ${res.status}`);
  const data: any = await res.json().catch(() => ({}));
  return { id: (data && (data.id || data.data?.id)) || null };
}

export async function createBroadcast(subject: string, html: string): Promise<{ id: string | null }> {
  const c = cfg();
  if (!c) return { id: null };
  const fromDomain = process.env.RESEND_FROM || 'updates@trackme.shvms.in';
  
  const res = await fetch(`${RESEND_BASE}/broadcasts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      audience_id: c.audienceId,
      from: `TrackMe <${fromDomain}>`,
      subject,
      html,
    }),
  });
  
  if (!res.ok) throw new Error(`resend broadcast create ${res.status}`);
  const data: any = await res.json().catch(() => ({}));
  return { id: (data && (data.id || data.data?.id)) || null };
}

export async function sendBroadcast(broadcastId: string): Promise<boolean> {
  const c = cfg();
  if (!c) return false;
  const res = await fetch(`${RESEND_BASE}/broadcasts/${broadcastId}/send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`resend broadcast send ${res.status}`);
  return true;
}
