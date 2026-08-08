import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EnvelopeError,
  deriveGroupKey,
  envelopeContext,
  groupTokenHash,
  open,
  openFor,
  tokenFromFragment,
} from '../public/js/group-crypto.mjs';

/**
 * The browser implementation, checked against the same fixture as the Node one.
 *
 * §5.3: three implementations must agree byte-for-byte, and a mismatch presents as "the feature
 * silently doesn't work" rather than an error. This runs `public/js/group-crypto.js` unmodified
 * on Node's Web Crypto — the same standard API the browser exposes — so what is tested here is
 * the file the browser actually loads, not a port of it.
 *
 * Run as .mjs (like `posthog-state.test.mjs`) because the module under test is an ES module the
 * page imports directly.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The page runs in a browser; Node has no `atob`. Node 16+ provides it globally, but pin it so a
// runtime change cannot quietly break the module the browser depends on.
assert.strictEqual(typeof atob, 'function', 'this Node build has no atob — the module needs one');

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    process.stdout.write(`  ✗ ${name}\n`);
  }
}

const vectors = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'group-crypto-vectors.json'), 'utf8'),
);

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

for (const v of vectors.cases) {
  await test(`vector "${v.name}": token hash matches`, async () => {
    assert.strictEqual(await groupTokenHash(v.token), v.tokenHashHex);
  });

  await test(`vector "${v.name}": HKDF derives the expected key`, async () => {
    assert.strictEqual(hex(await deriveGroupKey(v.token)), v.keyHex);
  });

  await test(`vector "${v.name}": context string matches`, () => {
    assert.strictEqual(envelopeContext(v.purpose, v.memberUid ?? undefined), v.context);
  });

  await test(`vector "${v.name}": open recovers the plaintext`, async () => {
    const key = Uint8Array.from(Buffer.from(v.keyHex, 'hex'));
    assert.strictEqual(await open(key, v.envelope, v.context), v.plaintext);
  });
}

await test('the unicode vector survives the browser TextDecoder', async () => {
  // The single likeliest place a third implementation diverges, and it fails silently: a wrong
  // byte count still decodes to *something*. 7 locales ship in 1.7.x.
  const v = vectors.cases.find((c) => c.name.includes('unicode'));
  assert.ok(v, 'fixture lost its unicode case');
  const key = Uint8Array.from(Buffer.from(v.keyHex, 'hex'));
  const plain = await open(key, v.envelope, v.context);
  assert.strictEqual(plain, v.plaintext);
  assert.ok(JSON.parse(plain).name.includes('🚴'), 'emoji did not survive the round trip');
});

await test('a wrong key fails rather than returning garbage', async () => {
  const v = vectors.cases[0];
  const wrong = await deriveGroupKey('9tK-3xQzR1sV7wY0aB2cD4');
  await assert.rejects(() => open(wrong, v.envelope, v.context), EnvelopeError);
});

await test('a position envelope cannot be replayed into another member slot', async () => {
  // The per-member AAD must be enforced here too, or the browser becomes the weak link in a
  // protection the other two platforms uphold.
  const v = vectors.cases.find((c) => c.purpose === 'pos');
  const key = Uint8Array.from(Buffer.from(v.keyHex, 'hex'));
  await assert.rejects(() => openFor(key, v.envelope, 'pos', 'someone-else'), EnvelopeError);
});

await test('tampering is detected', async () => {
  const v = vectors.cases[0];
  const key = Uint8Array.from(Buffer.from(v.keyHex, 'hex'));
  const [version, nonce, body] = v.envelope.split('.');
  const bytes = Buffer.from(body, 'base64url');
  bytes[0] ^= 0x01;
  await assert.rejects(
    () => open(key, `${version}.${nonce}.${bytes.toString('base64url')}`, v.context),
    EnvelopeError,
  );
});

await test('malformed envelopes raise EnvelopeError, never a raw WebCrypto error', async () => {
  const key = await deriveGroupKey(vectors.cases[0].token);
  for (const bad of ['', 'v1', 'v1.abc', 'v2.AAECAwQFBgcICQoL.AAAA', 'v1.AAECAwQFBgcICQoL.AA']) {
    await assert.rejects(() => open(key, bad, 'v1:meta'), EnvelopeError, `accepted "${bad}"`);
  }
});

await test('failure messages do not distinguish wrong key from wrong context', async () => {
  const v = vectors.cases.find((c) => c.purpose === 'pos');
  const key = Uint8Array.from(Buffer.from(v.keyHex, 'hex'));
  const wrongKey = await deriveGroupKey('9tK-3xQzR1sV7wY0aB2cD4');
  const a = await open(wrongKey, v.envelope, v.context).catch((e) => e.message);
  const b = await openFor(key, v.envelope, 'pos', 'someone-else').catch((e) => e.message);
  assert.strictEqual(a, b);
});

await test('the token is read from the fragment and validated', async () => {
  assert.strictEqual(tokenFromFragment('#Zm9vYmFyYmF6cXV4MTIzNA'), 'Zm9vYmFyYmF6cXV4MTIzNA');
  assert.strictEqual(tokenFromFragment('Zm9vYmFyYmF6cXV4MTIzNA'), 'Zm9vYmFyYmF6cXV4MTIzNA');
  for (const bad of ['', '#', '#short', '#Zm9vYmFyYmF6cXV4MTIzNA==', null, undefined]) {
    assert.strictEqual(tokenFromFragment(bad), null, `accepted ${JSON.stringify(bad)}`);
  }
});

await test('the module never seals and never touches the code path', async () => {
  // §2.9's dead-code hazard: machinery with no call site rots and is discovered by the customer.
  // The landing page only ever decrypts a group name, so seal/wrap must stay absent rather than
  // be written "for completeness".
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'group-crypto.mjs'), 'utf8');
  for (const absent of ['export function seal', 'export async function seal', 'deriveCodeKey', 'wrapTokenForCode']) {
    assert.ok(!source.includes(absent), `browser module grew "${absent}" with no call site`);
  }
});

process.stdout.write(`\ngroup-crypto-web: ${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) {
  for (const f of failures) process.stderr.write(`  - ${f}\n`);
  process.exit(1);
}
