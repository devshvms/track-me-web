import assert from 'node:assert';
import { VIEWER_VISIBLE_FIELDS } from '../api/track/[sessionId]/location';

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

test('VIEWER_VISIBLE_FIELDS omits owner identity fields', () => {
  const fields = [...VIEWER_VISIBLE_FIELDS] as string[];
  assert.ok(!fields.includes('ownerEmail'), 'ownerEmail leaked to VIEWER_VISIBLE_FIELDS');
  assert.ok(!fields.includes('ownerUid'), 'ownerUid leaked to VIEWER_VISIBLE_FIELDS');
});

test('VIEWER_VISIBLE_FIELDS includes master tracker fields', () => {
  const fields = [...VIEWER_VISIBLE_FIELDS] as string[];
  assert.ok(fields.includes('username'), 'username missing from VIEWER_VISIBLE_FIELDS');
  assert.ok(fields.includes('status'), 'status missing from VIEWER_VISIBLE_FIELDS');
  assert.ok(fields.includes('stopReason'), 'stopReason missing from VIEWER_VISIBLE_FIELDS');
  assert.ok(fields.includes('lastLocation'), 'lastLocation missing from VIEWER_VISIBLE_FIELDS');
});

process.stdout.write(`\nlocation: ${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) {
  for (const f of failures) process.stderr.write(`  - ${f}\n`);
  process.exit(1);
}
