/**
 * Group Ride envelope crypto — Node reference implementation.
 *
 * The relay stores opaque blobs it has no key for (SCOPE_1.7.0 §5.3). This file is the
 * canonical definition of what those blobs look like; Android (`GroupCrypto.kt`), the web
 * viewer (`public/`), and later iOS must all reproduce it byte-for-byte. The shared fixture
 * `tests/fixtures/group-crypto-vectors.json` is what proves they do — change the format here
 * and you must regenerate the fixture and re-run every platform's vector test.
 *
 * Contract doc: `doc/group-crypto-contract.md`.
 *
 * Nothing in this file runs on the hot path. The server never calls seal/open — it cannot,
 * it has no key. This exists for the fixture, for the browser port to be checked against,
 * and for `groupTokenHash`, which the server *does* use as a lookup key.
 */

import crypto from 'crypto';

/** Envelope format version. Bump only for a breaking wire change; readers reject unknown versions. */
export const ENVELOPE_VERSION = 'v1';

/** HKDF `info` parameter. Domain-separates this key from any other use of the same token. */
export const HKDF_INFO = 'trackme:group:v1';

/** Raw entropy in an invite token, before base64url encoding. */
export const TOKEN_BYTES = 16;

/** AES-256-GCM. */
export const KEY_LENGTH_BYTES = 32;
export const NONCE_LENGTH_BYTES = 12;
export const TAG_LENGTH_BYTES = 16;

/**
 * Purpose half of the AAD. Binding each envelope to its purpose (and, where there is one, to
 * the member it belongs to) is what stops an untrusted relay swapping one ciphertext into
 * another slot — e.g. replaying Alice's position envelope into Bob's hash field. The context
 * string is authenticated, not encrypted; it is reconstructed by the reader, never transmitted.
 */
export type EnvelopePurpose = 'meta' | 'roster' | 'pos';

export class EnvelopeError extends Error {}

/** A 22-character base64url string. Treated as an opaque ASCII string everywhere — never re-decoded. */
export type InviteToken = string;

/**
 * Generate an invite token. **Client-side only.**
 *
 * The token is the key material, so the server must never see it: the creating client
 * generates it, derives the group key from it, and sends the relay only `groupTokenHash()`.
 * (SCOPE §4.5 reads as if `/api/group/create` mints the token and returns it — that would hand
 * the relay the key and void §5.3. The client mints it. See the contract doc, "Who generates
 * the token".)
 */
export function generateInviteToken(): InviteToken {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * Lookup key for `group:tok:{hash}`. Lowercase hex SHA-256 over the token's **ASCII bytes** —
 * not over the decoded entropy. One canonical form, no decode step, nothing for a port to
 * get subtly wrong.
 */
export function groupTokenHash(token: InviteToken): string {
  assertToken(token);
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * HKDF-SHA256 → 32-byte AES key.
 *
 * IKM  = UTF-8 bytes of the token string
 * salt = empty (RFC 5869 §2.2: HashLen zero bytes). The IKM is already 128 uniform bits and
 *        unique per group, and the key must be derivable before a groupId exists — the create
 *        call carries an already-encrypted `meta`.
 * info = HKDF_INFO
 */
export function deriveGroupKey(token: InviteToken): Buffer {
  assertToken(token);
  const ikm = Buffer.from(token, 'utf8');
  const salt = Buffer.alloc(0);
  const info = Buffer.from(HKDF_INFO, 'utf8');
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, KEY_LENGTH_BYTES));
}

/**
 * AAD for an envelope. `memberUid` is required for `roster` and `pos` (the per-slot binding)
 * and must be absent for `meta`.
 */
export function envelopeContext(purpose: EnvelopePurpose, memberUid?: string): string {
  if (purpose === 'meta') {
    if (memberUid) throw new EnvelopeError('meta envelopes are group-wide and take no memberUid');
    return `${ENVELOPE_VERSION}:meta`;
  }
  if (!memberUid) throw new EnvelopeError(`${purpose} envelopes require a memberUid`);
  return `${ENVELOPE_VERSION}:${purpose}:${memberUid}`;
}

