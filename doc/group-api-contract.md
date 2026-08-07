# Group Ride relay — API contract

**Status:** GR-03 ships `create`, `resolve`, `join`. `sync`, `state` and `leave` follow in GR-04/GR-05.
**Implements:** `SCOPE_1.7.0.md` §4.4, §4.5. Crypto: [group-crypto-contract.md](group-crypto-contract.md).

All routes live in one function, `api/group/[...action].ts`, following `api/export/[...action].ts`.
Authenticated routes take the same `Authorization: Bearer <firebase-id-token>` as everything else.

> **Use `getIdToken(false)`, not `true`.** §6.2 H2: the existing live-share code force-refreshes on
> every request. At a 10s group cadence that is a per-request cost and an unnecessary dependency on
> Firebase being up. Force-refresh only after a `401`.

---

## 1. Redis keys

Six per group, all expiring together at `expiresAt` (the join code expires sooner).

```
group:{groupId}            STRING  plaintext control fields + the encrypted `meta` envelope
group:{groupId}:members    HASH    field = uid, value = { role, joinedAt, roster }
group:{groupId}:rev        STRING  roster revision counter (INCR)
group:{groupId}:pos        HASH    field = uid, value = encrypted position envelope   (GR-04)
group:tok:{tokenHash}      STRING  → groupId
group:code:{joinCode}      STRING  → groupId       (TTL = min(session TTL, 30 min))
```

§4.4 sketches four keys. The two extra are `:members` and `:rev`, and they earn their place:
`:members` makes a join or leave a single-field write plus an `HLEN` capacity check instead of a
rewrite of a growing JSON blob, and `:rev` makes the roster revision an atomic `INCR`, which
removes the read-modify-write race §4.5 flags — everywhere, not just inside one script. Every
§4.4 invariant is unchanged: one TTL, positions overwritten never appended, and one `DEL` at the
end so §10's "no key matching `group:*` remains" still holds.

**Nothing touches Firestore.**

---

## 2. `POST /api/group/create`

Auth: member.

```jsonc
{
  "tokenHash": "<64 lowercase hex>",   // sha256(inviteToken). The token itself NEVER comes here.
  "durationMinutes": 240,              // optional, default 240, max 240
  "maxMembers": 5,                     // optional, default 5, min 2, max 5
  "meta": "v1.<nonce>.<body>",         // envelope, context `v1:meta`
  "roster": "v1.<nonce>.<body>"        // envelope, context `v1:roster:{yourUid}`
}
```

```jsonc
{
  "groupId": "<uuid>",
  "joinCode": "ABC123",
  "state": "PREPARING",
  "expiresAt": 1785014400000,
  "maxMembers": 5,
  "syncIntervalSec": 10,
  "memberCount": 1,
  "rev": 1
}
```

The creator is added as a member in the same atomic write — there is no separate "leader joins"
step, and a create that half-succeeded would present to a joiner as a group that resolves and then
404s.

| Status | Meaning |
|---|---|
| `400` | Bad `tokenHash`, malformed envelope, or a duration/size over the free cap. The body names the cap — §11.2 wants limits stated, not silently clamped. |
| `409 TOKEN_IN_USE` | That token hash already maps to a group. The client must mint a **new** token, not retry. |
| `503 REDIS_UNAVAILABLE` | See §6. |

---

## 3. `GET /api/group/resolve`

Auth: **none**. `?t=<tokenHash>` or `?c=<joinCode>`.

`t` is the token **hash**, computed client-side. Never send the raw token: a query string lands in
every access log, and §10 requires that the token never appears in one.

```jsonc
{ "groupId": "<uuid>", "state": "PREPARING", "memberCount": 3, "maxMembers": 5, "expiresAt": 1785014400000 }
```

Exactly those five fields — no name, no roster, no ciphertext, no owner — so an enumerated token or
a guessed code leaks nothing. `Cache-Control: no-store`: a stale member count is the difference
between "3 people are here" and joining a group that is already full.

Join codes are normalised before lookup: case-insensitive, spaces and dashes stripped, and
`I`/`L` → `1`, `O` → `0` per Crockford. The generated alphabet omits those letters precisely
because people mistype them.

| Status | Meaning |
|---|---|
| `404 GROUP_NOT_FOUND` | Miss, expired, ended, malformed, **or rate limited**. One body for all of them — §8: "Never 'wrong code' — don't leak whether the group exists." A throttled caller also gets `Retry-After`. |

**Rate limit:** code lookups are 5/min per client (§5.2), keyed on a truncated SHA-256 of the
caller's IP — enough to separate clients, useless as a record of who tried to join what. Token
lookups are unlimited; 128 bits is not brute-forceable.

