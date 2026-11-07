import assert from 'node:assert/strict';

function buildPlayStoreReferrer(params: Record<string, string>): string {
  const parts: string[] = [];
  const allowed = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
  for (const key of allowed) {
    if (params[key]) {
      parts.push(`${key}=${encodeURIComponent(params[key])}`);
    }
  }
  return parts.join('&');
}

function resolveVisitorOS(userAgent: string): 'ios' | 'android' | 'desktop' {
  if (/iPad|iPhone|iPod/i.test(userAgent)) return 'ios';
  if (/Android/i.test(userAgent)) return 'android';
  return 'desktop';
}

function validateTelemetryPayload(payload: { event: string; properties?: Record<string, any> }) {
  assert.ok(payload.event, 'Event name must be non-empty');
  const props = payload.properties || {};
  // Privacy invariant: no raw latitude, longitude or recipient PII allowed in events
  assert.strictEqual(props.lat, undefined, 'Raw latitude must not be present');
  assert.strictEqual(props.lon, undefined, 'Raw longitude must not be present');
  assert.strictEqual(props.lng, undefined, 'Raw longitude must not be present');
  assert.strictEqual(props.email, undefined, 'Raw email must not be present');
}

function runTests() {
  let passed = 0;

  // Test 1: buildPlayStoreReferrer encodes UTM parameters cleanly
  {
    const ref = buildPlayStoreReferrer({
      utm_source: 'live_share_viewer',
      utm_medium: 'web',
      utm_campaign: 'live_tracker'
    });
    assert.strictEqual(ref, 'utm_source=live_share_viewer&utm_medium=web&utm_campaign=live_tracker');
    const fullUrl = `https://play.google.com/store/apps/details?id=in.shvms.trackme&referrer=${encodeURIComponent(ref)}`;
    assert.ok(fullUrl.includes('referrer=utm_source%3Dlive_share_viewer'));
    passed++;
  }

  // Test 2: OS resolution
  {
    assert.strictEqual(resolveVisitorOS('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'), 'ios');
    assert.strictEqual(resolveVisitorOS('Mozilla/5.0 (Linux; Android 14; Pixel 8)'), 'android');
    assert.strictEqual(resolveVisitorOS('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), 'desktop');
    assert.strictEqual(resolveVisitorOS('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'desktop');
    passed++;
  }

  // Test 3: Telemetry privacy invariants
  {
    validateTelemetryPayload({
      event: 'live_share_viewed',
      properties: { sessionId: 'sess-123', os: 'android', surface: 'live_share_viewer' }
    });
    validateTelemetryPayload({
      event: 'download_cta_clicked',
      properties: { platform: 'android', os: 'android', surface: 'live_share_viewer', state: 'live' }
    });
    validateTelemetryPayload({
      event: 'group_invite_viewed',
      properties: { surface: 'group_invite_preview', hasToken: true, os: 'ios' }
    });
    passed++;
  }

  console.log(`install attribution: ${passed} passed, 0 failed`);
}

runTests();
