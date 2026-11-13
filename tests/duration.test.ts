import assert from 'node:assert';
import {
  STALE_SIGNAL_THRESHOLD_MS,
  formatElapsedDuration,
  isSignalStale,
  parseTimestampMs,
} from '../lib/track/duration';

type TestCase = { name: string; fn: () => void | Promise<void> };
const tests: TestCase[] = [];

function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

test('parseTimestampMs handles numbers, ISO strings, invalid values correctly', () => {
  assert.strictEqual(parseTimestampMs(null), null);
  assert.strictEqual(parseTimestampMs(undefined), null);
  assert.strictEqual(parseTimestampMs(-50), null);
  assert.strictEqual(parseTimestampMs(''), null);
  assert.strictEqual(parseTimestampMs('not-a-date'), null);

  const now = 1700000000000;
  assert.strictEqual(parseTimestampMs(now), now);
  assert.strictEqual(parseTimestampMs('1700000000000'), now);
  const iso = '2026-11-13T09:00:00.000Z';
  assert.strictEqual(parseTimestampMs(iso), new Date(iso).getTime());
});

test('formatElapsedDuration formats short durations (< 1m)', () => {
  const start = 1000000;
  assert.strictEqual(formatElapsedDuration(start, null, start + 30_000), '< 1m');
  assert.strictEqual(formatElapsedDuration(start, start + 50_000), '< 1m');
});

test('formatElapsedDuration formats minute durations (< 60m)', () => {
  const start = 1000000;
  assert.strictEqual(formatElapsedDuration(start, null, start + 120_000), '2m');
  assert.strictEqual(formatElapsedDuration(start, start + 45 * 60_000), '45m');
  assert.strictEqual(formatElapsedDuration(start, start + 59 * 60_000), '59m');
});

test('formatElapsedDuration formats multi-hour durations with and without remainder minutes', () => {
  const start = 1000000;
  // Exactly 1 hour
  assert.strictEqual(formatElapsedDuration(start, start + 60 * 60_000), '1h');
  // 1 hour 15 minutes
  assert.strictEqual(formatElapsedDuration(start, start + 75 * 60_000), '1h 15m');
  // 3 hours exactly
  assert.strictEqual(formatElapsedDuration(start, start + 180 * 60_000), '3h');
  // 2 hours 4 minutes
  assert.strictEqual(formatElapsedDuration(start, start + 124 * 60_000), '2h 4m');
});

test('formatElapsedDuration returns null when start time is missing or invalid', () => {
  assert.strictEqual(formatElapsedDuration(null, null), null);
  assert.strictEqual(formatElapsedDuration('invalid', null), null);
});

test('isSignalStale identifies active rides with no update for >= 3 minutes', () => {
  const now = 2000000;
  // Recent updates (< 180s)
  assert.strictEqual(isSignalStale(now - 30_000, now), false);
  assert.strictEqual(isSignalStale(now - 179_000, now), false);

  // Stale updates (>= 180s)
  assert.strictEqual(isSignalStale(now - STALE_SIGNAL_THRESHOLD_MS, now), true);
  assert.strictEqual(isSignalStale(now - 300_000, now), true);

  // Missing or invalid
  assert.strictEqual(isSignalStale(null, now), false);
  assert.strictEqual(isSignalStale('invalid', now), false);
});

async function main() {
  let passed = 0;
  const failures: string[] = [];

  for (const t of tests) {
    try {
      await t.fn();
      passed += 1;
      process.stdout.write(`  ✓ ${t.name}\n`);
    } catch (err) {
      failures.push(`${t.name}: ${(err as Error).message}`);
      process.stdout.write(`  ✗ ${t.name}\n`);
    }
  }

  process.stdout.write(`\nduration: ${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) {
    for (const f of failures) process.stderr.write(`  - ${f}\n`);
    process.exit(1);
  }
}

main();
