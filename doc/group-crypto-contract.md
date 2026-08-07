# Group Ride envelope crypto — cross-platform contract

**Status:** binding for 1.7.x. Implements `SCOPE_1.7.0.md` §5.3.
**Reference implementation:** `lib/group/crypto.ts`
**Shared fixture:** `tests/fixtures/group-crypto-vectors.json` (copied verbatim into every client repo)

The relay stores blobs it has no key for. This document is the definition of those blobs.
Three implementations must agree byte-for-byte; the fixture is what proves they do. A mismatch
here does not present as an error — it presents as *"the feature silently doesn't work"*, which
is why the vectors exist before any endpoint does.

---

## 1. The invite token

| | |
|---|---|
| Entropy | 16 random bytes (128 bits) |
| Encoding | base64url, **no padding** → exactly 22 chars |
| Alphabet | `A–Z a–z 0–9 - _` |
| Handling | **an opaque ASCII string.** Never decoded back to bytes for any purpose. |

Treating the token as a string end-to-end removes the single most likely port bug: two
platforms disagreeing about whether the KDF input is the 16 raw bytes or the 22 ASCII
characters. There is one canonical form and no decode step.

### Who generates the token

**The creating client — never the server.**

`SCOPE §4.5` describes `POST /api/group/create` as returning `inviteToken`. Taken literally
that would mean the server minted the key material, which voids §5.3 entirely: a relay that
generates the token can derive the key and read every position it stores. It also cannot work
mechanically, because `create` already carries an encrypted `meta` envelope in its body — the
client must therefore hold the key *before* it calls create.

The corrected flow:

1. Client generates the token locally.
2. Client derives the group key (§2).
3. Client encrypts `meta` and its own `roster` entry.
4. Client `POST`s `{ tokenHash, meta, roster, … }`. **The token itself is never in the request.**
5. Server stores `group:tok:{tokenHash} → groupId` and returns `{ groupId, joinCode, expiresAt, … }`.

The token reaches other members out of band: in the share link fragment (`/g/#<token>`, which
browsers never transmit) or alongside the join code. This is recorded as an amendment to §4.5
and must be reflected there.

### Token hash — the server's lookup key

```
tokenHash = lowercase_hex( SHA-256( utf8_bytes(token_string) ) )
```

64 hex characters. Note it hashes the **ASCII token**, not decoded entropy.

---

## 2. Key derivation

```
key = HKDF-SHA256(
        IKM  = utf8_bytes(token_string),
        salt = <empty>,                    // RFC 5869 §2.2: HashLen zero bytes
        info = utf8_bytes("trackme:group:v1"),
        L    = 32
      )
```

**Empty salt is deliberate.** The IKM is already 128 uniform bits and unique per group, and the
key must be derivable before a `groupId` exists (see step 3 above) — so there is no per-group
non-secret value available to salt with. This is standard HKDF; `tests/group-crypto.test.ts`
pins RFC 5869 test cases 1 and 3 so the configuration is verifiable against the public standard
rather than only against us.

**Android note.** There is no HKDF primitive below API 33 and `minSdk = 24`, so `GroupCrypto.kt`
must hand-roll extract/expand over `javax.crypto.Mac("HmacSHA256")`. Validate it against the
RFC vectors first, then against the fixture.

| Platform | Primitive |
|---|---|
| Node | `crypto.hkdfSync('sha256', …)` |
| Browser | `SubtleCrypto.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info })` |
| Android | manual HMAC-SHA256 extract + expand (1 block; L=32 ≤ 32) |
| iOS | `CryptoKit.HKDF<SHA256>.deriveKey(inputKeyMaterial:salt:info:outputByteCount:)` |

---

## 3. The envelope

```
v1.<base64url(nonce)>.<base64url(ciphertext || tag)>
```

| Field | Value |
|---|---|
| Cipher | AES-256-GCM |
| Nonce | 12 random bytes, **fresh per seal**, never reused under one key |
| Tag | 16 bytes, appended to the ciphertext |
| Encoding | base64url, no padding |
| Separator | `.` — outside the base64url alphabet, so the parse is unambiguous without padding |

The `ciphertext || tag` layout is what `SubtleCrypto` and `javax.crypto` produce natively, so no
platform has to splice the tag on by hand.

A reader **rejects** any envelope whose version prefix it does not know. `v1` is the only valid
value in 1.7.x; §2.9's reserved ETA/arrival fields go inside the plaintext JSON, not into a new
version.

### Nonce reuse is the one fatal mistake

Repeating a `(key, nonce)` pair under GCM leaks the XOR of the two plaintexts and destroys the
authentication guarantee. Positions are overwritten every ~10s for hours, so this path is hot.
**Always draw the nonce from the platform CSPRNG per seal.** Never derive it from a counter, a
timestamp, or the member id.

---

## 4. Associated data (AAD)

Every envelope is authenticated against a **context string**. The context is not encrypted and
not transmitted — the reader reconstructs it from where the envelope was found. It is the
mechanism that stops an untrusted relay moving ciphertext between slots.

| Purpose | Context | Where it lives |
|---|---|---|
| Group metadata | `v1:meta` | `group:{groupId}` → `meta` |
| Roster entry | `v1:roster:{uid}` | `group:{groupId}` → `roster[uid]` |
| Position | `v1:pos:{uid}` | `group:{groupId}:pos` → field `uid` |

`{uid}` is the Firebase uid, verbatim, UTF-8.

Without this, a relay could copy Alice's position envelope into Bob's hash field and Bob's
marker would silently teleport to Alice — a decryption that *succeeds* and produces a lie. With
it, the swap fails and Bob simply appears absent, which is the honest outcome and the one §8
already specifies for decryption failure.

---

## 5. Error handling

Every failure — malformed input, unknown version, wrong key, wrong context, tampering — raises
one opaque error. **Do not distinguish them to the caller.** Telling an attacker whether the key
or the context was wrong hands them half the answer for free.

On the map path, a failed `open` means *skip that member and log*; it must never fail the whole
render (§8, "Decryption failure on a member's envelope").

---

## 6. What the server can still see

Being explicit, so nobody over-claims in store copy or a launch post. The relay holds:

- `groupId`, `ownerUid`, and the plaintext `members` uid set — needed to enforce authorization
- `state`, `createdAt`, `expiresAt`, `maxMembers`, `syncIntervalSec`, `rev`
- the server-stamped `ts` per member, kept outside the envelope so staleness can be computed
  without a key and a skewed client clock cannot poison freshness for the group
- `tokenHash`, the join code, and request metadata (IP, user agent)

It does **not** hold: any coordinate, speed, heading, battery level, group name, display name,
photo URL, or destination.

So the honest claim is *"the relay cannot read where anyone is"* — not *"the relay knows
nothing"*. It knows that a set of uids were in a group together, and for how long. Eliminating
that would require anonymous credentials and is out of scope for 1.7.x.

---

## 7. Changing this document

The fixture is generated, not written:

```bash
npm run gen:group-crypto-vectors
```

Any change to the envelope format is a **breaking cross-platform change**. The sequence is:

1. Change `lib/group/crypto.ts`.
2. Regenerate the fixture. A diff in `tests/fixtures/group-crypto-vectors.json` is the signal.
3. Copy the fixture verbatim into `track-me-android` (and `track-me-ios` once it ports).
4. Re-run the vector test on **every** platform before merging any of them.
5. If the wire format itself changed, bump `ENVELOPE_VERSION` — old clients must reject the new
   format loudly rather than mis-parse it.

Skipping step 4 produces a release where two clients cannot see each other and neither logs an
error.
