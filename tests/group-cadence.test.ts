import assert from 'node:assert';
import {
  BACKGROUND_MOVING_SEC,
  FOREGROUND_MOVING_SEC,
  MAX_SYNC_SEC,
  MIN_SYNC_SEC,
  PREPARING_SEC,
  STATIONARY_SEC,
  modelledSyncsPerMemberHour,
  nextSyncIntervalSec,
} from '../lib/group/cadence';
import {
  MAX_POSITION_ENVELOPE_CHARS,
  decodePositionField,
  encodePositionField,
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

const ENVELOPE = 'v1.AAECAwQFBgcICQoL.' + 'A'.repeat(40);

// --- §7.1's table ------------------------------------------------------------------------------

test('foreground and moving syncs at 10s', () => {
  assert.strictEqual(
    nextSyncIntervalSec({ state: 'LIVE', foreground: true, moving: true }),
    FOREGROUND_MOVING_SEC,
  );
});

test('backgrounded and moving syncs at 20s', () => {
  assert.strictEqual(
    nextSyncIntervalSec({ state: 'LIVE', foreground: false, moving: true }),
    BACKGROUND_MOVING_SEC,
  );
});

test('stationary syncs at 60s regardless of foreground', () => {
  // Checked before foreground on purpose: a phone on a café table with the map open is not
  // worth six writes a minute.
  for (const foreground of [true, false]) {
    assert.strictEqual(
      nextSyncIntervalSec({ state: 'LIVE', foreground, moving: false }),
      STATIONARY_SEC,
      `foreground=${foreground}`,
    );
  }
});

test('PREPARING overrides motion entirely', () => {
  // Nobody is moving yet; the lobby needs a heartbeat, not a stream.
  for (const foreground of [true, false]) {
    for (const moving of [true, false]) {
      assert.strictEqual(
        nextSyncIntervalSec({ state: 'PREPARING', foreground, moving }),
        PREPARING_SEC,
        `fg=${foreground} moving=${moving}`,
      );
    }
  }
});

test('the intervals are ordered cheapest-last, as §7.1 intends', () => {
  // If this ever inverts, the app is spending most where it is watched least.
  assert.ok(FOREGROUND_MOVING_SEC < BACKGROUND_MOVING_SEC, 'foreground is not the tightest');
  assert.ok(BACKGROUND_MOVING_SEC < STATIONARY_SEC, 'background is not tighter than stationary');
});

test('every combination stays inside the global clamp', () => {
  for (const state of ['PREPARING', 'LIVE'] as const) {
    for (const foreground of [true, false]) {
      for (const moving of [true, false]) {
        const v = nextSyncIntervalSec({ state, foreground, moving });
        assert.ok(v >= MIN_SYNC_SEC, `${v} below the floor`);
        assert.ok(v <= MAX_SYNC_SEC, `${v} above the ceiling`);
        assert.ok(Number.isInteger(v), `${v} is not a whole number of seconds`);
      }
    }
  }
});

test('the floor is a real backstop, not decoration', () => {
  // §7.2 makes cadence a server-side lever with no client release. The clamp is what stops a
  // mis-set env var turning the fleet into a DDoS of our own relay.
  assert.ok(MIN_SYNC_SEC >= 1, 'the floor allows sub-second syncing');
  assert.ok(MIN_SYNC_SEC <= FOREGROUND_MOVING_SEC, 'the floor is above the tightest interval');
});

test('the modelled cost matches §7.2 within rounding', () => {
  // §7.2 models 228 syncs/member-hour on a 40/40/20 blend and prices the whole feature off it.
  // Computing it from the constants the server actually serves means the number in the doc
  // cannot silently drift away from the number in the code.
  const syncs = modelledSyncsPerMemberHour();
  assert.ok(Math.abs(syncs - 228) < 1, `expected ~228 syncs/member-hour, got ${syncs.toFixed(1)}`);
  // 5-person group → §7.2's ~1,140 invocations per group-hour.
  assert.ok(Math.abs(syncs * 5 - 1140) < 5, `expected ~1140 per group-hour, got ${(syncs * 5).toFixed(0)}`);
});

// --- Position field encoding (§4.4) --------------------------------------------------------------

test('a position field round-trips', () => {
  const decoded = decodePositionField(encodePositionField(1785000000000, ENVELOPE));
  assert.deepStrictEqual(decoded, { ts: 1785000000000, e: ENVELOPE });
});

test('the timestamp sits outside the envelope', () => {
  // §4.4: the server must be able to compute staleness and sweep ghosts without decrypting.
  const field = encodePositionField(1785000000000, ENVELOPE);
  assert.ok(field.startsWith('1785000000000.'), 'timestamp is not readable without the key');
  assert.ok(field.includes(ENVELOPE), 'envelope was altered by encoding');
});

test('splitting on the first dot survives the envelope having dots of its own', () => {
  // The envelope is `v1.<nonce>.<body>` — three dot-separated parts. Splitting on the last dot,
  // or on all of them, would silently corrupt every position.
  const field = encodePositionField(1, ENVELOPE);
  assert.strictEqual(field.split('.').length, 4, 'test envelope is not shaped as expected');
  assert.strictEqual(decodePositionField(field)!.e, ENVELOPE);
});

test('a malformed position field decodes to null rather than throwing', () => {
  // §8: a member we cannot read is skipped and logged. One bad field must cost one absent
  // marker, never the whole map.
  for (const bad of [
    '',
    'no-dot',
    '.v1.AAECAwQFBgcICQoL.AAAA',        // empty timestamp
    'abc.' + ENVELOPE,                   // non-numeric timestamp
    '-5.' + ENVELOPE,                    // negative timestamp
    '1.5.' + ENVELOPE,                   // fractional timestamp
    '1785000000000.not-an-envelope',
    '1785000000000.v2.AAECAwQFBgcICQoL.AAAAAAAAAAAAAAAAAAAAAA',  // wrong version
    null,
    undefined,
    42,
    {},
  ]) {
    assert.strictEqual(decodePositionField(bad as any), null, `accepted ${JSON.stringify(bad)}`);
  }
});

test('an oversize position envelope is rejected', () => {
  const huge = 'v1.AAECAwQFBgcICQoL.' + 'A'.repeat(MAX_POSITION_ENVELOPE_CHARS + 100);
  assert.strictEqual(decodePositionField(encodePositionField(1, huge)), null);
});

process.stdout.write(`\ngroup-cadence: ${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) {
  for (const f of failures) process.stderr.write(`  - ${f}\n`);
  process.exit(1);
}
