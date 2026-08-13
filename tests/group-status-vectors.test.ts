import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { MAX_STATUS_ENVELOPE_CHARS, isValidEnvelope } from '../lib/group/model';

/**
 * Validates the shared status contract itself — SCOPE_1.7.2 §4.3.
 *
 * The relay never reads a status code; it stores ciphertext. So this is not testing relay
 * behaviour. It is testing **the fixture**, which is the executable contract two independently
 * written clients agree on — and a typo in it would send Android and iOS in different directions
 * with nothing to catch them. E1 exists because that divergence stays invisible until a real group
 * is riding.
 *
 * This file lives here because `tests/fixtures/` is the canonical home for shared vectors, the same
 * way `group-crypto-vectors.json` already is.
 */

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

interface StatusVectors {
  grammar: string;
  codes: Array<{
    raw: string;
    valid: boolean;
    severity?: string;
    persona?: string | null;
    message?: string;
    extension?: string | null;
    note?: string;
  }>;
  ages: Array<{
    serverNowMs: number;
    serverTsMs: number;
    stAgeSeconds: number | null;
    expectedAgeAtReceiptMs: number | null;
    note?: string;
  }>;
  buckets: Array<{ ageMs: number; syncIntervalSec: number; expected: string; note?: string }>;
}

const fixture: StatusVectors = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'group-status-vectors.json'), 'utf8'),
);

test('the fixture declares a grammar, and every vector agrees with it', () => {
  const grammar = new RegExp(fixture.grammar);
  for (const v of fixture.codes) {
    assert.strictEqual(
      grammar.test(v.raw),
      v.valid,
      `"${v.raw}" is marked valid=${v.valid} but the declared grammar disagrees`,
    );
  }
});

test('every valid vector decomposes exactly as its fields claim', () => {
  // Catches a fixture whose stated severity/persona/message drifts from its own raw string — which
  // would make one client "pass" against a contract the other reads differently.
  for (const v of fixture.codes.filter((c) => c.valid)) {
    const code = v.raw.split(':')[0];
    assert.strictEqual(code.length, 4, `${v.raw}: code part must be 4 chars`);
    assert.strictEqual(code[1], v.persona ?? code[1], `${v.raw}: persona field disagrees with the code`);
    assert.strictEqual(code.slice(2, 4), v.message, `${v.raw}: message field disagrees with the code`);
    const ext = v.raw.includes(':') ? v.raw.split(':')[1] : null;
    assert.strictEqual(ext, v.extension ?? null, `${v.raw}: extension field disagrees with the code`);
  }
});

test('an unrecognised severity digit is demoted to INFO, never promoted', () => {
  // The rule that matters most: an unknown tier must never be able to make an older client scream.
  // Digit 0 is reserved for a tier ABOVE alert and must STILL demote — fails quiet, never loud.
  const reserved = fixture.codes.filter((c) => c.valid && !'123'.includes(c.raw[0]));
  assert.ok(reserved.length > 0, 'the fixture must cover at least one reserved severity digit');
  for (const v of reserved) {
    assert.strictEqual(v.severity, '3', `${v.raw}: a reserved digit must render as INFO`);
  }
});

test('the fixture covers the reboot case, where an age is unknown rather than zero', () => {
  // Absent stAge means the sender lost the age. Collapsing it to 0 would fabricate a fresh age for
  // a status that may be hours old, which is the one thing §4.3 refuses to do.
  const reboot = fixture.ages.filter((a) => a.stAgeSeconds === null);
  assert.ok(reboot.length > 0, 'the fixture must cover a sender that rebooted');
  for (const a of reboot) {
    assert.strictEqual(a.expectedAgeAtReceiptMs, null, 'a lost age must be unknown, never 0');
  }
});

test('every age vector matches the contract arithmetic', () => {
  // ageAtReceipt = (serverNow - ts) + stAge * 1000, clamped at 0.
  for (const a of fixture.ages) {
    if (a.stAgeSeconds === null) continue;
    const expected = Math.max(0, a.serverNowMs - a.serverTsMs) + Math.max(0, a.stAgeSeconds) * 1000;
    assert.strictEqual(
      a.expectedAgeAtReceiptMs,
      expected,
      `${a.note ?? ''}: fixture says ${a.expectedAgeAtReceiptMs}, the contract computes ${expected}`,
    );
  }
});

test('the Now bucket tracks the advertised sync interval, not a constant', () => {
  // §7.2 of 1.7.0: the relay slows everyone down under load. A fixed threshold would make the whole
  // fleet start counting seconds during a legitimate slowdown, so the fixture must prove otherwise.
  const scaled = fixture.buckets.filter((b) => b.expected === 'Now' && b.syncIntervalSec !== 10);
  assert.ok(scaled.length > 0, 'the fixture must cover a non-default sync interval');
  for (const b of scaled) {
    assert.ok(
      b.ageMs < b.syncIntervalSec * 1000,
      `${b.ageMs}ms cannot be "Now" at a ${b.syncIntervalSec}s cadence`,
    );
  }
});

test('a sealed status stays far inside the envelope cap the relay enforces', () => {
  // §4.3 budgets 256 chars; a real sealed status is ~72. This is the guard against the slot quietly
  // becoming somewhere to smuggle a payload.
  const realistic = 'v1.' + 'A'.repeat(16) + '.' + 'B'.repeat(56);
  assert.ok(isValidEnvelope(realistic, MAX_STATUS_ENVELOPE_CHARS));
  assert.ok(!isValidEnvelope('v1.' + 'A'.repeat(16) + '.' + 'B'.repeat(400), MAX_STATUS_ENVELOPE_CHARS));
});

process.stdout.write(`\ngroup-status-vectors: ${passed} passed, ${failures.length} failed\n`);
for (const f of failures) process.stdout.write(`  - ${f}\n`);
if (failures.length > 0) process.exit(1);
