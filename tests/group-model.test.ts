import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {
  CryptoVectorFile,
} from '../lib/group/crypto';
import {
  FREE_MAX_DURATION_MINUTES,
  FREE_MAX_MEMBERS,
  GroupRecord,
  JOIN_CODE_LENGTH,
  MAX_META_ENVELOPE_CHARS,
  MAX_ROSTER_ENVELOPE_CHARS,
  MIN_MAX_MEMBERS,
  PUBLIC_VIEW_FIELDS,
  allGroupKeys,
  decideJoin,
  generateJoinCode,
  groupCodeKey,
  groupKey,
  groupMembersKey,
  groupPosKey,
  groupRevKey,
  groupTokenKey,
  isValidEnvelope,
  isValidGroupId,
  isValidTokenHash,
  newGroupId,
  normalizeJoinCode,
  resolveDurationMinutes,
  resolveMaxMembers,
  toPublicView,
} from '../lib/group/model';

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (err) {
    failures.push(`${name}: ${(err as Error).message}`);
    process.stdout.write(`  ✗ ${name}\n`);
  }
}

const TOKEN_HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);
const NOW = 1_785_000_000_000;

function recordFixture(overrides: Partial<GroupRecord> = {}): GroupRecord {
  return {
    v: 1,
    groupId: '11111111-2222-4333-8444-555555555555',
    ownerUid: 'uid-owner',
    state: 'PREPARING',
    createdAt: NOW,
    expiresAt: NOW + 4 * 60 * 60 * 1000,
    maxMembers: 5,
    syncIntervalSec: 10,
    tokenHash: TOKEN_HASH,
    joinCode: 'ABC123',
    meta: 'v1.AAECAwQFBgcICQoL.' + 'A'.repeat(22),
    ...overrides,
  };
}

// --- Keys -------------------------------------------------------------------------------------

test('every group key is under the group: namespace', () => {
  // §10's privacy acceptance is "after a group ends, no key matching group:* remains" — which
  // only holds if every key we create actually matches that pattern.
  const keys = allGroupKeys('gid', TOKEN_HASH, 'ABC123');
  for (const k of keys) {
    assert.ok(k.startsWith('group:'), `${k} escapes the group: namespace`);
  }
});

test('allGroupKeys covers every key the store writes', () => {
  const keys = allGroupKeys('gid', TOKEN_HASH, 'ABC123');
  const expected = [
    groupKey('gid'),
    groupMembersKey('gid'),
    groupRevKey('gid'),
    groupPosKey('gid'),
    groupTokenKey(TOKEN_HASH),
    groupCodeKey('ABC123'),
  ];
  assert.deepStrictEqual([...keys].sort(), expected.sort());
  assert.strictEqual(new Set(keys).size, keys.length, 'duplicate key in the delete set');
});

test('the token key is derived from the hash, never a raw token', () => {
  assert.strictEqual(groupTokenKey(TOKEN_HASH), `group:tok:${TOKEN_HASH}`);
});

// --- Join codes -------------------------------------------------------------------------------

test('generated join codes use the Crockford alphabet at the stated length', () => {
  for (let i = 0; i < 500; i++) {
    const code = generateJoinCode();
    assert.strictEqual(code.length, JOIN_CODE_LENGTH);
    assert.match(code, /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}$/, `bad code: ${code}`);
  }
});

test('generated codes exclude I, L, O and U', () => {
  // The whole point of Crockford here is manual entry: those four are what people mistype.
  let seen = '';
  for (let i = 0; i < 2000; i++) seen += generateJoinCode();
  for (const ch of 'ILOU') {
    assert.ok(!seen.includes(ch), `alphabet leaked "${ch}"`);
  }
});

test('generated codes are well spread across the alphabet', () => {
  // A `% 32` on a raw byte would over-represent the first 8 symbols by 25%. This is the guard
  // for the rejection sampling that avoids it.
  const counts = new Map<string, number>();
  for (let i = 0; i < 4000; i++) {
    for (const ch of generateJoinCode()) counts.set(ch, (counts.get(ch) || 0) + 1);
  }
  assert.strictEqual(counts.size, 32, 'not every symbol was produced');
  const values = [...counts.values()];
  const min = Math.min(...values);
  const max = Math.max(...values);
  assert.ok(max / min < 1.5, `symbol distribution too skewed: ${min}..${max}`);
});

test('normalizeJoinCode accepts what a human actually types', () => {
  assert.strictEqual(normalizeJoinCode('abc123'), 'ABC123');
  assert.strictEqual(normalizeJoinCode('ABC 123'), 'ABC123');
  assert.strictEqual(normalizeJoinCode('ABC-123'), 'ABC123');
  assert.strictEqual(normalizeJoinCode(' abc-1 23 '), 'ABC123');
});

