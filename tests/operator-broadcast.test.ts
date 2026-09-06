import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  BROADCAST_TAGS,
  BroadcastValidationError,
  parseOperatorBroadcast,
  toFcmData,
} from '../lib/operator-broadcast';

/**
 * SCOPE_1.8.7 §6.3 — the Class D wire contract, proved here against the file that is canonical
 * here. Android and iOS assert against verbatim copies of the same JSON.
 */
const vectors = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'operator-broadcast-v1.json'), 'utf8'),
);

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${(error as Error).message}`);
  }
}

check('the tag vocabulary is exactly what the contract declares', () => {
  const declared = vectors.tags.map((t: { id: string }) => t.id);
  assert.deepStrictEqual([...BROADCAST_TAGS], declared);
});

check('every valid vector is accepted', () => {
  assert.ok(vectors.valid.length >= 4);
  for (const vector of vectors.valid) {
    const parsed = parseOperatorBroadcast(vector.record);
    assert.strictEqual(parsed.id, vector.record.id, vector.description);
  }
});

check('every invalid vector is refused, with a message for the operator', () => {
  assert.ok(vectors.invalid.length >= 14, 'the vector file lost its rejection cases');
  for (const vector of vectors.invalid) {
    assert.throws(
      () => parseOperatorBroadcast(vector.record),
      (error: unknown) => {
        assert.ok(error instanceof BroadcastValidationError, vector.description);
        // The endpoint is the only point in the flow where a human is present and can fix the
        // problem, so a refusal has to say what is wrong rather than merely refusing.
        assert.ok((error as Error).message.length > 10, `${vector.description}: message too terse`);
        return true;
      },
      vector.description,
    );
  }
});

check('nothing promotional can be tagged, whatever it is called', () => {
  for (const attempt of ['PROMO', 'MARKETING', 'OTHER', 'promo', 'Urgent', 'ANNOUNCEMENT', '']) {
    assert.throws(
      () => parseOperatorBroadcast({ id: 'x', tag: attempt, title: 't', body: 'b', created_at_millis: 1 }),
      BroadcastValidationError,
      `tag "${attempt}" must be refused`,
    );
  }
});

check('only an update notice may be limited by version', () => {
  for (const tag of BROADCAST_TAGS) {
    const record = { id: 'x', tag, title: 't', body: 'b', created_at_millis: 1, applies_to_versions_at_or_below: 187 };
    if (tag === 'UPDATE') {
      assert.strictEqual(parseOperatorBroadcast(record).applies_to_versions_at_or_below, 187);
    } else {
      assert.throws(() => parseOperatorBroadcast(record), BroadcastValidationError, tag);
    }
  }
});

check('the endpoint refuses numeric strings the clients have to accept', () => {
  // The clients accept "1757000000000" because an FCM data payload is all strings. The endpoint
  // receives JSON from our own admin page and has no such excuse; being lenient where you need not
  // be is how a validator drifts into accepting whatever it is sent.
  assert.throws(
    () => parseOperatorBroadcast({ id: 'x', tag: 'URGENT', title: 't', body: 'b', created_at_millis: '1757000000000' }),
    BroadcastValidationError,
  );
});

check('the FCM payload is data-only and all strings', () => {
  const broadcast = parseOperatorBroadcast(vectors.valid[1].record);
  const data = toFcmData(broadcast);
  for (const [key, value] of Object.entries(data)) {
    assert.strictEqual(typeof value, 'string', `${key} must be a string for FCM`);
  }
  assert.strictEqual(data.created_at_millis, String(broadcast.created_at_millis));
  assert.strictEqual(data.applies_to_versions_at_or_below, '187');
  // A `notification` block would be rendered by the system before the app sees it, putting an
  // unvalidated network string straight onto a HIGH-importance channel and skipping every parser
  // this contract exists to run.
  assert.ok(!('notification' in data));
});

check('title and body limits match the vector file exactly', () => {
  const overTitle = vectors.invalid.find((v: { description: string }) => v.description.includes('title over'));
  const overBody = vectors.invalid.find((v: { description: string }) => v.description.includes('body over'));
  assert.ok(overTitle && overBody);
  assert.throws(() => parseOperatorBroadcast(overTitle.record), BroadcastValidationError);
  assert.throws(() => parseOperatorBroadcast(overBody.record), BroadcastValidationError);
});

console.log(`\noperator-broadcast: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

// Imported last so a type or import error in the endpoint fails this suite rather than surfacing
// only in a Vercel build log after a deploy.
import handler, { BROADCAST_TOPIC } from '../api/admin/broadcast';

check('the endpoint module loads and declares the topic the clients subscribe to', () => {
  assert.strictEqual(typeof handler, 'function');
  assert.strictEqual(BROADCAST_TOPIC, 'broadcasts');
});

if (failed > 0) process.exit(1);
