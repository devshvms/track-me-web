import assert from 'node:assert';
import {
  resolveInitialUnits,
  toggleUnitSystem,
  formatViewerSpeed,
  formatViewerDistance,
  PREFERRED_UNITS_STORAGE_KEY,
} from '../lib/track/units';

type TestCase = { name: string; fn: () => void | Promise<void> };
const tests: TestCase[] = [];

function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

test('resolveInitialUnits prioritizes explicit URL query parameters', () => {
  assert.strictEqual(resolveInitialUnits('imperial', 'metric', ['fr-FR']), 'imperial');
  assert.strictEqual(resolveInitialUnits('mi', 'metric', ['fr-FR']), 'imperial');
  assert.strictEqual(resolveInitialUnits('mph', 'metric', ['fr-FR']), 'imperial');
  assert.strictEqual(resolveInitialUnits('metric', 'imperial', ['en-US']), 'metric');
  assert.strictEqual(resolveInitialUnits('km', 'imperial', ['en-US']), 'metric');
  assert.strictEqual(resolveInitialUnits('kmh', 'imperial', ['en-US']), 'metric');
});

test('resolveInitialUnits falls back to stored preference when query parameter is omitted or invalid', () => {
  assert.strictEqual(resolveInitialUnits(null, 'imperial', ['fr-FR']), 'imperial');
  assert.strictEqual(resolveInitialUnits('', 'metric', ['en-US']), 'metric');
  assert.strictEqual(resolveInitialUnits('invalid', 'imperial', ['fr-FR']), 'imperial');
});

test('resolveInitialUnits falls back to browser locale detection when query and storage are omitted', () => {
  assert.strictEqual(resolveInitialUnits(null, null, ['en-US']), 'imperial');
  assert.strictEqual(resolveInitialUnits(null, null, ['es-US', 'es-ES']), 'imperial');
  assert.strictEqual(resolveInitialUnits(null, null, ['en-LR']), 'imperial');
  assert.strictEqual(resolveInitialUnits(null, null, ['my-MM']), 'imperial');
  assert.strictEqual(resolveInitialUnits(null, null, ['en-GB']), 'metric');
  assert.strictEqual(resolveInitialUnits(null, null, ['de-DE']), 'metric');
  assert.strictEqual(resolveInitialUnits(null, null, ['ja-JP']), 'metric');
  assert.strictEqual(resolveInitialUnits(null, null, []), 'metric');
  assert.strictEqual(resolveInitialUnits(null, null, null), 'metric');
});

test('toggleUnitSystem toggles metric to imperial and vice versa', () => {
  assert.strictEqual(toggleUnitSystem('metric'), 'imperial');
  assert.strictEqual(toggleUnitSystem('imperial'), 'metric');
});

test('formatViewerSpeed formats metric speeds accurately', () => {
  assert.strictEqual(formatViewerSpeed(25.4, 'metric'), '25 km/h');
  assert.strictEqual(formatViewerSpeed(25.6, 'metric'), '26 km/h');
  assert.strictEqual(formatViewerSpeed(0, 'metric'), '0 km/h');
  assert.strictEqual(formatViewerSpeed(null, 'metric'), '0 km/h');
  assert.strictEqual(formatViewerSpeed(-5, 'metric'), '0 km/h');
});

test('formatViewerSpeed formats imperial speeds accurately', () => {
  assert.strictEqual(formatViewerSpeed(25.0, 'imperial'), '16 mph');
  assert.strictEqual(formatViewerSpeed(50.0, 'imperial'), '31 mph');
  assert.strictEqual(formatViewerSpeed(0, 'imperial'), '0 mph');
  assert.strictEqual(formatViewerSpeed(undefined, 'imperial'), '0 mph');
});

test('formatViewerDistance formats metric distances in km', () => {
  assert.strictEqual(formatViewerDistance(1500, 'metric'), '1.5 km');
  assert.strictEqual(formatViewerDistance(10200, 'metric'), '10.2 km');
  assert.strictEqual(formatViewerDistance(0, 'metric'), '0.0 km');
  assert.strictEqual(formatViewerDistance(null, 'metric'), '0.0 km');
});

test('formatViewerDistance formats imperial distances in mi', () => {
  assert.strictEqual(formatViewerDistance(1609.344, 'imperial'), '1.0 mi');
  assert.strictEqual(formatViewerDistance(8046.72, 'imperial'), '5.0 mi');
  assert.strictEqual(formatViewerDistance(0, 'imperial'), '0.0 mi');
  assert.strictEqual(formatViewerDistance(undefined, 'imperial'), '0.0 mi');
});

test('exports correct storage key constant', () => {
  assert.strictEqual(PREFERRED_UNITS_STORAGE_KEY, 'trackme_preferred_units');
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

  process.stdout.write(`\nunits: ${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) {
    for (const f of failures) process.stderr.write(`  - ${f}\n`);
    process.exit(1);
  }
}

main();