test('normalizeJoinCode maps the confusable letters onto their digits', () => {
  assert.strictEqual(normalizeJoinCode('IBC123'), '1BC123');
  assert.strictEqual(normalizeJoinCode('lBC123'), '1BC123');
  assert.strictEqual(normalizeJoinCode('OBC123'), '0BC123');
});

test('normalizeJoinCode rejects anything that is not a code', () => {
  for (const bad of ['', 'ABC12', 'ABC1234', 'ABC12!', 'UUUUUU', null, undefined, 42, {}]) {
    assert.strictEqual(normalizeJoinCode(bad as any), null, `accepted ${JSON.stringify(bad)}`);
  }
});

test('a generated code always survives its own normalizer', () => {
  for (let i = 0; i < 500; i++) {
    const code = generateJoinCode();
    assert.strictEqual(normalizeJoinCode(code), code, `round-trip failed for ${code}`);
  }
});

// --- Validation -------------------------------------------------------------------------------

test('token hash validation requires 64 lowercase hex', () => {
  assert.ok(isValidTokenHash(TOKEN_HASH));
  for (const bad of ['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), null, 42]) {
    assert.ok(!isValidTokenHash(bad as any), `accepted ${String(bad).slice(0, 20)}`);
  }
});

test('group id validation requires a UUID', () => {
  assert.ok(isValidGroupId(newGroupId()));
  for (const bad of ['', 'not-a-uuid', '11111111-2222-3333-4444', null, 42]) {
    assert.ok(!isValidGroupId(bad as any), `accepted ${String(bad)}`);
  }
});

test('every envelope in the shared crypto fixture passes the shape check', () => {
  // Binds this validator to GR-01's format. If the envelope layout changes and this is not
  // updated, real clients would start getting 400s — caught here rather than in production.
  const fixture: CryptoVectorFile = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'group-crypto-vectors.json'), 'utf8'),
  );
  for (const v of fixture.cases) {
    assert.ok(
      isValidEnvelope(v.envelope, MAX_META_ENVELOPE_CHARS),
      `rejected a real envelope from vector "${v.name}"`,
    );
  }
});

test('envelope validation rejects non-envelopes and oversize payloads', () => {
  const good = 'v1.AAECAwQFBgcICQoL' + '.' + 'A'.repeat(22);
  assert.ok(isValidEnvelope(good, MAX_META_ENVELOPE_CHARS));
  for (const bad of [
    '',
    'v2.AAECAwQFBgcICQoL.' + 'A'.repeat(22),  // wrong version
    'v1.tooshort.' + 'A'.repeat(22),          // nonce not 12 bytes
    'v1.AAECAwQFBgcICQoL.AAA',                // body shorter than a tag
    'v1.AAECAwQFBgcICQoL.' + 'A'.repeat(22) + '.extra',
    '{"lat":1,"lng":2}',                      // plaintext JSON — the thing we must never store
    null,
    42,
  ]) {
    assert.ok(!isValidEnvelope(bad as any, MAX_META_ENVELOPE_CHARS), `accepted ${String(bad)}`);
  }
  assert.ok(
    !isValidEnvelope('v1.AAECAwQFBgcICQoL.' + 'A'.repeat(5000), MAX_ROSTER_ENVELOPE_CHARS),
    'accepted an oversize envelope',
  );
});

// --- Limits -----------------------------------------------------------------------------------

test('duration falls back to the default when missing or unparseable', () => {
  for (const raw of [undefined, null, '', 'abc', 0, -5]) {
    const r = resolveDurationMinutes(raw);
    assert.ok(r.ok);
    assert.strictEqual(r.value, 240);
  }
});

test('duration over the free cap is rejected, not silently clamped', () => {
  // §11.2 wants the limit stated positively. A request for 8h that quietly becomes 4h shows the
  // user a countdown they never asked for.
  const r = resolveDurationMinutes(FREE_MAX_DURATION_MINUTES + 1);
  assert.strictEqual(r.ok, false);
  assert.ok(r.error && r.error.includes('4 hours'), `unhelpful error: ${r.error}`);
});

test('duration at exactly the cap is allowed', () => {
  assert.strictEqual(resolveDurationMinutes(FREE_MAX_DURATION_MINUTES).ok, true);
});

test('member cap over the free tier is rejected and names the cap', () => {
  const r = resolveMaxMembers(FREE_MAX_MEMBERS + 1);
  assert.strictEqual(r.ok, false);
  assert.ok(r.error && r.error.includes(String(FREE_MAX_MEMBERS)));
});

