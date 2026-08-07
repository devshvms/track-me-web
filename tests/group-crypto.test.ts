import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  CROCKFORD_ALPHABET,
  CryptoVectorFile,
  ENVELOPE_VERSION,
  EnvelopeError,
  KEY_LENGTH_BYTES,
  NONCE_LENGTH_BYTES,
  JOIN_CODE_LENGTH,
  deriveCodeKey,
  deriveGroupKey,
  envelopeContext,
  generateInviteToken,
  generateJoinCode,
  groupTokenHash,
  normalizeJoinCode,
  open,
  openFor,
  seal,
  sealFor,
  unwrapTokenWithCode,
  wrapTokenForCode,
} from '../lib/group/crypto';

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

const fixturePath = path.join(__dirname, 'fixtures', 'group-crypto-vectors.json');
const vectors: CryptoVectorFile = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

// --- The shared fixture. Android and iOS run the equivalent of this block. ---

test('fixture is on the current envelope version', () => {
  assert.strictEqual(vectors.version, ENVELOPE_VERSION);
  assert.ok(vectors.cases.length > 0, 'fixture has no cases');
});

for (const v of vectors.cases) {
  test(`vector "${v.name}": token hash matches`, () => {
    assert.strictEqual(groupTokenHash(v.token), v.tokenHashHex);
  });

  test(`vector "${v.name}": HKDF derives the expected key`, () => {
    assert.strictEqual(deriveGroupKey(v.token).toString('hex'), v.keyHex);
  });

  test(`vector "${v.name}": context string matches`, () => {
    assert.strictEqual(envelopeContext(v.purpose, v.memberUid ?? undefined), v.context);
  });

  test(`vector "${v.name}": seal reproduces the envelope byte-for-byte`, () => {
    const key = Buffer.from(v.keyHex, 'hex');
    const nonce = Buffer.from(v.nonceB64Url, 'base64url');
    assert.strictEqual(seal(key, v.plaintext, v.context, nonce), v.envelope);
  });

  test(`vector "${v.name}": open recovers the plaintext`, () => {
    const key = Buffer.from(v.keyHex, 'hex');
    assert.strictEqual(open(key, v.envelope, v.context), v.plaintext);
  });
}

// --- Join codes and token wrapping ---
//
// The code is key material under the wrapped-token design, so everything that decides its exact
// bytes is pinned here rather than treated as a UI nicety.

test('fixture code vectors reproduce the code key and the wrapper byte-for-byte', () => {
  assert.ok(vectors.codeCases.length > 0, 'fixture has no code cases');
  for (const v of vectors.codeCases) {
    assert.strictEqual(deriveCodeKey(v.joinCode).toString('hex'), v.codeKeyHex, v.name);
    assert.strictEqual(envelopeContext('code'), v.context, v.name);
    const nonce = Buffer.from(v.nonceB64Url, 'base64url');
    assert.strictEqual(
      seal(Buffer.from(v.codeKeyHex, 'hex'), v.inviteToken, v.context, nonce),
      v.wrappedToken,
      v.name,
    );
    assert.strictEqual(unwrapTokenWithCode(v.joinCode, v.wrappedToken), v.inviteToken, v.name);
  }
});

test('the code key and the group key are never the same', () => {
  // Domain separation via the HKDF info string. If these ever collided, knowing a join code
  // would hand you the group key directly rather than via the wrapper.
  const token = generateInviteToken();
  const code = generateJoinCode();
  assert.notStrictEqual(deriveGroupKey(token).toString('hex'), deriveCodeKey(code).toString('hex'));
  // And the same six characters used as both inputs still derive differently.
  assert.notStrictEqual(
    deriveCodeKey('ABC123').toString('hex'),
    hkdfWithGroupInfo('ABC123'),
    'info string is not separating the two derivations',
  );
});

function hkdfWithGroupInfo(input: string): string {
  return Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(input, 'utf8'), Buffer.alloc(0),
      Buffer.from('trackme:group:v1', 'utf8'), 32),
  ).toString('hex');
}

