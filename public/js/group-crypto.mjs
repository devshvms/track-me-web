/**
 * Group Ride envelope crypto — browser implementation.
 *
 * The third implementation of `doc/group-crypto-contract.md`, after `lib/group/crypto.ts` and
 * (soon) Android's `GroupCrypto.kt`. §5.3 names a three-way byte-for-byte mismatch as the crypto
 * design's main risk, and it fails silently — so this is verified against the shared fixture by
 * `tests/group-crypto-web.test.mjs`, which runs it on Node's Web Crypto: the same standard API
 * the browser exposes, not a re-implementation.
 *
 * **Read-only on purpose.** The landing page decrypts a group name; it never seals anything, and
 * it never touches the join-code path (that is an in-app flow). Sealing and code-unwrapping are
 * deliberately absent rather than written and unused — §2.9's dead-code hazard is exactly how
 * the iOS `ExportPreviewView` ended up with no call sites and a broken distance function.
 *
 * The token arrives in the **URL fragment**, which browsers never transmit. That is what lets
 * this page decrypt while the server still cannot (§4.8).
 */

const ENVELOPE_VERSION = 'v1';
const HKDF_INFO = 'trackme:group:v1';
const NONCE_LENGTH_BYTES = 12;
const TAG_LENGTH_BYTES = 16;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export class EnvelopeError extends Error {}

const utf8 = (s) => new TextEncoder().encode(s);

function assertToken(token) {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
    throw new EnvelopeError('invite token must be 22 base64url characters');
  }
}

/** base64url → bytes. `atob` only speaks standard base64, and our envelopes are unpadded. */
function fromBase64Url(value) {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Lowercase hex SHA-256 over the token's ASCII bytes — the relay's lookup key. */
export async function groupTokenHash(token) {
  assertToken(token);
  return toHex(await crypto.subtle.digest('SHA-256', utf8(token)));
}

/**
 * HKDF-SHA256 with an empty salt, per the contract. `deriveBits` rather than `deriveKey` so the
 * result can be compared against the fixture's `keyHex` — a key handle would be opaque, and an
 * unverifiable derivation is the whole failure mode this fixture exists to prevent.
 */
export async function deriveGroupKey(token) {
  assertToken(token);
  const material = await crypto.subtle.importKey('raw', utf8(token), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(HKDF_INFO) },
      material,
      256,
    ),
  );
}

export function envelopeContext(purpose, memberUid) {
  if (purpose === 'meta' || purpose === 'code') {
    if (memberUid) throw new EnvelopeError(`${purpose} envelopes take no memberUid`);
    return `${ENVELOPE_VERSION}:${purpose}`;
  }
  if (!memberUid) throw new EnvelopeError(`${purpose} envelopes require a memberUid`);
  return `${ENVELOPE_VERSION}:${purpose}:${memberUid}`;
}

/**
 * `v1.<nonce>.<ciphertext||tag>` → plaintext.
 *
 * Web Crypto expects the tag appended to the ciphertext, which is exactly the layout the
 * contract specifies, so nothing is spliced by hand here.
 *
 * Every failure — malformed, wrong version, wrong key, wrong context, tampered — raises the same
 * opaque error. Distinguishing them would tell an attacker which half they got right.
 */
export async function open(keyBytes, envelope, context) {
  const parts = String(envelope).split('.');
  if (parts.length !== 3) throw new EnvelopeError('malformed envelope');
  const [version, nonceB64, bodyB64] = parts;
  if (version !== ENVELOPE_VERSION) throw new EnvelopeError('unsupported envelope version');

  let nonce;
  let body;
  try {
    nonce = fromBase64Url(nonceB64);
    body = fromBase64Url(bodyB64);
  } catch {
    throw new EnvelopeError('malformed envelope');
  }
  if (nonce.length !== NONCE_LENGTH_BYTES || body.length < TAG_LENGTH_BYTES) {
    throw new EnvelopeError('malformed envelope');
  }

  try {
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: utf8(context), tagLength: TAG_LENGTH_BYTES * 8 },
      key,
      body,
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new EnvelopeError('envelope authentication failed');
  }
}

export async function openFor(keyBytes, envelope, purpose, memberUid) {
  return open(keyBytes, envelope, envelopeContext(purpose, memberUid));
}

/** The token as it arrives from the fragment, or null. Never read from the query string. */
export function tokenFromFragment(hash) {
  const raw = String(hash || '').replace(/^#/, '').trim();
  return TOKEN_PATTERN.test(raw) ? raw : null;
}
