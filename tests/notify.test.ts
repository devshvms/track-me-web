import assert from 'node:assert';
import { EMAIL_TYPES, isValidEmailType, renderEmail } from '../lib/notifications/templates';
import handler, { redactEmail, dayBucket, consumeDailyQuota } from '../api/notify/send';
import { getRedisClient } from '../lib/redis';

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (err) {
    failures.push(`${name}: ${(err as Error).message}`);
    process.stdout.write(`  ✗ ${name}\n`);
  }
}

// Minimal Vercel req/res mocks.
function mockReq(overrides: any = {}): any {
  return { method: 'POST', headers: {}, body: {}, socket: {}, query: {}, ...overrides };
}
function mockRes(): any {
  const res: any = { statusCode: 0, body: undefined };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload: any) => {
    res.body = payload;
    return res;
  };
  res.setHeader = () => res;
  return res;
}

async function run() {
  // --- type enum -----------------------------------------------------------
  await test('isValidEmailType accepts only welcome + delete_account', () => {
    assert.deepEqual([...EMAIL_TYPES], ['welcome', 'delete_account']);
    assert.ok(isValidEmailType('welcome'));
    assert.ok(isValidEmailType('delete_account'));
    assert.ok(!isValidEmailType('achievement'));
    assert.ok(!isValidEmailType('welcome; DROP TABLE'));
    assert.ok(!isValidEmailType(undefined));
    assert.ok(!isValidEmailType(42));
  });

  // --- template render -----------------------------------------------------
  for (const type of EMAIL_TYPES) {
    await test(`renderEmail(${type}) yields subject + branded html + text`, () => {
      const { subject, html, text } = renderEmail(type);
      assert.ok(subject.length > 0, 'subject present');
      assert.ok(html.includes('<!DOCTYPE html>'), 'is an html document');
      assert.ok(html.includes('TrackMe'), 'brand present');
      assert.ok(html.includes('#29b6f6'), 'cyan brand accent present');
      assert.ok(html.includes('Inter'), 'Inter font stack present');
      assert.ok(!html.includes('undefined'), 'no undefined interpolation');
      assert.ok(text.length > 0, 'plaintext present');
    });
  }

  await test('delete_account copy warns it cannot be undone', () => {
    const { html } = renderEmail('delete_account');
    assert.ok(/cannot be undone/i.test(html));
  });

  // --- redaction -----------------------------------------------------------
  await test('redactEmail never leaks the local part', () => {
    const r = redactEmail('jane.doe@gmail.com');
    assert.ok(!r.includes('jane'));
    assert.ok(!r.includes('doe'));
    assert.equal(r, 'j***@***.com');
    assert.equal(redactEmail('bad'), '***');
  });

  // --- day bucket ----------------------------------------------------------
  await test('dayBucket is a stable UTC YYYY-MM-DD', () => {
    assert.equal(dayBucket(Date.UTC(2026, 6, 21, 23, 59)), '2026-07-21');
    assert.match(dayBucket(Date.now()), /^\d{4}-\d{2}-\d{2}$/);
  });

  // --- rate limit: blocks the 4th send in a day ----------------------------
  await test('consumeDailyQuota allows 3/day and blocks the 4th', async () => {
    const redis = await getRedisClient();
    const uid = `test-uid-${Math.random().toString(36).slice(2)}`;
    const now = Date.UTC(2026, 6, 21, 12, 0);
    const r1 = await consumeDailyQuota(redis, uid, now);
    const r2 = await consumeDailyQuota(redis, uid, now);
    const r3 = await consumeDailyQuota(redis, uid, now);
    const r4 = await consumeDailyQuota(redis, uid, now);
    assert.deepEqual(
      [r1.allowed, r2.allowed, r3.allowed, r4.allowed],
      [true, true, true, false],
    );
    assert.equal(r4.count, 4);
  });

  await test('consumeDailyQuota resets on a new UTC day', async () => {
    const redis = await getRedisClient();
    const uid = `test-uid-${Math.random().toString(36).slice(2)}`;
    const day1 = Date.UTC(2026, 6, 21, 12, 0);
    const day2 = Date.UTC(2026, 6, 22, 12, 0);
    await consumeDailyQuota(redis, uid, day1);
    await consumeDailyQuota(redis, uid, day1);
    await consumeDailyQuota(redis, uid, day1);
    const nextDay = await consumeDailyQuota(redis, uid, day2);
    assert.ok(nextDay.allowed, 'new day resets the quota');
  });

  // --- auth required -------------------------------------------------------
  await test('handler rejects a request with no Bearer token (401)', async () => {
    const res = mockRes();
    await handler(mockReq({ headers: {}, body: { type: 'welcome' } }), res);
    assert.equal(res.statusCode, 401);
  });

  await test('handler rejects non-POST methods (405)', async () => {
    const res = mockRes();
    await handler(mockReq({ method: 'GET' }), res);
    assert.equal(res.statusCode, 405);
  });

  process.stdout.write(`\nnotify: ${passed} passed, ${failures.length} failed\n`);
  if (failures.length) {
    failures.forEach((f) => process.stderr.write(`  FAIL ${f}\n`));
    process.exit(1);
  }
}

run();
