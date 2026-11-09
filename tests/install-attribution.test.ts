import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT_DIR = path.resolve(__dirname, '..');

function extractGetRedirectScript(html: string): string {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match && match[1], 'public/get.html must contain inline redirect <script>');
  return match[1];
}

interface SimulatedEnvResult {
  replacedUrl: string | null;
  androidHref: string;
  iosHref: string;
  telemetryEvents: Array<{ url: string; options: any; parsedBody: any }>;
}

function runGetHtmlInVm(options: {
  search: string;
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
}): SimulatedEnvResult {
  const getHtml = fs.readFileSync(path.join(ROOT_DIR, 'public/get.html'), 'utf-8');
  const scriptCode = extractGetRedirectScript(getHtml);

  let replacedUrl: string | null = null;
  let domReadyCallback: (() => void) | null = null;
  const androidBtn = { href: 'https://play.google.com/store/apps/details?id=in.shvms.trackme' };
  const iosBtn = { href: 'https://apps.apple.com/app/id6800161248' };
  const telemetryEvents: Array<{ url: string; options: any; parsedBody: any }> = [];

  const sandbox = {
    URLSearchParams,
    encodeURIComponent,
    JSON,
    window: {
      location: {
        search: options.search,
        replace: (url: string) => {
          replacedUrl = url;
        }
      },
      opera: '',
      MSStream: undefined,
      addEventListener: (event: string, cb: () => void) => {
        if (event === 'DOMContentLoaded') domReadyCallback = cb;
      }
    },
    navigator: {
      userAgent: options.userAgent,
      vendor: '',
      platform: options.platform ?? 'Linux',
      maxTouchPoints: options.maxTouchPoints ?? 0
    },
    document: {
      getElementById: (id: string) => {
        if (id === 'btn-android') return androidBtn;
        if (id === 'btn-ios') return iosBtn;
        return null;
      }
    },
    fetch: (url: string, fetchOpts: any) => {
      telemetryEvents.push({
        url,
        options: fetchOpts,
        parsedBody: fetchOpts?.body ? JSON.parse(fetchOpts.body) : null
      });
      return Promise.resolve({ ok: true });
    }
  };

  vm.runInNewContext(scriptCode, sandbox);
  if (domReadyCallback) {
    (domReadyCallback as () => void)();
  }

  return {
    replacedUrl,
    androidHref: androidBtn.href,
    iosHref: iosBtn.href,
    telemetryEvents
  };
}

function validateTelemetryPayload(payload: { event: string; properties?: Record<string, any> }) {
  assert.ok(payload.event, 'Event name must be non-empty');
  const props = payload.properties || {};
  assert.strictEqual(props.lat, undefined, 'Raw latitude must not be present');
  assert.strictEqual(props.lon, undefined, 'Raw longitude must not be present');
  assert.strictEqual(props.lng, undefined, 'Raw longitude must not be present');
  assert.strictEqual(props.email, undefined, 'Raw email must not be present');
  assert.strictEqual(props.username, undefined, 'Raw username must not be present');
}