---

## 4. `POST /api/group/join`

Auth: member.

```jsonc
{
  "groupId": "<uuid>",
  "tokenHash": "<64 lowercase hex>",
  "roster": "v1.<nonce>.<body>",       // envelope, context `v1:roster:{yourUid}`
  "viaCode": false                     // optional, telemetry only
}
```

```jsonc
{
  "groupId": "<uuid>", "state": "LIVE", "expiresAt": 1785014400000,
  "maxMembers": 5, "syncIntervalSec": 10, "memberCount": 4, "rev": 7,
  "rejoined": false
}
```

- **Joining a `LIVE` group is allowed.** §8: latecomers are the common case, not an error.
- **A member already in the group is exempt from the capacity check.** §8: a user must never be
  locked out of their own group by the cap. This is the crash-recovery path — the member whose app
  was killed is the one most likely to come back to a group that has since filled.
- `rejoined: true` means the caller was already a member; their roster envelope was refreshed and
  `rev` bumped so other clients refetch.
- The token hash is compared in constant time. It is the join credential, so a timing oracle on it
  would be a real way in.

| Status | Meaning |
|---|---|
| `400 TOKEN_HASH_REQUIRED` | See §5 — the open decision. |
| `404 GROUP_NOT_FOUND` | Missing, wrong token, ended, or expired — all one body (§8). |
| `409 GROUP_FULL` | Body carries `memberCount` and `maxMembers` so the client can say "This group is full (5 of 5)". |

---

## 5. ⚠️ Open decision — join-by-code cannot complete

§2.4 makes the 6-character code the guaranteed join path and §15.1 defers join-by-link to 1.7.1,
so in 1.7.x the code is the **only** path a customer has. But §5.3 derives the group key from the
**invite token**, and the code is not the token. Someone who joins by typing a code can be
authorised by the relay and still decrypt nothing — no group name, no roster, no positions.

The two sections are individually sound and jointly impossible. Nothing in GR-03 papers over it:
`create` mints and stores the code, `resolve?c=` looks it up, and `join` requires the token hash,
so the link path works end to end and the code path stops at a clear `400`.

Options, in the order I'd rank them:

**(a) Wrap the token under the code.** `group:code:{code}` stores `AES-GCM(HKDF(code), token)`
alongside the groupId. The relay holds ciphertext it has no key for; only someone holding the code
can unwrap it. Costs: the **client** must mint the code as well as the token (the server stops
generating it), the envelope contract and shared fixture each grow a case, and §5.2 needs
rewriting — under (a) the code *is* a security boundary, which §5.2 currently denies. 30 bits is
weak in the abstract, but it is rate-limited to 5/min/IP, dead after 30 minutes, and invalidated
once the group goes `LIVE`.

**(b) Pull App Links forward into 1.7.x** and make the link the only path — accepting that Digital
Asset Links verification is an external dependency that can slip a release. §6.1 B5 is explicit
that avoiding exactly this is why the code exists.

**(c) Drop E2E to the §5.3 fallback** — plaintext, same TTL, same delete-on-end — and change the
public claim from "we cannot read it" to "we do not retain it". §15.4 calls this genuinely
acceptable for a first release; it is also the largest product loss of the three.

**This needs deciding before GR-07**, because Android's `GroupCrypto.kt` is built against whichever
answer wins.

---

## 6. Failure contract

Group routes use `getStrictRedisClient()` and **never** fall back to the in-memory mock (§6.1 B2).

```jsonc
// 503
{ "error": "Group sharing is temporarily unavailable.", "code": "REDIS_UNAVAILABLE", "retryable": true }
```

Sent with `Retry-After: 5`. §8: the client backs off with jitter, holds the group in `DEGRADED`,
and keeps the user's own ride recording **completely unaffected**. A group failure must never
affect the user's own ride.

---

## 7. What is not covered by automated tests

`lib/group/model.ts` is pure and fully unit-tested (`npm run test:group-model`). **`lib/group/store.ts`
is not** — its Lua scripts need a live Redis, and there is none in this environment.

Specifically unverified: the `create` and `join` scripts' Redis syntax, `PEXPIREAT` on every key,
the atomic capacity check, the `EXISTS` guard that stops a join resurrecting an ended group, and
the `NOSCRIPT` → `EVAL` reload path.

§12 Phase 1 requires an integration pass driven by a simulated multi-member client. **That pass is
a release gate, not a nicety** — everything above is unexercised code until it runs.
