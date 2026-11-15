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

function runTrackerInSandbox(options: {
  pathname: string;
  search: string;
  userAgent?: string;
  share?: (payload: { title?: string; text?: string; url?: string }) => Promise<void>;
}) {
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
    setInterval: () => 1,
    clearInterval: () => {},
    console,
    window: sandboxWindow,
    navigator: {
      userAgent: options.userAgent || 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
      platform: 'iPhone',
      maxTouchPoints: 5,
      languages: ['en-US'],
      language: 'en-US',
      ...(options.share ? { share: options.share } : {}),
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
          on() { return this; },
          getZoom() { return 15; },
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
  assert.ok(html.includes('TrackCore.computeViewerPingDelay'));
  assert.ok(html.includes('TrackCore.shouldSkipPresencePing'));
});

test('TrackCore matches server-side duration.ts, trail.ts, and backoff.ts implementations without drift (M-2)', () => {
  const {
    computeViewerPingDelay: computeViewerPingDelayTs,
    evaluateZeroViewerHibernation: evaluateZeroViewerHibernationTs,
  } = require('../lib/track/backoff');
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

  // CIE-046 parity check between TrackCore and lib/track/backoff.ts
  const noJitter = () => 0;
  assert.strictEqual(
    TrackCore.computeViewerPingDelay(2, { isLowDataMode: true }, noJitter),
    computeViewerPingDelayTs(2, { isLowDataMode: true }, noJitter),
  );
  assert.deepStrictEqual(
    TrackCore.evaluateZeroViewerHibernation({
      activeViewers: 0,
      zeroViewersSinceEpochMs: now - 600_000,
      nowEpochMs: now,
      configuredIntervalMs: 5000,
      isPowerSaveOrLowBattery: false,
    }),
    evaluateZeroViewerHibernationTs({
      activeViewers: 0,
      zeroViewersSinceEpochMs: now - 600_000,
      nowEpochMs: now,
      configuredIntervalMs: 5000,
      isPowerSaveOrLowBattery: false,
    }),
  );
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

test('shareBtn passes separate caption and url to navigator.share without duplicating the URL', async () => {
  const sharedPayloads: Array<{ title?: string; text?: string; url?: string }> = [];
  const res = runTrackerInSandbox({
    pathname: '/live/604a0cf8-2a66-47b6-addf-0714789fda2d',
    search: '?name=Black%20White',
    share: async (payload) => {
      sharedPayloads.push(payload);
    },
  });
  const shareListeners = res.elements.get('shareBtn')?.listeners?.click || [];
  assert.ok(shareListeners.length >= 1, 'shareBtn should register a click handler');
  await shareListeners[0]();
  assert.strictEqual(sharedPayloads.length, 1);
  const payload = sharedPayloads[0];
  assert.strictEqual(
    payload.url,
    'https://trackme.shvms.in/live/604a0cf8-2a66-47b6-addf-0714789fda2d?name=Black%20White',
  );
  assert.strictEqual(payload.text, "Track Black White's live ride on TrackMe");
  assert.ok(!payload.text?.includes('https://'), 'share caption must not embed a second URL alongside navigator.share url');
});

test('dismissing #getApp hides banner and tapping #openAppBtn on desktop reveals it again', () => {
  const desktop = runTrackerInSandbox({
    pathname: '/live/604a0cf8-2a66-47b6-addf-0714789fda2d',
    search: '?name=Black%20White',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36',
  });
  const closeListeners = desktop.elements.get('getAppClose')?.listeners?.click || [];
  const openAppListeners = desktop.elements.get('openAppBtn')?.listeners?.click || [];
  assert.ok(closeListeners.length >= 1, 'getAppClose should register a click handler');
  assert.ok(openAppListeners.length >= 1, 'openAppBtn should register a click handler');

  closeListeners[0]();
  assert.strictEqual(desktop.elements.get('getApp').hidden, true);

  openAppListeners[0]({ preventDefault() {} });
  assert.strictEqual(desktop.elements.get('getApp').hidden, false);
});

test('TrackCore.evaluateLivePauseState distinguishes auto-paused, manual paused, active, and stopped states', () => {
  const autoPaused = TrackCore.evaluateLivePauseState({
    status: 'active',
    isPaused: true,
    pauseReason: 'auto',
    lastLocation: { lat: 12.97, lng: 77.59, speed: 0 },
  });
  assert.strictEqual(autoPaused.isPaused, true);
  assert.strictEqual(autoPaused.pauseReason, 'auto');
  assert.strictEqual(autoPaused.statusLabel, 'Auto-Paused');
  assert.strictEqual(autoPaused.speedLabel, 'Auto-paused');
  assert.ok(autoPaused.bannerText.includes('auto-paused'));

  const manualPaused = TrackCore.evaluateLivePauseState({
    status: 'active',
    lastLocation: { lat: 12.97, lng: 77.59, isPaused: true, pauseReason: 'manual' },
  });
  assert.strictEqual(manualPaused.isPaused, true);
  assert.strictEqual(manualPaused.pauseReason, 'manual');
  assert.strictEqual(manualPaused.statusLabel, 'Ride Paused');
  assert.strictEqual(manualPaused.speedLabel, 'Paused');

  const moving = TrackCore.evaluateLivePauseState({
    status: 'active',
    isPaused: false,
    lastLocation: { lat: 12.97, lng: 77.59, speed: 5.5 },
  });
  assert.strictEqual(moving.isPaused, false);
  assert.strictEqual(moving.statusLabel, 'Live');

  const stopped = TrackCore.evaluateLivePauseState({
    status: 'stopped',
    isPaused: true,
    pauseReason: 'auto',
  });
  assert.strictEqual(stopped.isPaused, false);
  assert.strictEqual(stopped.statusLabel, 'Sharing Stopped');
});

test('tracker.html renders greyed-out paused circle marker without heading cone and suppresses paused trail growth', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../public/tracker.html'), 'utf8');
  assert.ok(html.includes('id="pausedStatusContainer"'), 'paused status banner container should exist');
  assert.ok(html.includes('.rider-pin-root.is-paused .human-marker'), 'rider badge should grey out when paused');
  assert.ok(html.includes('else if (!isRiderPaused)'), 'trailPoints should suppress drift appends when paused');

  const script = extractInlineTrackerScript(html);
  const fnMatch = script.match(/function buildHeadingConeSvg\([\s\S]*?\n {12}\}/);
  assert.ok(fnMatch, 'buildHeadingConeSvg should exist in tracker.html');
  const ctx: Record<string, any> = {};
  vm.runInNewContext(fnMatch[0], ctx);

  const pausedSvg: string = ctx.buildHeadingConeSvg(true, true);
  assert.ok(pausedSvg.includes('#94a3b8'), 'paused marker must use muted grey fill');
  assert.ok(pausedSvg.includes('<circle'), 'paused marker must render a circle');
  assert.ok(!pausedSvg.includes('<polygon'), 'paused marker must not render a heading arrow');
  assert.ok(!pausedSvg.includes('coneGrad'), 'paused marker must not render a heading cone');

  const movingSvg: string = ctx.buildHeadingConeSvg(true, false);
  assert.ok(movingSvg.includes('#00e5ff'), 'moving marker keeps active cyan fill');
  assert.ok(movingSvg.includes('<polygon'), 'moving marker renders heading arrow');
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