/**
 * `v1.<base64url nonce>.<base64url ciphertext||tag>`
 *
 * Dot-separated because `.` is outside the base64url alphabet, so the parse is unambiguous
 * without padding. The tag is appended to the ciphertext — the layout both `SubtleCrypto` and
 * `javax.crypto` produce natively, so no platform has to splice it on by hand.
 *
 * `nonce` is exposed only so the fixture can pin it. Production callers omit it.
 */
export function seal(
  key: Buffer,
  plaintext: string,
  context: string,
  nonce: Buffer = crypto.randomBytes(NONCE_LENGTH_BYTES),
): string {
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new EnvelopeError(`key must be ${KEY_LENGTH_BYTES} bytes, got ${key.length}`);
  }
  if (nonce.length !== NONCE_LENGTH_BYTES) {
    throw new EnvelopeError(`nonce must be ${NONCE_LENGTH_BYTES} bytes, got ${nonce.length}`);
  }

  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce, {
    authTagLength: TAG_LENGTH_BYTES,
  });
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);

  return `${ENVELOPE_VERSION}.${nonce.toString('base64url')}.${body.toString('base64url')}`;
}

/**
 * Inverse of `seal`. Throws `EnvelopeError` on any malformed, wrong-context, or tampered
 * input — callers on the map path skip that one member rather than failing the whole render
 * (SCOPE §8, "Decryption failure on a member's envelope").
 */
export function open(key: Buffer, envelope: string, context: string): string {
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new EnvelopeError(`key must be ${KEY_LENGTH_BYTES} bytes, got ${key.length}`);
  }

  const parts = envelope.split('.');
  if (parts.length !== 3) {
    throw new EnvelopeError('malformed envelope: expected 3 dot-separated parts');
  }
  const [version, nonceB64, bodyB64] = parts;
  if (version !== ENVELOPE_VERSION) {
    throw new EnvelopeError(`unsupported envelope version "${version}"`);
  }

  const nonce = Buffer.from(nonceB64, 'base64url');
  const body = Buffer.from(bodyB64, 'base64url');
  if (nonce.length !== NONCE_LENGTH_BYTES) {
    throw new EnvelopeError(`malformed envelope: nonce is ${nonce.length} bytes`);
  }
  if (body.length < TAG_LENGTH_BYTES) {
    throw new EnvelopeError('malformed envelope: body shorter than the auth tag');
  }

  const ciphertext = body.subarray(0, body.length - TAG_LENGTH_BYTES);
  const tag = body.subarray(body.length - TAG_LENGTH_BYTES);

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce, {
      authTagLength: TAG_LENGTH_BYTES,
    });
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // Deliberately opaque: authentication failure and wrong-context are the same event to a
    // caller, and distinguishing them tells an attacker which half they got right.
    throw new EnvelopeError('envelope authentication failed');
  }
}

/** Convenience wrappers so call sites never hand-build a context string. */
export function sealFor(
  key: Buffer,
  plaintext: string,
  purpose: EnvelopePurpose,
  memberUid?: string,
): string {
  return seal(key, plaintext, envelopeContext(purpose, memberUid));
}

export function openFor(
  key: Buffer,
  envelope: string,
  purpose: EnvelopePurpose,
  memberUid?: string,
): string {
  return open(key, envelope, envelopeContext(purpose, memberUid));
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;

function assertToken(token: InviteToken): void {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
    throw new EnvelopeError('invite token must be 22 base64url characters');
  }
}

/** Shape of `tests/fixtures/group-crypto-vectors.json`, shared verbatim with the other repos. */
export interface CryptoVectorFile {
  version: string;
  note: string;
  hkdf: { info: string; keyLengthBytes: number; saltIsEmpty: true };
  cases: CryptoVectorCase[];
}

export interface CryptoVectorCase {
  name: string;
  token: string;
  tokenHashHex: string;
  keyHex: string;
  purpose: EnvelopePurpose;
  memberUid: string | null;
  context: string;
  plaintext: string;
  nonceB64Url: string;
  envelope: string;
}
