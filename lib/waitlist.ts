import { createHmac } from 'node:crypto';

// D1 — Pre-launch waitlist capture (web-v2).
//
// Pure, dependency-free logic for normalizing + validating a waitlist signup and
// deriving a privacy-preserving document id. Kept separate from the request
// handler so it is unit-testable and so the on-hold D2 (bulk launch send) can
// reuse the exact same normalization/hash contract when it attaches later.
//
// Privacy contract:
//   - The raw email NEVER leaves this process. We store only an HMAC-SHA-256
//     digest (keyed by a server-side pepper) as the Firestore document id.
//   - Plain SHA-256 of an email is enumerable (a rainbow table of common
//     addresses defeats it); the keyed HMAC + secret pepper make the stored id
//     non-reversible without the pepper.
//   - The digest is deterministic for a normalized address, which gives us
//     idempotent dedupe (same address -> same doc id -> create() collides).

/** Platforms a visitor may express interest in. Server-side allow-list — any
 *  other value collapses to 'unspecified' so a client cannot write arbitrary
 *  strings into Firestore or the telemetry event. */
export const WAITLIST_PLATFORMS = ['android', 'ios', 'web', 'unspecified'] as const;
export type WaitlistPlatform = (typeof WAITLIST_PLATFORMS)[number];

/** Max accepted length for the raw email field before validation (defensive
 *  bound against oversized bodies; RFC 5321 caps a path at 254). */
export const MAX_EMAIL_LENGTH = 254;

// Pragmatic, deliberately-not-clever email shape check. Full RFC 5322 validation
// is a known foot-gun; this rejects the obviously-invalid and defers real
// validation to the double-opt-in / send step (D2).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Normalize an email for hashing + dedupe.
 * Policy (documented so D2 hashes identically):
 *   - trim surrounding whitespace
 *   - Unicode NFC normalization (so visually identical addresses converge)
 *   - lowercase (addresses are treated case-insensitively for dedupe)
 * We intentionally do NOT strip Gmail dots / +tags: that is provider-specific
 * and would silently merge addresses the user considers distinct.
 */
export function normalizeEmail(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().normalize('NFC').toLowerCase();
}

/** True when the normalized email is a plausible address within length bounds. */
export function isValidEmail(normalized: string): boolean {
  if (!normalized || normalized.length > MAX_EMAIL_LENGTH) return false;
  return EMAIL_RE.test(normalized);
}

/** Coerce an arbitrary platform input to the server allow-list. */
export function normalizePlatform(raw: unknown): WaitlistPlatform {
  if (typeof raw === 'string') {
    const value = raw.trim().toLowerCase();
    if ((WAITLIST_PLATFORMS as readonly string[]).includes(value)) {
      return value as WaitlistPlatform;
    }
  }
  return 'unspecified';
}

/**
 * Derive the Firestore document id for a normalized email.
 * HMAC-SHA-256(pepper, normalizedEmail) -> hex. Deterministic (idempotent
 * dedupe) but non-enumerable without the pepper.
 */
export function hashEmail(normalizedEmail: string, pepper: string): string {
  if (!pepper) {
    throw new Error('WAITLIST_HASH_PEPPER is not configured');
  }
  return createHmac('sha256', pepper).update(normalizedEmail).digest('hex');
}

export interface WaitlistParseResult {
  ok: boolean;
  /** Present only when ok. The raw email — used ephemerally, never stored. */
  normalizedEmail?: string;
  emailHash?: string;
  platform?: WaitlistPlatform;
  /** Machine-readable failure reason (never contains the address). */
  error?: 'invalid_body' | 'invalid_email' | 'bot';
}

export interface WaitlistParseInput {
  email?: unknown;
  platform?: unknown;
  /** Honeypot field: must be empty. Bots that fill every input trip it. */
  company?: unknown;
}

/**
 * Validate + normalize a subscribe request body into everything the handler
 * needs, without touching Firestore/PostHog. Returns a redaction-safe result:
 * on failure it carries only a reason code, never the submitted address.
 */
export function parseWaitlistRequest(body: WaitlistParseInput, pepper: string): WaitlistParseResult {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'invalid_body' };
  }
  // Honeypot: a real user leaves this hidden field blank.
  if (typeof body.company === 'string' && body.company.trim() !== '') {
    return { ok: false, error: 'bot' };
  }
  const normalizedEmail = normalizeEmail(body.email);
  if (!isValidEmail(normalizedEmail)) {
    return { ok: false, error: 'invalid_email' };
  }
  const platform = normalizePlatform(body.platform);
  return {
    ok: true,
    normalizedEmail,
    emailHash: hashEmail(normalizedEmail, pepper),
    platform,
  };
}

/**
 * The provider-agnostic Firestore record. Deliberately stores NO raw address —
 * only the hash (which is also the doc id) plus consent metadata. `providerContactId`
 * is reserved for D2 so a bulk-send provider can attach its contact id later
 * without a schema migration or ever back-filling PII.
 */
export interface WaitlistRecord {
  emailHash: string;
  platform: WaitlistPlatform;
  status: 'pending';
  source: string;
  /** Reserved for D2 (bulk launch send). Null until a provider is wired. */
  providerContactId: string | null;
}

export function buildWaitlistRecord(
  emailHash: string,
  platform: WaitlistPlatform,
  source = 'web-v2',
): WaitlistRecord {
  return {
    emailHash,
    platform,
    status: 'pending',
    source,
    providerContactId: null,
  };
}
