import assert from 'node:assert';
import {
  normalizeEmail,
  isValidEmail,
  normalizePlatform,
  hashEmail,
  parseWaitlistRequest,
  buildWaitlistRecord,
} from '../lib/waitlist';

// Minimal dependency-free test harness (mirrors scripts/check-*.js style — the
// repo has no test framework and we don't want to add one for a few pure fns).
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

const PEPPER = 'test-pepper-value';

// --- normalization ---------------------------------------------------------
test('normalizeEmail trims, lowercases, NFC-normalizes', () => {
  assert.equal(normalizeEmail('  Foo@Example.COM '), 'foo@example.com');
});

test('normalizeEmail collapses Unicode composition variants', () => {
  // é as base+combining-accent (NFD) vs precomposed (NFC) must converge.
  const nfd = 'josé@example.com';
  const nfc = 'josé@example.com';
  assert.equal(normalizeEmail(nfd), normalizeEmail(nfc));
});

test('normalizeEmail handles non-strings', () => {
  assert.equal(normalizeEmail(undefined), '');
  assert.equal(normalizeEmail(42), '');
});

test('normalizeEmail does NOT strip gmail dots/plus (addresses stay distinct)', () => {
  assert.equal(normalizeEmail('a.b+tag@gmail.com'), 'a.b+tag@gmail.com');
});

// --- validation ------------------------------------------------------------
test('isValidEmail accepts plausible addresses', () => {
  assert.ok(isValidEmail('foo@example.com'));
  assert.ok(isValidEmail('a.b+tag@sub.example.co.uk'));
});

test('isValidEmail rejects malformed + oversized', () => {
  assert.ok(!isValidEmail(''));
  assert.ok(!isValidEmail('nope'));
  assert.ok(!isValidEmail('a@b'));
  assert.ok(!isValidEmail('a @b.com'));
  assert.ok(!isValidEmail('x'.repeat(250) + '@example.com'));
});

// --- platform allow-list ---------------------------------------------------
test('normalizePlatform enforces the allow-list', () => {
  assert.equal(normalizePlatform('android'), 'android');
  assert.equal(normalizePlatform('iOS'), 'ios');
  assert.equal(normalizePlatform('  WEB '), 'web');
  assert.equal(normalizePlatform('windows-phone'), 'unspecified');
  assert.equal(normalizePlatform(undefined), 'unspecified');
  assert.equal(normalizePlatform('<script>'), 'unspecified');
});

// --- HMAC hashing ----------------------------------------------------------
test('hashEmail is deterministic for a normalized address (idempotent dedupe)', () => {
  const a = hashEmail('foo@example.com', PEPPER);
  const b = hashEmail('foo@example.com', PEPPER);
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('hashEmail differs per pepper (keyed, not plain SHA-256)', () => {
  assert.notEqual(hashEmail('foo@example.com', PEPPER), hashEmail('foo@example.com', 'other-pepper'));
});

test('hashEmail differs per address', () => {
  assert.notEqual(hashEmail('a@example.com', PEPPER), hashEmail('b@example.com', PEPPER));
});

test('hashEmail throws without a pepper (fail closed, never plain hash)', () => {
  assert.throws(() => hashEmail('foo@example.com', ''));
});

test('normalized case/whitespace variants hash identically (dedupe works)', () => {
  const parsedA = parseWaitlistRequest({ email: 'Foo@Example.com' }, PEPPER);
  const parsedB = parseWaitlistRequest({ email: '  foo@example.com ' }, PEPPER);
  assert.ok(parsedA.ok && parsedB.ok);
  assert.equal(parsedA.emailHash, parsedB.emailHash);
});

// --- request parsing --------------------------------------------------------
test('parseWaitlistRequest returns hash + platform for a valid body', () => {
  const r = parseWaitlistRequest({ email: 'foo@example.com', platform: 'android' }, PEPPER);
  assert.ok(r.ok);
  assert.equal(r.platform, 'android');
  assert.match(r.emailHash!, /^[0-9a-f]{64}$/);
  assert.equal(r.normalizedEmail, 'foo@example.com');
});

test('parseWaitlistRequest rejects invalid email with a redaction-safe reason', () => {
  const r = parseWaitlistRequest({ email: 'not-an-email' }, PEPPER);
  assert.ok(!r.ok);
  assert.equal(r.error, 'invalid_email');
  assert.equal(r.emailHash, undefined);
});

test('parseWaitlistRequest trips the honeypot', () => {
  const r = parseWaitlistRequest({ email: 'foo@example.com', company: 'AcmeBot' }, PEPPER);
  assert.ok(!r.ok);
  assert.equal(r.error, 'bot');
});

test('parseWaitlistRequest tolerates an empty honeypot', () => {
  const r = parseWaitlistRequest({ email: 'foo@example.com', company: '   ' }, PEPPER);
  assert.ok(r.ok);
});

test('parseWaitlistRequest rejects a non-object body', () => {
  const r = parseWaitlistRequest(null as any, PEPPER);
  assert.ok(!r.ok);
  assert.equal(r.error, 'invalid_body');
});

// --- record shape ----------------------------------------------------------
test('buildWaitlistRecord is provider-agnostic and stores no raw email', () => {
  const record = buildWaitlistRecord('deadbeef', 'ios');
  assert.equal(record.emailHash, 'deadbeef');
  assert.equal(record.platform, 'ios');
  assert.equal(record.status, 'pending');
  assert.equal(record.source, 'web-v2');
  assert.equal(record.providerContactId, null); // reserved for D2
  assert.ok(!('email' in record));
});

process.stdout.write(`\nwaitlist: ${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  failures.forEach((f) => process.stderr.write(`  FAIL ${f}\n`));
  process.exit(1);
}
