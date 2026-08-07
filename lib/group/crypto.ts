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

/** HKDF `info` for the group key, derived from the invite token. */
export const HKDF_INFO = 'trackme:group:v1';

/**
 * HKDF `info` for the code key, derived from the join code. Distinct from `HKDF_INFO` so the
 * same string could never produce both keys — domain separation, not decoration.
 */
export const HKDF_CODE_INFO = 'trackme:group-code:v1';

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
export type EnvelopePurpose = 'meta' | 'roster' | 'pos' | 'code';

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
  return hkdf(token, HKDF_INFO);
}

function hkdf(ikmString: string, info: string): Buffer {
  return Buffer.from(
    crypto.hkdfSync(
      'sha256',
      Buffer.from(ikmString, 'utf8'),
      Buffer.alloc(0),
      Buffer.from(info, 'utf8'),
      KEY_LENGTH_BYTES,
    ),
  );
}

/**
 * AAD for an envelope. `memberUid` is required for `roster` and `pos` (the per-slot binding)
 * and must be absent for `meta` and `code`, which are group-wide.
 */
export function envelopeContext(purpose: EnvelopePurpose, memberUid?: string): string {
  if (purpose === 'meta' || purpose === 'code') {
    if (memberUid) throw new EnvelopeError(`${purpose} envelopes are group-wide and take no memberUid`);
    return `${ENVELOPE_VERSION}:${purpose}`;
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

// --- Join codes -------------------------------------------------------------------------------
//
// The join code lives here, not in `model.ts`, because under the wrapped-token design it *is*
// key material: `deriveCodeKey` feeds its exact bytes to HKDF. Anything that decides those bytes
// belongs in the file the other platforms port, and gets pinned by the shared fixture.

/**
 * Crockford base32: no I, L, O or U. 32^6 ≈ 1.07e9, matching §5.2's stated space, and the four
 * excluded letters are exactly the ones people mistype as 1/0 when reading a code aloud.
 */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const JOIN_CODE_LENGTH = 6;
export const JOIN_CODE_PATTERN = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}$/;

/** **Client-side only** — the server no longer mints codes; see the contract doc. */
export function generateJoinCode(): string {
  // Rejection-sampled so every symbol is equally likely; `% 32` on a raw byte would
  // over-represent the first eight by 25%.
  let code = '';
  while (code.length < JOIN_CODE_LENGTH) {
    for (const byte of crypto.randomBytes(JOIN_CODE_LENGTH)) {
      if (byte < 256 - (256 % CROCKFORD_ALPHABET.length)) {
        code += CROCKFORD_ALPHABET[byte % CROCKFORD_ALPHABET.length];
        if (code.length === JOIN_CODE_LENGTH) break;
      }
    }
  }
  return code;
}

/**
 * Canonicalises what a human actually types — lower case, spaces, dashes, and the confusable
 * letters the alphabet omits. Returns null if it still is not a code.
 *
 * **This is contract-critical.** The normalised form is both the Redis key and the HKDF input,
 * so a platform that skips normalisation derives a different key and silently decrypts nothing.
 */
export function normalizeJoinCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  return JOIN_CODE_PATTERN.test(cleaned) ? cleaned : null;
}

/**
 * `codeKey = HKDF-SHA256(utf8(normalisedJoinCode), salt = empty, info = HKDF_CODE_INFO, L = 32)`
 *
 * Takes the **normalised** code. Passing raw user input here is the silent-failure case above.
 */
export function deriveCodeKey(joinCode: string): Buffer {
  if (typeof joinCode !== 'string' || !JOIN_CODE_PATTERN.test(joinCode)) {
    throw new EnvelopeError('join code must be 6 normalised Crockford base32 characters');
  }
  return hkdf(joinCode, HKDF_CODE_INFO);
}

/**
 * Wraps the invite token so it can be handed to a code-joiner through the relay without the
 * relay ever holding key material.
 *
 * This is what makes join-by-code compatible with §5.3 at all: §2.4 requires the code to work as
 * a standalone path, but the code is not the group key, so a code-joiner would otherwise be
 * authorised and able to decrypt nothing. The relay stores this ciphertext and cannot open it;
 * only someone who knows the code can.
 *
 * The honest consequence, which §5.2 must be updated to reflect: **the join code is now a
 * security boundary.** 30 bits is weak in the abstract, and what makes it acceptable is that
 * `resolve?c=` is rate-limited to 5/min per client, the code dies after 30 minutes, and there is
 * no offline attack — you cannot obtain a wrapped token without already knowing its code.
 */
export function wrapTokenForCode(joinCode: string, token: InviteToken): string {
  assertToken(token);
  return seal(deriveCodeKey(joinCode), token, envelopeContext('code'));
}

/** Inverse of `wrapTokenForCode`. Throws `EnvelopeError` on a wrong code or a tampered wrapper. */
export function unwrapTokenWithCode(joinCode: string, wrapped: string): InviteToken {
  const token = open(deriveCodeKey(joinCode), wrapped, envelopeContext('code'));
  // A wrapper that authenticates but does not contain a token means the format drifted; better
  // to fail here than to feed junk into deriveGroupKey and get an unexplained blank map.
  assertToken(token);
  return token;
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
  hkdf: { info: string; codeInfo: string; keyLengthBytes: number; saltIsEmpty: true };
  cases: CryptoVectorCase[];
  codeCases: CodeVectorCase[];
}

/** Join-code token wrapping. Kept separate from `cases` because the key comes from a code. */
export interface CodeVectorCase {
  name: string;
  joinCode: string;
  codeKeyHex: string;
  context: string;
  inviteToken: string;
  nonceB64Url: string;
  wrappedToken: string;
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