test('a wrapped token round-trips through a fresh code', () => {
  const token = generateInviteToken();
  const code = generateJoinCode();
  assert.strictEqual(unwrapTokenWithCode(code, wrapTokenForCode(code, token)), token);
});

test('the wrong code cannot unwrap the token', () => {
  const token = generateInviteToken();
  const wrapped = wrapTokenForCode('ABC123', token);
  assert.throws(() => unwrapTokenWithCode('ABC124', wrapped), EnvelopeError);
});

test('a wrapper cannot be opened as any other envelope purpose', () => {
  // The relay holds both the wrapper and the meta envelope. Swapping them must fail rather than
  // produce something that parses.
  const code = generateJoinCode();
  const wrapped = wrapTokenForCode(code, generateInviteToken());
  assert.throws(() => openFor(deriveCodeKey(code), wrapped, 'meta'), EnvelopeError);
});

test('unwrapping rejects a payload that authenticates but is not a token', () => {
  // Guards the format drifting: feeding junk into deriveGroupKey would produce a blank map with
  // no error rather than a clear failure.
  const code = generateJoinCode();
  const notAToken = seal(deriveCodeKey(code), 'hello', envelopeContext('code'));
  assert.throws(() => unwrapTokenWithCode(code, notAToken), EnvelopeError);
});

test('deriveCodeKey refuses anything that is not an already-normalised code', () => {
  for (const bad of ['abc123', 'ABC-123', 'ABC12', 'ABCI23', 'ABCO23', 'ABCU23', '', 'ABC 123']) {
    assert.throws(() => deriveCodeKey(bad), EnvelopeError, `accepted "${bad}"`);
  }
});

test('generated join codes use the Crockford alphabet at the stated length', () => {
  for (let i = 0; i < 500; i++) {
    const code = generateJoinCode();
    assert.strictEqual(code.length, JOIN_CODE_LENGTH);
    assert.match(code, /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}$/, `bad code: ${code}`);
  }
});

test('generated codes exclude I, L, O and U', () => {
  let seen = '';
  for (let i = 0; i < 2000; i++) seen += generateJoinCode();
  for (const ch of 'ILOU') assert.ok(!seen.includes(ch), `alphabet leaked "${ch}"`);
});

test('generated codes are evenly spread across the alphabet', () => {
  // A `% 32` on a raw byte would over-represent the first eight symbols by 25%. This is the
  // guard for the rejection sampling that avoids it — and biased codes are weaker key material
  // now, not just uglier.
  const counts = new Map<string, number>();
  for (let i = 0; i < 4000; i++) {
    for (const ch of generateJoinCode()) counts.set(ch, (counts.get(ch) || 0) + 1);
  }
  assert.strictEqual(counts.size, CROCKFORD_ALPHABET.length, 'not every symbol was produced');
  const values = [...counts.values()];
  assert.ok(Math.max(...values) / Math.min(...values) < 1.5, 'symbol distribution too skewed');
});

test('normalizeJoinCode canonicalises what a human actually types', () => {
  for (const raw of ['abc123', 'ABC 123', 'ABC-123', ' abc-1 23 ']) {
    assert.strictEqual(normalizeJoinCode(raw), 'ABC123', `failed on "${raw}"`);
  }
  assert.strictEqual(normalizeJoinCode('IBC123'), '1BC123');
  assert.strictEqual(normalizeJoinCode('lBC123'), '1BC123');
  assert.strictEqual(normalizeJoinCode('OBC123'), '0BC123');
});

test('normalizeJoinCode rejects anything that is not a code', () => {
  for (const bad of ['', 'ABC12', 'ABC1234', 'ABC12!', 'UUUUUU', null, undefined, 42, {}]) {
    assert.strictEqual(normalizeJoinCode(bad as any), null, `accepted ${JSON.stringify(bad)}`);
  }
});