test('a group of one is refused', () => {
  // §8: a group of one never enters LIVE — there is nothing to be co-present with.
  const r = resolveMaxMembers(1);
  assert.strictEqual(r.ok, false);
  assert.ok(r.error && r.error.includes(String(MIN_MAX_MEMBERS)));
});

test('member cap falls back to the free maximum when unspecified', () => {
  assert.strictEqual(resolveMaxMembers(undefined).value, FREE_MAX_MEMBERS);
  assert.strictEqual(resolveMaxMembers(undefined).ok, true);
});

// --- Join decision ----------------------------------------------------------------------------

function decide(overrides: Parameters<typeof decideJoin>[0] extends infer T ? Partial<T> : never) {
  return decideJoin({
    record: recordFixture(),
    tokenHash: TOKEN_HASH,
    uid: 'uid-joiner',
    isExistingMember: false,
    memberCount: 2,
    nowMs: NOW,
    ...(overrides as any),
  });
}

test('a valid join into a group with room is allowed', () => {
  const d = decide({});
  assert.strictEqual(d.allowed, true);
  assert.strictEqual(d.rejoin, false);
});

test('a missing group is NOT_FOUND', () => {
  assert.deepStrictEqual(decide({ record: null }), {
    allowed: false, rejoin: false, reason: 'NOT_FOUND',
  });
});

test('the wrong token hash is refused', () => {
  assert.strictEqual(decide({ tokenHash: OTHER_HASH }).reason, 'BAD_TOKEN');
});

test('an ended group is refused', () => {
  assert.strictEqual(decide({ record: recordFixture({ state: 'ENDED' }) }).reason, 'ENDED');
});

test('an expired group is refused even if its state still says LIVE', () => {
  // The TTL is the backstop that always fires (§5.2). A record that outlives its expiry — a
  // clock skew, a TTL that has not swept yet — must not admit anyone.
  const d = decide({
    record: recordFixture({ state: 'LIVE', expiresAt: NOW - 1 }),
  });
  assert.strictEqual(d.reason, 'EXPIRED');
});

test('a full group is refused', () => {
  assert.strictEqual(decide({ memberCount: 5 }).reason, 'FULL');
});

test('an existing member is never locked out of their own full group', () => {
  // §8: the crash-recovery case. The member whose app was killed is exactly the one most likely
  // to come back to a group that has since filled up.
  const d = decide({ memberCount: 5, isExistingMember: true });
  assert.strictEqual(d.allowed, true);
  assert.strictEqual(d.rejoin, true);
});

test('joining a group that is already LIVE is allowed', () => {
  // §8: "Latecomers are the common case, not an error."
  assert.strictEqual(decide({ record: recordFixture({ state: 'LIVE' }) }).allowed, true);
});

test('capacity is checked against maxMembers, not the free cap', () => {
  // A leader who chose "up to 3" gets 3, even though the free tier allows 5.
  const record = recordFixture({ maxMembers: 3 });
  assert.strictEqual(decide({ record, memberCount: 3 }).reason, 'FULL');
  assert.strictEqual(decide({ record, memberCount: 2 }).allowed, true);
});

test('an ended group is refused before capacity is even considered', () => {
  // Ordering matters: reporting "full" for a group that no longer exists would leak that it
  // once did, and would send the client down a retry path instead of a clean exit.
  const d = decide({ record: recordFixture({ state: 'ENDED' }), memberCount: 99 });
  assert.strictEqual(d.reason, 'ENDED');
});

test('a bad token is refused before state or capacity', () => {
  const d = decide({
    record: recordFixture({ state: 'ENDED' }),
    tokenHash: OTHER_HASH,
    memberCount: 99,
  });
  assert.strictEqual(d.reason, 'BAD_TOKEN');
});

// --- Public view ------------------------------------------------------------------------------

test('the public view exposes exactly the fields §4.5 allows', () => {
  const view = toPublicView(recordFixture(), 3) as unknown as Record<string, unknown>;
  assert.deepStrictEqual(Object.keys(view).sort(), [...PUBLIC_VIEW_FIELDS].sort());
});

test('the public view leaks no ciphertext, no owner, and no credential', () => {
  // The single most important assertion in this file: resolve is unauthenticated, so anything
  // that reaches it reaches anyone who guesses a code.
  const record = recordFixture();
  const serialized = JSON.stringify(toPublicView(record, 3));
  for (const secret of [record.meta, record.ownerUid, record.tokenHash, record.joinCode]) {
    assert.ok(!serialized.includes(secret), `public view leaked "${secret.slice(0, 24)}"`);
  }
});

process.stdout.write(`\ngroup-model: ${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) {
  for (const f of failures) process.stderr.write(`  - ${f}\n`);
  process.exit(1);
}
