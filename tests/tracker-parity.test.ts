import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { formatElapsedDuration as formatElapsedDurationTs } from '../lib/track/duration';
import { computePathDistanceMeters as computePathDistanceMetersTs } from '../lib/track/trail';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const TrackCore = require('../public/js/tracker-core.js');

type TestCase = { name: string; fn: () => void | Promise<void> };
const tests: TestCase[] = [];

function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

function extractInlineTrackerScript(html: string): string {
  const scripts = Array.from(html.matchAll(/<script(?:\s+src="([^"]+)")?[^>]*>([\s\S]*?)<\/script>/gi));
  const inline = scripts.find((m) => !m[1] && m[2].includes('parsedLivePath'));
  assert.ok(inline, 'tracker.html must contain the main inline tracker script');
  return inline[2];
}

function runTrackerInSandbox(options: { pathname: string; search: string; userAgent?: string }) {
  const html = fs.readFileSync(path.resolve(__dirname, '../public/tracker.html'), 'utf8');
  const scriptSrc = extractInlineTrackerScript(html);

  const elements = new Map<string, any>();
  const ensureElement = (id: string) => {
    if (!elements.has(id)) {
      const attrs = new Map<string, string>();
      const classes = new Set<string>();
      elements.set(id, {
        id,
        hidden: false,
        href: '',
        innerText: '',
        textContent: '',
        className: '',
        style: {} as Record<string, string>,
        dataset: {} as Record<string, string>,
        listeners: {} as Record<string, Function[]>,
        classList: {
          add(c: string) { classes.add(c); },
          remove(c: string) { classes.delete(c); },
          toggle(c: string, force?: boolean) {
            if (force === undefined) {
              if (classes.has(c)) classes.delete(c); else classes.add(c);
            } else if (force) {
              classes.add(c);
            } else {
              classes.delete(c);
            }
          },
          contains(c: string) { return classes.has(c); },
        },
        setAttribute(k: string, v: string) { attrs.set(k, String(v)); },
        getAttribute(k: string) { return attrs.get(k) || null; },
        addEventListener(ev: string, fn: Function) {
          this.listeners[ev] = this.listeners[ev] || [];
          this.listeners[ev].push(fn);
        },
        scrollIntoView() {},
      });
    }
    return elements.get(id);
  };

  for (const id of [
    'smartAppBanner', 'ogTitle', 'twTitle', 'ogDesc', 'twDesc', 'ogUrl',
    'unitToggleBtn', 'statusText', 'detailsText', 'userName', 'userNameText',
    'openAppBtn', 'smartBanner', 'smartBannerClose', 'smartBannerTitle',
    'smartBannerCta', 'getApp', 'getAppCopy',
  ]) {
    ensureElement(id);
  }

  const telemetryEvents: any[] = [];
  const docListeners = new Set<string>();
  const bodyClasses = new Set<string>();
  const sandboxWindow: any = {
    location: {
      origin: 'https://trackme.shvms.in',
      pathname: options.pathname,
      search: options.search,
      href: `https://trackme.shvms.in${options.pathname}${options.search}`,
    },
    addEventListener() {},
    matchMedia() { return { matches: false }; },
    isSecureContext: false,
  };
  const sandbox: any = {
    TrackCore,
    URLSearchParams,
    Date,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Set,
    Object,
    JSON,
    encodeURIComponent,
    decodeURIComponent,
    parseInt,
    parseFloat,
    setTimeout: () => 1,
    clearTimeout: () => {},
    console,
    window: sandboxWindow,
    navigator: {
      userAgent: options.userAgent || 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
      platform: 'iPhone',
      maxTouchPoints: 5,
      languages: ['en-US'],
      language: 'en-US',
    },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
    },
    sessionStorage: {
      getItem: () => 'viewer-sandbox-1',
      setItem: () => {},
    },
    L: {
      tileLayer() {
        return { on() {}, addTo() {} };
      },
      map() {
        return {
          setView() { return this; },
          removeLayer() {},
          invalidateSize() {},
        };
      },
    },
    document: {
      readyState: 'complete',
      title: '',
      hidden: false,
      visibilityState: 'visible',
      body: {
        classList: {
          add(c: string) { bodyClasses.add(c); },
          remove(c: string) { bodyClasses.delete(c); },
          contains(c: string) { return bodyClasses.has(c); },
        },
      },
      getElementById: (id: string) => ensureElement(id),
      querySelectorAll: () => [],
      addEventListener: (ev: string) => { docListeners.add(ev); },
    },
    fetch: (url: string, init?: any) => {
      telemetryEvents.push({ url, init });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    },
  };
  sandbox.globalThis = sandbox;
  sandboxWindow.document = sandbox.document;
  sandboxWindow.fetch = sandbox.fetch;

  vm.runInNewContext(scriptSrc, sandbox);
  return { elements, telemetryEvents, sandbox };
}

