import assert from 'node:assert';
import {
  CAMERA_DEADBAND_METERS,
  COMPASS_BEARING_DEADBAND_DEGREES,
  computeHaversineDistanceMeters,
  shouldPanCamera,
  shouldUpdateContinuousHeading,
} from '../lib/track/throttling';

type TestCase = { name: string; fn: () => void | Promise<void> };
const tests: TestCase[] = [];

function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

test('computeHaversineDistanceMeters calculates accurate displacements', () => {
  assert.strictEqual(computeHaversineDistanceMeters(12.9716, 77.5946, 12.9716, 77.5946), 0);
  const dist = computeHaversineDistanceMeters(12.9716, 77.5946, 12.9726, 77.5946);
  assert.ok(dist >= 110 && dist <= 112, `Expected ~111m, got ${dist}`);
});

test('shouldPanCamera suppresses micro-jitter and pans on true movement', () => {
  assert.strictEqual(shouldPanCamera(null, [12.9716, 77.5946]), true);
  assert.strictEqual(shouldPanCamera(undefined, [12.9716, 77.5946]), true);

  // Sub-meter GPS jitter: ~0.1m
  const jitterPos: [number, number] = [12.9716001, 77.5946];
  assert.strictEqual(shouldPanCamera([12.9716, 77.5946], jitterPos), false);

  // 1.5m jitter (under default 3m threshold)
  const jitter15m: [number, number] = [12.971613, 77.5946];
  assert.strictEqual(shouldPanCamera([12.9716, 77.5946], jitter15m), false);

  // 5m movement (above 3m threshold)
  const move5m: [number, number] = [12.971645, 77.5946];
  assert.strictEqual(shouldPanCamera([12.9716, 77.5946], move5m), true);
});

test('shouldUpdateContinuousHeading suppresses noise when stationary or below deadband', () => {
  // Always false when stationary
  assert.strictEqual(shouldUpdateContinuousHeading(90, 120, true), false);
  assert.strictEqual(shouldUpdateContinuousHeading(null, 120, true), false);

  // Target null or undefined
  assert.strictEqual(shouldUpdateContinuousHeading(90, null, false), false);
  assert.strictEqual(shouldUpdateContinuousHeading(90, undefined, false), false);

  // First heading arrival
  assert.strictEqual(shouldUpdateContinuousHeading(null, 90, false), true);
  assert.strictEqual(shouldUpdateContinuousHeading(undefined, 90, false), true);

  // Below deadband (< 3 degrees)
  assert.strictEqual(shouldUpdateContinuousHeading(90, 91.5, false), false);
  assert.strictEqual(shouldUpdateContinuousHeading(359, 0.5, false), false); // 1.5 deg delta across North

  // Above deadband (>= 3 degrees)
  assert.strictEqual(shouldUpdateContinuousHeading(90, 94.0, false), true);
  assert.strictEqual(shouldUpdateContinuousHeading(358, 4.0, false), true); // 6 deg delta across North
  assert.strictEqual(shouldUpdateContinuousHeading(5, 355, false), true);   // 10 deg delta counter-clockwise
});

test('exports expected constant thresholds', () => {
  assert.strictEqual(CAMERA_DEADBAND_METERS, 3.0);
  assert.strictEqual(COMPASS_BEARING_DEADBAND_DEGREES, 3.0);
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

  process.stdout.write(`\nthrottling: ${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) {
    for (const f of failures) process.stderr.write(`  - ${f}\n`);
    process.exit(1);
  }
}

main();
