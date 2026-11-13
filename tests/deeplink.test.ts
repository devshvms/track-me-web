import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    parseLiveSessionPath,
    isValidSessionId,
    detectPlatform,
    buildNativeDeepLink,
    buildAndroidIntentUrl,
    buildStoreUrl,
    isBannerDismissed,
    resolveSmartBannerData,
    SMART_BANNER_DISMISS_TTL_MS,
} from '../lib/track/deeplink';

describe('Deep Link Path Resolution & Session Validation (CIE-004 & CIE-033)', () => {
    it('parses valid session ID from clean path', () => {
        const res = parseLiveSessionPath('/live/abc_12345');
        assert.equal(res.sessionId, 'abc_12345');
        assert.equal(res.isWatcherInvite, false);
        assert.equal(res.isValid, true);
    });

    it('ignores trailing slash gracefully', () => {
        const res = parseLiveSessionPath('/live/abc_12345/');
        assert.equal(res.sessionId, 'abc_12345');
        assert.equal(res.isValid, true);
    });

    it('handles percent-encoded hyphens and underscores', () => {
        const res = parseLiveSessionPath('/live/ride%2D99%5Fxy');
        assert.equal(res.sessionId, 'ride-99_xy');
        assert.equal(res.isValid, true);
    });

    it('identifies reserved watcher invite keyword', () => {
        const res = parseLiveSessionPath('/live/watcher');
        assert.equal(res.sessionId, 'watcher');
        assert.equal(res.isWatcherInvite, true);
        assert.equal(res.isValid, true);
    });

    it('identifies empty or missing session path as invalid', () => {
        const empty = parseLiveSessionPath('/live');
        assert.equal(empty.sessionId, '');
        assert.equal(empty.isValid, false);

        const emptySlash = parseLiveSessionPath('/live/');
        assert.equal(emptySlash.sessionId, '');
        assert.equal(emptySlash.isValid, false);

        const blank = parseLiveSessionPath('');
        assert.equal(blank.sessionId, '');
        assert.equal(blank.isValid, false);
    });

    it('rejects malformed session IDs violating regex length or characters', () => {
        // Too short (< 4 chars)
        assert.equal(parseLiveSessionPath('/live/ab').isValid, false);
        assert.equal(isValidSessionId('ab'), false);

        // Hostile characters
        assert.equal(parseLiveSessionPath('/live/<script>').isValid, false);
        assert.equal(isValidSessionId('<script>'), false);
        assert.equal(isValidSessionId('foo bar'), false);
        assert.equal(isValidSessionId('foo.bar'), false);

        // Valid strings
        assert.equal(isValidSessionId('abc_12345'), true);
        assert.equal(isValidSessionId('sess-9876_alpha'), true);
    });

    describe('Platform Detection (CIE-033)', () => {
        it('detects iOS from iPhone/iPad/iPod user agents', () => {
            assert.equal(detectPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'), 'ios');
            assert.equal(detectPlatform('Mozilla/5.0 (iPad; CPU OS 16_5 like Mac OS X) AppleWebKit/605.1.15'), 'ios');
            assert.equal(detectPlatform('Mozilla/5.0 (iPod touch; CPU iPhone OS 14_0 like Mac OS X)'), 'ios');
        });

        it('detects Android from user agents', () => {
            assert.equal(detectPlatform('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile'), 'android');
            assert.equal(detectPlatform('Mozilla/5.0 (Linux; U; Android 13; en-us; SM-S918B)'), 'android');
        });

        it('defaults to desktop for macOS, Windows, Linux, and empty UAs', () => {
            assert.equal(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'), 'desktop');
            assert.equal(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'desktop');
            assert.equal(detectPlatform(''), 'desktop');
            assert.equal(detectPlatform(null as any), 'desktop');
        });
    });

    describe('Native Deep Link Building (CIE-033)', () => {
        it('builds clean custom scheme URL without rider name', () => {
            const url = buildNativeDeepLink('sess_12345');
            assert.equal(url, 'trackme://live/sess_12345');
        });

        it('encodes and forwards rider name parameter', () => {
            const url = buildNativeDeepLink('sess_12345', 'Alex Rivera');
            assert.equal(url, 'trackme://live/sess_12345?name=Alex%20Rivera');
        });

        it('clamps long rider names and handles special characters safely', () => {
            const longName = 'A'.repeat(100);
            const url = buildNativeDeepLink('sess_12345', longName);
            assert.equal(url, `trackme://live/sess_12345?name=${'A'.repeat(60)}`);

            const special = buildNativeDeepLink('sess_12345', 'Jane & John / "Riders"');
            assert.ok(special.includes('Jane%20%26%20John%20%2F%20%22Riders%22'));
        });

        it('returns empty string for invalid session IDs', () => {
            assert.equal(buildNativeDeepLink('ab'), '');
            assert.equal(buildNativeDeepLink('<invalid>'), '');
        });

        it('supports reserved watcher invite keyword', () => {
            assert.equal(buildNativeDeepLink('watcher', 'Host'), 'trackme://live/watcher?name=Host');
        });
    });

    describe('Android Intent URL Building (CIE-033)', () => {
        it('constructs intent:// URL with package and browser fallback', () => {
            const intent = buildAndroidIntentUrl('sess_12345', 'Alex');
            assert.ok(intent.startsWith('intent://trackme.shvms.in/live/sess_12345?name=Alex#Intent;'));
            assert.ok(intent.includes('package=in.shvms.trackme;'));
            assert.ok(intent.includes('scheme=https;'));
            assert.ok(intent.includes('S.browser_fallback_url=https%3A%2F%2Fplay.google.com'));
        });

        it('returns fallback URL directly when sessionId is invalid', () => {
            const customFallback = 'https://trackme.shvms.in/get';
            const intent = buildAndroidIntentUrl('inv', null, customFallback);
            assert.equal(intent, customFallback);
        });
    });

    describe('Store URLs (CIE-033)', () => {
        it('returns platform-specific store URLs with organic campaign attribution', () => {
            assert.ok(buildStoreUrl('ios').includes('apps.apple.com'));
            assert.ok(buildStoreUrl('android').includes('play.google.com'));
            assert.ok(buildStoreUrl('desktop').includes('trackme.shvms.in/get'));
        });
    });

    describe('Banner Dismissal & Smart Banner Resolution (CIE-033)', () => {
        it('checks dismissal status with 7-day TTL', () => {
            const now = 1_700_000_000_000;
            assert.equal(isBannerDismissed(null, now), false);
            assert.equal(isBannerDismissed(undefined, now), false);
            assert.equal(isBannerDismissed(NaN, now), false);

            // Recent dismissal (1 hour ago) -> dismissed
            const oneHourAgo = now - 3600 * 1000;
            assert.equal(isBannerDismissed(oneHourAgo, now), true);

            // 6 days ago -> still dismissed
            const sixDaysAgo = now - 6 * 86400 * 1000;
            assert.equal(isBannerDismissed(sixDaysAgo, now), true);

            // 8 days ago -> expired (should show again)
            const eightDaysAgo = now - 8 * 86400 * 1000;
            assert.equal(isBannerDismissed(eightDaysAgo, now), false);
        });

        it('resolves smart banner data for mobile iOS viewer', () => {
            const res = resolveSmartBannerData({
                userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
                sessionId: 'sess_9999',
                riderName: 'Sarah',
            });
            assert.equal(res.shouldShow, true);
            assert.equal(res.platform, 'ios');
            assert.equal(res.deepLinkUrl, 'trackme://live/sess_9999?name=Sarah');
            assert.equal(res.title, "Track Sarah's Ride");
            assert.equal(res.ctaText, 'OPEN');
        });

        it('resolves smart banner data for mobile Android viewer', () => {
            const res = resolveSmartBannerData({
                userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile',
                sessionId: 'sess_9999',
                riderName: null,
            });
            assert.equal(res.shouldShow, true);
            assert.equal(res.platform, 'android');
            assert.ok(res.deepLinkUrl.startsWith('intent://trackme.shvms.in/live/sess_9999#Intent;'));
            assert.equal(res.title, 'TrackMe: Live GPS Rides');
        });

        it('suppresses banner for desktop users or dismissed viewers', () => {
            const desktopRes = resolveSmartBannerData({
                userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
                sessionId: 'sess_9999',
            });
            assert.equal(desktopRes.shouldShow, false);

            const dismissedRes = resolveSmartBannerData({
                userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
                sessionId: 'sess_9999',
                dismissedTimestamp: Date.now() - 1000,
            });
            assert.equal(dismissedRes.shouldShow, false);
        });
    });
});
