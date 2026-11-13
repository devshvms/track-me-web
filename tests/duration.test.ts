import assert from 'node:assert';
import {
  STALE_SIGNAL_THRESHOLD_MS,
  evaluateDeadlineStatus,
  evaluateSpeedOrStopped,
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

test('evaluateDeadlineStatus evaluates on-time and overdue deadlines accurately', () => {
  // Edge cases
  assert.strictEqual(evaluateDeadlineStatus(null), null);
  assert.strictEqual(evaluateDeadlineStatus(undefined), null);
  assert.strictEqual(evaluateDeadlineStatus('invalid'), null);
  assert.strictEqual(evaluateDeadlineStatus(-100), null);

  const deadlineMs = 1700000000000;
  const fixedFormatter = () => '6:30 PM';

  // On-time (now is 15 minutes before deadline)
  const onTimeNow = deadlineMs - 15 * 60_000;
  const onTime = evaluateDeadlineStatus(deadlineMs, onTimeNow, fixedFormatter);
  assert.ok(onTime !== null);
  assert.strictEqual(onTime.isOverdue, false);
  assert.strictEqual(onTime.overdueMinutes, 0);
  assert.strictEqual(onTime.timeString, '6:30 PM');
  assert.strictEqual(onTime.displayText, 'Expected by 6:30 PM');

  // Overdue (now is 22 minutes past deadline)
  const overdueNow = deadlineMs + 22 * 60_000;
  const overdue = evaluateDeadlineStatus(deadlineMs, overdueNow, fixedFormatter);
  assert.ok(overdue !== null);
  assert.strictEqual(overdue.isOverdue, true);
  assert.strictEqual(overdue.overdueMinutes, 22);
  assert.strictEqual(overdue.displayText, 'Overdue · Expected by 6:30 PM');

  // Handles ISO-8601 string input
  const iso = new Date(deadlineMs).toISOString();
  const fromIso = evaluateDeadlineStatus(iso, onTimeNow, fixedFormatter);
  assert.ok(fromIso !== null);
  assert.strictEqual(fromIso.isOverdue, false);
  assert.strictEqual(fromIso.timeString, '6:30 PM');
});

test('evaluateSpeedOrStopped evaluates motion, stationary, and stopped timer states (CIE-029)', () => {
  const now = 2000000000000;

  // In motion (25 km/h)
  const movingMetric = evaluateSpeedOrStopped(24.8, null, now, false, false);
  assert.strictEqual(movingMetric.isStationary, false);
  assert.strictEqual(movingMetric.isStoppedTimerActive, false);
  assert.strictEqual(movingMetric.displayText, '25 km/h');
  assert.strictEqual(movingMetric.a11yText, 'Rider speed: 25 km/h');

  // In motion imperial (15 mph)
  const movingImperial = evaluateSpeedOrStopped(24.8, null, now, true, false);
  assert.strictEqual(movingImperial.isStationary, false);
  assert.strictEqual(movingImperial.displayText, '15 mph');

  // In motion delayed
  const movingDelayed = evaluateSpeedOrStopped(20.0, null, now, false, true);
  assert.strictEqual(movingDelayed.displayText, '~20 km/h ⚠️ (delayed)');

  // Stationary recently stopped (< 60s)
  const recentStop = evaluateSpeedOrStopped(0, now - 45_000, now, false, false);
  assert.strictEqual(recentStop.isStationary, true);
  assert.strictEqual(recentStop.isStoppedTimerActive, false);
  assert.strictEqual(recentStop.displayText, '0 km/h');
  assert.strictEqual(recentStop.a11yText, 'Rider stationary');

  // Stationary stopped for 3 minutes
  const stopped3m = evaluateSpeedOrStopped(0.5, now - 180_000, now, false, false);
  assert.strictEqual(stopped3m.isStationary, true);
  assert.strictEqual(stopped3m.isStoppedTimerActive, true);
  assert.strictEqual(stopped3m.stoppedDurationMinutes, 3);
  assert.strictEqual(stopped3m.displayText, 'Stopped · 3m');
  assert.strictEqual(stopped3m.a11yText, 'Rider stopped for 3m');

  // Stationary stopped for 1 hour 15 minutes
  const stoppedLong = evaluateSpeedOrStopped(null, now - 75 * 60_000, now, false, false);
  assert.strictEqual(stoppedLong.isStationary, true);
  assert.strictEqual(stoppedLong.isStoppedTimerActive, true);
  assert.strictEqual(stoppedLong.stoppedDurationMinutes, 75);
  assert.strictEqual(stoppedLong.displayText, 'Stopped · 1h 15m');

  // Missing or negative speeds without stoppedSinceMs
  const stoppedDefault = evaluateSpeedOrStopped(null, null, now, false, false);
  assert.strictEqual(stoppedDefault.isStationary, true);
  assert.strictEqual(stoppedDefault.isStoppedTimerActive, false);
  assert.strictEqual(stoppedDefault.displayText, '0 km/h');
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
