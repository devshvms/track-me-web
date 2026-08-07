import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  CryptoVectorFile,
  ENVELOPE_VERSION,
  EnvelopeError,
  KEY_LENGTH_BYTES,
  NONCE_LENGTH_BYTES,
  deriveGroupKey,
  envelopeContext,
  generateInviteToken,
  groupTokenHash,
  open,
  openFor,
  seal,
  sealFor,
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