function runTests() {
  let passed = 0;

  // Integration Test 1: vercel.json routing rules for /get, /r, /r/, /r/:path*, /g/:path*, /live/:path*
  {
    const vercelConfig = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'vercel.json'), 'utf-8'));
    const rewrites: Array<{ source: string; destination: string }> = vercelConfig.rewrites || [];
    const map = new Map(rewrites.map((r) => [r.source, r.destination]));
    assert.strictEqual(map.get('/get'), '/get.html', '/get must rewrite to /get.html');
    assert.strictEqual(map.get('/r'), '/get.html', '/r must rewrite to /get.html');
    assert.strictEqual(map.get('/r/'), '/get.html', '/r/ must rewrite to /get.html');
    assert.strictEqual(map.get('/r/:path*'), '/index.html', '/r/:path* must rewrite to /index.html');
    assert.strictEqual(map.get('/g/:path*'), '/group.html', '/g/:path* must rewrite to /group.html');
    assert.strictEqual(map.get('/live/:sessionId'), '/tracker.html', '/live/:sessionId must rewrite to /tracker.html');
    passed++;
  }

  // Integration Test 2: /get.html Android execution with default and custom UTM parameters
  {
    const resDefault = runGetHtmlInVm({
      search: '',
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)'
    });
    assert.strictEqual(
      resDefault.replacedUrl,
      'https://play.google.com/store/apps/details?id=in.shvms.trackme&referrer=utm_source%3Droute_card%26utm_medium%3Dshare'
    );
    assert.strictEqual(resDefault.androidHref, resDefault.replacedUrl);
    assert.strictEqual(resDefault.telemetryEvents.length, 1);
    assert.strictEqual(resDefault.telemetryEvents[0].parsedBody.event, 'get_redirect_visited');
    assert.strictEqual(resDefault.telemetryEvents[0].parsedBody.properties.os, 'android');
    assert.strictEqual(resDefault.telemetryEvents[0].parsedBody.properties.utm_source, 'route_card');
    validateTelemetryPayload(resDefault.telemetryEvents[0].parsedBody);

    const resCustom = runGetHtmlInVm({
      search: '?utm_source=weekly_recap&utm_medium=social&utm_campaign=w45',
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)'
    });
    assert.strictEqual(
      resCustom.replacedUrl,
      'https://play.google.com/store/apps/details?id=in.shvms.trackme&referrer=utm_source%3Dweekly_recap%26utm_medium%3Dsocial%26utm_campaign%3Dw45'
    );
    assert.strictEqual(resCustom.telemetryEvents[0].parsedBody.properties.utm_campaign, 'w45');
    passed++;
  }

  // Integration Test 3: /get.html iOS and iPadOS 13+ (MacIntel + maxTouchPoints > 1) execution
  {
    const resIphone = runGetHtmlInVm({
      search: '?utm_source=route_card',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)'
    });
    assert.strictEqual(
      resIphone.replacedUrl,
      'https://apps.apple.com/app/id6800161248?pt=128001612&ct=route_card&mt=8'
    );
    assert.strictEqual(resIphone.iosHref, resIphone.replacedUrl);
    assert.strictEqual(resIphone.telemetryEvents[0].parsedBody.properties.os, 'ios');

    const resIpad = runGetHtmlInVm({
      search: '?utm_source=weekly_recap',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
      platform: 'MacIntel',
      maxTouchPoints: 5
    });
    assert.strictEqual(
      resIpad.replacedUrl,
      'https://apps.apple.com/app/id6800161248?pt=128001612&ct=weekly_recap&mt=8',
      'iPadOS 13+ desktop-class UA with multi-touch must route to App Store'
    );
    assert.strictEqual(resIpad.telemetryEvents[0].parsedBody.properties.os, 'ios');
    passed++;
  }

  // Integration Test 4: /get.html Desktop fallback preserves utm_source, utm_medium, and utm_campaign
  {
    const resDesktop = runGetHtmlInVm({
      search: '?utm_source=route_card&utm_medium=share&utm_campaign=minimal',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      platform: 'MacIntel',
      maxTouchPoints: 0
    });
    assert.strictEqual(
      resDesktop.replacedUrl,
      '/?utm_source=route_card&utm_medium=share&utm_campaign=minimal'
    );
    assert.strictEqual(resDesktop.telemetryEvents[0].parsedBody.properties.os, 'desktop');
    passed++;
  }

  // Integration Test 5: Cross-file consistency of store attribution links & privacy across tracker.html, group.html, index.html
  {
    const trackerHtml = fs.readFileSync(path.join(ROOT_DIR, 'public/tracker.html'), 'utf-8');
    const groupHtml = fs.readFileSync(path.join(ROOT_DIR, 'public/group.html'), 'utf-8');
    const indexHtml = fs.readFileSync(path.join(ROOT_DIR, 'public/index.html'), 'utf-8');

    // Tracker HTML checks
    assert.ok(
      trackerHtml.includes('referrer=utm_source%3Dlive_share_viewer%26utm_medium%3Dweb%26utm_campaign%3Dlive_tracker'),
      'tracker.html must include encoded Play Store referrer'
    );
    assert.ok(
      trackerHtml.includes('https://apps.apple.com/app/id6800161248?pt=128001612&ct=live_share_viewer&mt=8'),
      'tracker.html must include App Store campaign link with pt=128001612'
    );
    assert.ok(
      !trackerHtml.includes('properties: { sessionId, username, viewerId'),
      'tracker.html must not leak username PII in live_share_location_rendered telemetry'
    );

    // Group HTML checks
    assert.ok(
      groupHtml.includes('referrer=utm_source%3Dgroup_invite%26utm_medium%3Dweb%26utm_campaign%3Dgroup_invite_preview'),
      'group.html must include encoded Play Store referrer'
    );
    assert.ok(
      groupHtml.includes('https://apps.apple.com/app/id6800161248?pt=128001612&ct=group_invite_preview&mt=8'),
      'group.html must include App Store campaign link with pt=128001612'
    );
    assert.ok(
      groupHtml.includes("event: 'group_invite_viewed'"),
      'group.html must emit group_invite_viewed telemetry'
    );

    // Index HTML checks
    assert.ok(
      indexHtml.includes("trackEvent('store_cta_in_view'"),
      'index.html must emit store_cta_in_view when hero actions intersect'
    );
    assert.ok(
      indexHtml.includes("'.download-cta[data-download-platform=\"android\"]'"),
      'index.html must dynamically decorate Android Play Store CTAs with referrer'
    );
    assert.ok(
      indexHtml.includes("'.download-cta[data-download-platform=\"ios\"]'"),
      'index.html must dynamically decorate iOS App Store CTAs with campaign token'
    );
    passed++;
  }

  console.log(`install attribution: ${passed} passed, 0 failed`);
}

runTests();