test('tracker.html loads /js/tracker-core.js and eliminates duplicate math/throttle definitions (M-2)', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../public/tracker.html'), 'utf8');
  assert.ok(html.includes('<script src="/js/tracker-core.js"></script>'));
  assert.ok(html.includes('TrackCore.parseLiveSessionPath'));
  assert.ok(html.includes('TrackCore.evaluateSpectatorThrottleState'));
  assert.ok(html.includes('TrackCore.decimatePolyline'));
  assert.ok(html.includes('TrackCore.computeBackoffDelay'));
});

test('TrackCore matches server-side duration.ts and trail.ts implementations without drift (M-2)', () => {
  const now = 1700000000000;
  assert.strictEqual(TrackCore.formatElapsedDuration(now - 30_000, now, now), formatElapsedDurationTs(now - 30_000, now, now));
  assert.strictEqual(TrackCore.formatElapsedDuration(now - 4_500_000, now, now), formatElapsedDurationTs(now - 4_500_000, now, now));
  assert.strictEqual(TrackCore.formatElapsedDuration(now - 7_200_000, now, now), formatElapsedDurationTs(now - 7_200_000, now, now));

  const samplePath: Array<[number, number]> = [
    [12.9716, 77.5946],
    [12.9726, 77.5956],
    [12.9746, 77.5976],
  ];
  assert.strictEqual(TrackCore.computePathDistanceMeters(samplePath), computePathDistanceMetersTs(samplePath));
  // Ensure negative battery (-1 simulator fallback) does NOT trigger power-save in TrackCore (M-2 regression)
  const throttle = TrackCore.evaluateSpectatorThrottleState(false, false, now, now, false, -1, 5000, 300000);
  assert.strictEqual(throttle.isThrottled, false);
  assert.strictEqual(throttle.pollDelayMs, 5000);
});

test('tracker.html inline script renders /live/watcher?code=... with valid iOS deep link and rejects legacy inviterUid-only links (H-2, M-2)', () => {
  const valid = runTrackerInSandbox({
    pathname: '/live/watcher',
    search: '?code=abcDEF1234567890&inviterName=Alice%20Rider',
  });
  assert.strictEqual(valid.elements.get('statusText').innerText, 'Trusted Watcher Invite');
  assert.strictEqual(valid.elements.get('userNameText').innerText, 'Alice Rider wants to add you as a Trusted Watcher');
  assert.strictEqual(
    valid.elements.get('openAppBtn').href,
    'trackme://live/watcher?code=abcDEF1234567890&inviterName=Alice%20Rider',
  );
  assert.strictEqual(
    valid.elements.get('smartBannerCta').href,
    'trackme://live/watcher?code=abcDEF1234567890&inviterName=Alice%20Rider',
  );

  const legacy = runTrackerInSandbox({
    pathname: '/live/watcher',
    search: '?inviterUid=static-uid-1&inviterName=Alice',
  });
  assert.strictEqual(legacy.elements.get('statusText').innerText, 'Invite Outdated');
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
  process.stdout.write(`\ntracker-parity: ${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) {
    for (const f of failures) process.stderr.write(`  - ${f}\n`);
    process.exit(1);
  }
}

main();