test('a generated code survives its own normalizer unchanged', () => {
  // If it did not, the creator and the joiner would derive different code keys from the same
  // six characters — a silent failure, which is the whole class this fixture exists to prevent.
  for (let i = 0; i < 500; i++) {
    const code = generateJoinCode();
    assert.strictEqual(normalizeJoinCode(code), code, `round-trip failed for ${code}`);
  }
});

test('a typed code that normalises to the creator code derives the same key', () => {
  const key = deriveCodeKey('ABC123').toString('hex');
  for (const typed of ['abc123', 'ABC-123', 'abc 123']) {
    assert.strictEqual(deriveCodeKey(normalizeJoinCode(typed)!).toString('hex'), key, typed);
  }
});

// --- HKDF is standard, not Node-specific ---

test('HKDF matches RFC 5869 test case 1 (SHA-256)', () => {
  // Android has no HKDF primitive before API 33 and will hand-roll extract/expand over
  // javax.crypto.Mac. Pinning the public RFC vectors here means that implementation can be
  // validated against the standard before it is ever pointed at our own fixture — if it
  // passes these and still disagrees with us, the bug is in the caller, not the KDF.
  const okm = crypto.hkdfSync(
    'sha256',
    Buffer.alloc(22, 0x0b),
    Buffer.from('000102030405060708090a0b0c', 'hex'),
    Buffer.from('f0f1f2f3f4f5f6f7f8f9', 'hex'),
    42,
  );
  assert.strictEqual(
    Buffer.from(okm).toString('hex'),
    '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
  );
});

test('HKDF matches RFC 5869 test case 3 — the empty-salt config we actually use', () => {
  const okm = crypto.hkdfSync('sha256', Buffer.alloc(22, 0x0b), Buffer.alloc(0), Buffer.alloc(0), 42);
  assert.strictEqual(
    Buffer.from(okm).toString('hex'),
    '8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8',
  );
});

// --- Properties the fixture cannot express ---

test('a fresh token round-trips through seal/open', () => {
  const token = generateInviteToken();
  const key = deriveGroupKey(token);
  const plaintext = JSON.stringify({ lat: 51.5072, lng: -0.1276, moving: true });
  assert.strictEqual(openFor(key, sealFor(key, plaintext, 'pos', 'uid-x'), 'pos', 'uid-x'), plaintext);
});

test('generated tokens are 22 base64url chars and unique', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const token = generateInviteToken();
    assert.match(token, /^[A-Za-z0-9_-]{22}$/, `bad token shape: ${token}`);
    assert.ok(!seen.has(token), 'generateInviteToken repeated a value');
    seen.add(token);
  }
});

test('sealing twice never reuses a nonce', () => {
  const key = deriveGroupKey(generateInviteToken());
  const nonces = new Set<string>();
  for (let i = 0; i < 200; i++) {
    nonces.add(sealFor(key, 'x', 'meta').split('.')[1]);
  }
  assert.strictEqual(nonces.size, 200, 'nonce collision in 200 seals');
});

test('derived key is 32 bytes', () => {
  assert.strictEqual(deriveGroupKey(generateInviteToken()).length, KEY_LENGTH_BYTES);
});

test('envelope carries a 12-byte nonce', () => {
  const key = deriveGroupKey(generateInviteToken());
  const nonce = Buffer.from(sealFor(key, 'x', 'meta').split('.')[1], 'base64url');
  assert.strictEqual(nonce.length, NONCE_LENGTH_BYTES);
});

// --- Negative cases. Each of these is an attack the relay could mount. ---

test('a different token cannot open the envelope', () => {
  const key = deriveGroupKey(generateInviteToken());
  const envelope = sealFor(key, 'secret', 'meta');
  const otherKey = deriveGroupKey(generateInviteToken());
  assert.throws(() => openFor(otherKey, envelope, 'meta'), EnvelopeError);
});

