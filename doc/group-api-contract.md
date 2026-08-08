# Group Ride relay — API contract

**Status:** all six routes are live — `create`, `resolve`, `join`, `sync`, `state`, `leave`.
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
group:code:{joinCode}      STRING  → { groupId, wrappedToken }   (TTL = min(session TTL, 30 min))
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
  "joinCode": "ABC123",                // client-minted, 6 Crockford base32, already normalised
  "wrappedToken": "v1.<nonce>.<body>", // seal(HKDF(joinCode), inviteToken, "v1:code")
  "durationMinutes": 240,              // optional, default 240, max 240
  "maxMembers": 5,                     // optional, default 5, min 2, max 5
  "meta": "v1.<nonce>.<body>",         // envelope, context `v1:meta`
  "roster": "v1.<nonce>.<body>"        // envelope, context `v1:roster:{yourUid}`
}
```

**The client mints the join code, not the server.** It has to: the wrapper is keyed on the code,
so the server cannot invent a code the client has already wrapped a token under. That also moves
collision handling client-side — see `409 CODE_IN_USE` below.

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
| `409 CODE_IN_USE` | Join-code collision (~1 in 1e9). The client retries with a fresh code, which means a **fresh wrapper** — the code key changed. |
| `503 REDIS_UNAVAILABLE` | See §6. |

---

## 3. `GET /api/group/resolve`

Auth: **none**. `?t=<tokenHash>` or `?c=<joinCode>`.

`t` is the token **hash**, computed client-side. Never send the raw token: a query string lands in
every access log, and §10 requires that the token never appears in one.

```jsonc
{ "groupId": "<uuid>", "state": "PREPARING", "memberCount": 3, "maxMembers": 5, "expiresAt": 1785014400000 }
```

On the **`?c=` path only**, one extra field:

```jsonc
{ ..., "wrappedToken": "v1.<nonce>.<body>" }
```

That is the invite token sealed under the code the caller just supplied — useless to anyone who
does not already know that code, and the only way a code-joiner can obtain the group key. A
caller resolving by token already holds the token, so the `?t=` path never returns it.

Otherwise exactly those five fields — no name, no roster, no owner — so an enumerated token or
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
| `400 TOKEN_HASH_REQUIRED` | No valid hash supplied. A code-joiner reaches `join` with a real hash too — they unwrap it from `resolve?c=` first (§5). There is no separate code path through this route. |
| `404 GROUP_NOT_FOUND` | Missing, wrong token, ended, or expired — all one body (§8). |
| `409 GROUP_FULL` | Body carries `memberCount` and `maxMembers` so the client can say "This group is full (5 of 5)". |

The response includes `meta` — the group-metadata envelope. It is the only place the group's
name exists, and a joiner has no other way to obtain it.

---

## 4b. `POST /api/group/sync` — the hot path

Auth: member.

```jsonc
{
  "groupId": "<uuid>",
  "pos": "v1.<nonce>.<body>",   // OPTIONAL — envelope, context `v1:pos:{yourUid}`
  "moving": true,               // from the device motion sensor
  "foreground": true,           // is the user actually looking at the map
  "rev": 7                      // the roster revision you last saw
}
```

```jsonc
{
  "groupId": "<uuid>",
  "state": "LIVE",
  "expiresAt": 1785014400000,
  "rev": 7,
  "maxMembers": 5,
  "positions": {
    "uid-alice": { "e": "v1.<nonce>.<body>", "ts": 1785000000000 },
    "uid-bob":   { "e": "v1.<nonce>.<body>", "ts": 1785000000000 }
  },
  "nextSyncInSec": 10,
  "roster": { "uid-alice": "v1.<nonce>.<body>" },   // ONLY when your `rev` was stale
  "meta":   "v1.<nonce>.<body>"                     // sent alongside `roster`
}
```

**One call, both directions** (§4.3). Half the invocations of a push endpoint plus a polled pull,
one round trip to see a change, and worst-case staleness bounded by the push interval alone
rather than push + poll + cache TTL.

**`pos` is optional.** §8: when location permission is revoked mid-session the member stops
pushing but stays in the group as a viewer, and the app says so — *"You're not sharing your
location. Others can't see you."* Symmetry made visible rather than hidden.

**`ts` is server-stamped, always.** §4.4 and §8: staleness must be computable without decrypting,
and a client with a skewed clock must not be able to poison freshness for the group. The client
sends no timestamp and should ignore its own clock when rendering ages.

**Your own entry is included in `positions`.** §4.1 has the client filter itself out — one
`filter` is free. Leaving it in is deliberate beyond that: the relay is opaque to us by
construction (§15.4), so this is the only way a client can confirm its own push landed. That
diagnostic has to exist before the first support ticket, not after.

**`roster` and `meta` are sent only when your `rev` is stale.** On most syncs they are absent,
which is what keeps the response near §7.3's ~1.5 KB budget.

**Obey `nextSyncInSec`.** §7.1, server-computed:

| Member state | Interval |
|---|---|
| group is `PREPARING` | 30s — the lobby needs a heartbeat, not a stream |
| stationary (checked before foreground) | 60s |
| foreground **and** moving | 10s |
| backgrounded, moving | 20s |

The server decides so cadence is a lever with no client release (§4.3) — the single most
important cost control in the design. `state: "ENDED"` returns `nextSyncInSec: 0`, meaning stop.

**Ghost sweep.** A position not refreshed for 10 minutes is deleted server-side and disappears
from `positions` — §2.6's "they drop off the map but stay in the roster". The roster is
untouched, because *vanished* and *stopped moving* mean very different things to someone waiting
at a junction.

| Status | Meaning |
|---|---|
| `403 NOT_A_MEMBER` | §5.2, "departed member keeps polling": they still hold the derived key, so authorisation is the enforcement point, not crypto. Treat as "you are out of this group". |
| `404 GROUP_NOT_FOUND` | The group is gone entirely. |
| `429 SYNC_TOO_FAST` | Position writes are floored at 1s. Only reachable by ignoring `nextSyncInSec`. |
| `503 REDIS_UNAVAILABLE` | See §6. |

An expired-but-not-yet-swept group reads as `state: "ENDED"` with empty positions, never as an
error — §8 wants Group Mode off cleanly while **the ride keeps recording**.

**Cost.** Modelled at 228 syncs/member-hour on §7.2's 40/40/20 blend, ~1,140 per group-hour for
five people. `modelledSyncsPerMemberHour()` computes that from the constants the server actually
serves, and a test asserts it against §7.2's figures, so the doc cannot drift from the code.

---

## 4c. `POST /api/group/state`

Auth: **leader only** (`403 NOT_THE_LEADER` otherwise). Body `{ groupId, state }` where `state`
is `LIVE` or `ENDED`.

- **`PREPARING → LIVE`** flips every member's Home into Group Mode. Idempotent — a retried
  "Start group" after a dropped response returns `200`, not an error.
- **`→ ENDED`** deletes **every** server-side key for the group immediately (§2.7), then answers.
  By the time the client gets `200`, nothing is left.

**A group of one never enters `LIVE`** (§8) — `409 GROUP_OF_ONE`. Enforced server-side so it is a
property of the feature rather than of one client.

The `LIVE` swap is a compare-and-swap against the exact bytes Redis held, and it re-applies the
key's remaining TTL: Redis `SET` clears an expiry, so without that, "Start group" would silently
turn a 4-hour session into a permanent one and break §5.1.2 in the least visible way available.

## 4d. `POST /api/group/leave`

Auth: member. Body `{ groupId }`. Returns `{ left: true, endedGroup: bool }`.

> ### The exit is sacred and silent
>
> §5.1.3 — the single most important line in the spec. Leaving is one tap, always reachable, and
> **emits no notification to anyone**. The member simply ceases to appear. A person who needs to
> go dark must be able to, without escalation.
>
> **This route must never gain a broadcast.** §5.1.3 names "engagement reasons" as the argument
> that will eventually be made for adding one. `tests/group-store-scripts.test.ts` reads the
> handler source and fails on any notification call or on a response body carrying a roster,
> member count, or position — both cases are mutation-tested. A reviewer can miss a push call
> added to a long route file; by the time anyone notices, the harm has already reached the person
> the invariant exists to protect.

- The `rev` bump is **not** a notification. It tells other clients the roster changed, which is
  unavoidable — the leaver must stop appearing. Nobody is told that anyone left, or who. §5.2
  already accepts this: "a silent lurker is not achievable without also being visibly absent."
- The analytics event is **not** a broadcast. §9 requires leave-rate and time-to-first-leave to be
  tracked with equal seriousness to the growth funnel, and is explicit that heavy use of the exit
  is a *healthy* signal — nobody should ever be tasked with reducing it.
- **The leader leaving ends the group for everyone** (§8), and the client's confirm dialog must
  say exactly that before calling. Response carries `endedGroup: true`.
- **The last member leaving deletes the group**, in the same script. An empty group is not a
  group, and waiting for the TTL would leave real session state alive for hours.
- Leaving a group that is already gone returns `200`, not an error. The caller is out, which is
  what they asked for; leaving must never fail in a way that leaves someone stuck visible.

---

## 4e. Rate limits (§5.2)

| Surface | Limit | Keyed on |
|---|---|---|
| `resolve?c=` | 5 / minute | truncated SHA-256 of the caller's IP |
| `join` | 20 / hour | uid |
| `sync` position writes | 1 / second floor | uid, inside the script |

`resolve?c=` is unauthenticated so it can only be limited by IP; `join` is where a per-account
bound can exist, and it caps how far a guessed code actually gets. 20/hour is deliberately
generous — a client recovering from repeated crashes re-joins its own group, and §8 requires that
never be blocked.

**Rate-limit keys live under `rl:gride:`, not `group:`.** §10's privacy acceptance is verified by
inspecting Redis for keys matching `group:*` after a session ends; a counter in that namespace
would make a passing system look like a failing one, or worse, train whoever runs the check to
ignore hits. `group:*` means group session state and nothing else.

---

## 5. Join-by-code, resolved

**Decision (2026-08-08): option (a), token wrapped under the code.**

§2.4 makes the code the guaranteed join path and §15.1 defers join-by-link to 1.7.1, so in 1.7.x
the code is the only path a customer has. But §5.3 derives the group key from the invite *token*,
which a code-joiner never sees — so without this they would be authorised by the relay and able
to decrypt nothing.

The full client flow:

1. **Create.** Mint `inviteToken` (22 base64url) and `joinCode` (6 Crockford). Derive
   `codeKey = HKDF(joinCode, info="trackme:group-code:v1")`. Compute
   `wrappedToken = seal(codeKey, inviteToken, "v1:code")` and `tokenHash = sha256(inviteToken)`.
   `POST create` with `{ tokenHash, joinCode, wrappedToken, meta, roster }`.
2. **Join by code.** Normalise the typed code. `GET resolve?c=<code>` → `{ …, wrappedToken }`.
   Derive `codeKey` from the same normalised code, `unwrapTokenWithCode` → `inviteToken`. From
   here it is identical to a link join: derive the group key, compute `tokenHash`, `POST join`.
3. **Join by link** (1.7.1). The token arrives in the URL fragment; skip straight to step 2's
   second half.

The relay holds neither the code nor the token — only ciphertext for which it has neither input.

**The cost, stated plainly: the join code is now a security boundary.** §5.2 currently says it is
"a convenience, never the security boundary", and that sentence needs replacing. What makes 30
bits acceptable: there is **no offline attack** (a wrapper cannot be obtained without already
knowing its code), the only route is `resolve?c=` at **5/min per client**, and the code **dies
after 30 minutes**.

### ⚠️ Still open: evicting the code when the group goes LIVE

§5.2 says the code is invalidated once the group goes `LIVE`. Under this design that directly
contradicts §8's *"Joining a group that is already `LIVE` — allowed. Latecomers are the common
case, not an error"*, because the code is the only join path in 1.7.x. Either latecomers cannot
join at all this release, or the code lives out its 30 minutes regardless of state.

**Recommendation: keep it for the 30 minutes.** The TTL is the real bound, and §8 is a product
promise. Needs settling before GR-05 implements `state`.

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

`tests/group-store-scripts.test.ts` statically checks what can be checked without a Redis:
declared vs. referenced `KEYS[n]`/`ARGV[n]` arity (the silent-nil bug — an out-of-range `ARGV[n]`
reads as `nil`, so a renumbering slip makes a capacity check always pass with no error), balanced
`if`/`end`, known command names, no key literals built inside Lua, ordering invariants
(membership before read, capacity before write), and that every key written is also given an
expiry. `runScript` re-checks the arity at runtime. Both guards are mutation-tested.

That replaces a class of typo, not the integration pass. Specifically still unverified: the
scripts' actual Redis behaviour, `PEXPIREAT` on every key,
the JSON code entry round-tripping through `group:code:{joinCode}`, the atomic capacity check,
the `EXISTS` guard that stops a join resurrecting an ended group, and the `NOSCRIPT` → `EVAL`
reload path.

§12 Phase 1 requires an integration pass driven by a simulated multi-member client. **That pass is
a release gate, not a nicety** — everything above is unexercised code until it runs.
