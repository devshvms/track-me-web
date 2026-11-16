import assert from 'node:assert';
import {
  sanitizeRiderName,
  buildLiveShareUrl,
  resolveLiveShareMetadata,
} from '../lib/track/metadata';

type TestCase = { name: string; fn: () => void | Promise<void> };
const tests: TestCase[] = [];

function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

test('sanitizeRiderName returns null for empty or invalid names', () => {
  assert.strictEqual(sanitizeRiderName(null), null);
  assert.strictEqual(sanitizeRiderName(undefined), null);
  assert.strictEqual(sanitizeRiderName(''), null);
  assert.strictEqual(sanitizeRiderName('   '), null);
  assert.strictEqual(sanitizeRiderName('\n\t  \r'), null);
});

test('sanitizeRiderName trims whitespace and strips HTML tags', () => {
  assert.strictEqual(sanitizeRiderName('  Alex  '), 'Alex');
  assert.strictEqual(sanitizeRiderName('<script>alert("xss")</script>Alex'), 'alert("xss")Alex');
  assert.strictEqual(sanitizeRiderName('<b>Sam</b>'), 'Sam');
  assert.strictEqual(sanitizeRiderName('<i>Jordan</i> <img src=x onerror=alert(1)>'), 'Jordan');
});

test('sanitizeRiderName limits length to 60 characters', () => {
  const longName = 'A'.repeat(80);
  const sanitized = sanitizeRiderName(longName);
  assert.strictEqual(sanitized, 'A'.repeat(60));
  assert.strictEqual(sanitized?.length, 60);
});

test('buildLiveShareUrl builds canonical URL without rider name', () => {
  assert.strictEqual(
    buildLiveShareUrl('https://trackme.shvms.in', 'ride-123'),
    'https://trackme.shvms.in/live/ride-123'
  );
});

test('buildLiveShareUrl strips trailing slashes from baseUrl', () => {
  assert.strictEqual(
    buildLiveShareUrl('https://trackme.shvms.in///', 'ride-123'),
    'https://trackme.shvms.in/live/ride-123'
  );
});

test('buildLiveShareUrl encodes session ID and query parameters', () => {
  assert.strictEqual(
    buildLiveShareUrl('https://trackme.shvms.in', 'ride/123?foo=bar'),
    'https://trackme.shvms.in/live/ride%2F123%3Ffoo%3Dbar'
  );
  assert.strictEqual(
    buildLiveShareUrl('https://trackme.shvms.in', 'ride-456', 'Alex Rivera'),
    'https://trackme.shvms.in/live/ride-456?name=Alex%20Rivera'
  );
});

test('buildLiveShareUrl ignores blank rider names', () => {
  assert.strictEqual(
    buildLiveShareUrl('https://trackme.shvms.in', 'ride-456', '   '),
    'https://trackme.shvms.in/live/ride-456'
  );
  assert.strictEqual(
    buildLiveShareUrl('https://trackme.shvms.in', 'ride-456', null),
    'https://trackme.shvms.in/live/ride-456'
  );
});

test('resolveLiveShareMetadata produces default active ride card without name', () => {
  const meta = resolveLiveShareMetadata({
    sessionId: 'ride-999',
    baseUrl: 'https://trackme.shvms.in',
  });
  assert.strictEqual(meta.title, 'TrackMe Live Ride Tracking · Real-Time GPS Sharing');
  assert.ok(meta.description.includes('Follow this ride live in real time'));
  assert.strictEqual(meta.canonicalUrl, 'https://trackme.shvms.in/live/ride-999');
  assert.strictEqual(meta.ogImage, 'https://trackme.shvms.in/assets/trackme-social-card.svg');
});

test('resolveLiveShareMetadata produces personalized active ride card with rider name', () => {
  const meta = resolveLiveShareMetadata({
    sessionId: 'ride-999',
    riderName: 'Sarah Connor',
    baseUrl: 'https://trackme.shvms.in',
  });
  assert.strictEqual(meta.title, "Sarah Connor's Live Ride · TrackMe");
  assert.ok(meta.description.includes('Follow Sarah Connor live in real time on TrackMe'));
  assert.strictEqual(meta.canonicalUrl, 'https://trackme.shvms.in/live/ride-999?name=Sarah%20Connor');
  assert.strictEqual(meta.ogImage, 'https://trackme.shvms.in/assets/trackme-social-card.svg');
});

test('resolveLiveShareMetadata produces completed ride card when isStopped is true', () => {
  const meta = resolveLiveShareMetadata({
    sessionId: 'ride-999',
    riderName: 'Sarah Connor',
    baseUrl: 'https://trackme.shvms.in',
    isStopped: true,
  });
  assert.strictEqual(meta.title, "Sarah Connor's Ride on TrackMe · Trip Completed");
  assert.ok(meta.description.includes("View Sarah Connor's completed route"));

  const defaultStopped = resolveLiveShareMetadata({
    sessionId: 'ride-999',
    isStopped: true,
  });
  assert.strictEqual(defaultStopped.title, 'TrackMe Live Ride Tracking · Trip Completed');
  assert.ok(defaultStopped.description.includes('View this completed route'));
});

test('resolveLiveShareMetadata handles null sessionId gracefully', () => {
  const meta = resolveLiveShareMetadata({
    sessionId: null,
    baseUrl: 'https://trackme.shvms.in',
  });
  assert.strictEqual(meta.canonicalUrl, 'https://trackme.shvms.in/live');
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

  process.stdout.write(`\nmetadata: ${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) {
    for (const f of failures) process.stderr.write(`  - ${f}\n`);
    process.exit(1);
  }
}

main();