test('a position envelope cannot be replayed into another member slot', () => {
  // The relay holds every member's ciphertext and could swap Alice's into Bob's hash field.
  // The per-member AAD is what makes that fail instead of silently teleporting Bob.
  const key = deriveGroupKey(generateInviteToken());
  const alice = sealFor(key, JSON.stringify({ lat: 1, lng: 2 }), 'pos', 'uid-alice');
  assert.throws(() => openFor(key, alice, 'pos', 'uid-bob'), EnvelopeError);
});

test('a roster envelope cannot be opened as a position envelope', () => {
  const key = deriveGroupKey(generateInviteToken());
  const roster = sealFor(key, JSON.stringify({ displayName: 'Alice' }), 'roster', 'uid-alice');
  assert.throws(() => openFor(key, roster, 'pos', 'uid-alice'), EnvelopeError);
});

test('tampering with the ciphertext is detected', () => {
  const key = deriveGroupKey(generateInviteToken());
  const [version, nonce, body] = sealFor(key, 'secret', 'meta').split('.');
  const bytes = Buffer.from(body, 'base64url');
  bytes[0] ^= 0x01;
  assert.throws(
    () => openFor(key, `${version}.${nonce}.${bytes.toString('base64url')}`, 'meta'),
    EnvelopeError,
  );
});

test('tampering with the nonce is detected', () => {
  const key = deriveGroupKey(generateInviteToken());
  const [version, nonce, body] = sealFor(key, 'secret', 'meta').split('.');
  const bytes = Buffer.from(nonce, 'base64url');
  bytes[0] ^= 0x01;
  assert.throws(() => openFor(key, `${version}.${bytes.toString('base64url')}.${body}`, 'meta'), EnvelopeError);
});

test('an unknown envelope version is rejected rather than guessed', () => {
  const key = deriveGroupKey(generateInviteToken());
  const [, nonce, body] = sealFor(key, 'secret', 'meta').split('.');
  assert.throws(() => openFor(key, `v2.${nonce}.${body}`, 'meta'), EnvelopeError);
});

test('malformed envelopes throw EnvelopeError, never a raw crypto error', () => {
  const key = deriveGroupKey(generateInviteToken());
  for (const bad of ['', 'v1', 'v1.abc', 'v1.abc.def.ghi', 'v1..', 'v1.AAECAwQFBgcICQoL.AA']) {
    assert.throws(() => openFor(key, bad, 'meta'), EnvelopeError, `accepted "${bad}"`);
  }
});

test('failure messages do not distinguish wrong key from wrong context', () => {
  // Telling an attacker which half they got right is free information. Both paths report
  // the same string.
  const key = deriveGroupKey(generateInviteToken());
  const envelope = sealFor(key, 'secret', 'pos', 'uid-alice');
  const wrongKey = (() => {
    try { openFor(deriveGroupKey(generateInviteToken()), envelope, 'pos', 'uid-alice'); } catch (e) { return (e as Error).message; }
  })();
  const wrongContext = (() => {
    try { openFor(key, envelope, 'pos', 'uid-bob'); } catch (e) { return (e as Error).message; }
  })();
  assert.strictEqual(wrongKey, wrongContext);
});

// --- Context construction guards ---

test('meta envelopes reject a memberUid, pos/roster require one', () => {
  assert.throws(() => envelopeContext('meta', 'uid-alice'), EnvelopeError);
  assert.throws(() => envelopeContext('pos'), EnvelopeError);
  assert.throws(() => envelopeContext('roster'), EnvelopeError);
});

test('token validation rejects wrong shapes', () => {
  for (const bad of ['', 'short', 'Zm9vYmFyYmF6cXV4MTIzNA==', 'Zm9vYmFyYmF6cXV4MTIzN$']) {
    assert.throws(() => deriveGroupKey(bad), EnvelopeError, `accepted token "${bad}"`);
    assert.throws(() => groupTokenHash(bad), EnvelopeError, `accepted token "${bad}"`);
  }
});

process.stdout.write(`\ngroup-crypto: ${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) {
  for (const f of failures) process.stderr.write(`  - ${f}\n`);
  process.exit(1);
}
