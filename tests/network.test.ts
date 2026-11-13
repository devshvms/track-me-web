import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    getTileLayerConfig,
    getAvailableTileProvidersCount,
    getBatteryDisplay,
    LOW_BATTERY_THRESHOLD,
    shouldSwitchTileMirror,
    ViewerNetworkStateMachine,
    STALE_SIGNAL_THRESHOLD_SECONDS,
    isSignalStale,
    formatStaleSignalText,
    shouldShowConnectionRetry,
    buildMapsUrls,
    formatLiveShareText,
    formatLocationShareText,
    shouldShowLowBatteryBanner,
    formatLowBatteryBannerText,
    shouldEmitLowBatteryTelemetry,
    evaluateForegroundReconnection,
} from '../lib/track/network';

describe('Live Viewer Network Resilience & Tile Fallback (CIE-007)', () => {
    describe('Tile Layer Configuration & Mirror Fallback', () => {
        it('returns primary OpenStreetMap tile provider for attempt 0', () => {
            const config = getTileLayerConfig(0);
            assert.equal(config.name, 'OpenStreetMap Primary');
            assert.equal(config.isFallback, false);
            assert.ok(config.url.includes('tile.openstreetmap.org'));
            assert.deepEqual(config.subdomains, ['a', 'b', 'c']);
            assert.equal(config.maxZoom, 19);
        });

        it('returns secondary mirror for attempt 1', () => {
            const config = getTileLayerConfig(1);
            assert.equal(config.name, 'OSM France Humanitarian');
            assert.equal(config.isFallback, true);
            assert.ok(config.url.includes('tile.openstreetmap.fr/hot'));
        });

        it('returns tertiary mirror for attempt 2', () => {
            const config = getTileLayerConfig(2);
            assert.equal(config.name, 'CartoDB Voyager');
            assert.equal(config.isFallback, true);
            assert.ok(config.url.includes('basemaps.cartocdn.com'));
        });

        it('clamps negative attempts to primary provider', () => {
            const config = getTileLayerConfig(-5);
            assert.equal(config.name, 'OpenStreetMap Primary');
            assert.equal(config.isFallback, false);
        });

        it('clamps out-of-bounds attempts to highest fallback provider', () => {
            const total = getAvailableTileProvidersCount();
            assert.ok(total >= 3);
            const config = getTileLayerConfig(999);
            assert.equal(config.name, 'CartoDB Voyager');
            assert.equal(config.isFallback, true);
        });

        it('evaluates tile error tolerance threshold', () => {
            assert.equal(shouldSwitchTileMirror(0), false);
            assert.equal(shouldSwitchTileMirror(1), false);
            assert.equal(shouldSwitchTileMirror(2), false);
            assert.equal(shouldSwitchTileMirror(3), true);
            assert.equal(shouldSwitchTileMirror(5), true);
            assert.equal(shouldSwitchTileMirror(2, 2), true);
        });
    });

    describe('Battery Level Formatting & Low-Battery Alerts', () => {
        it('handles null, undefined, and non-numeric battery values gracefully', () => {
            assert.deepEqual(getBatteryDisplay(null), {
                text: 'N/A',
                isLow: false,
                icon: '',
                fullLabel: 'N/A',
            });
            assert.deepEqual(getBatteryDisplay(undefined), {
                text: 'N/A',
                isLow: false,
                icon: '',
                fullLabel: 'N/A',
            });
            assert.deepEqual(getBatteryDisplay(NaN), {
                text: 'N/A',
                isLow: false,
                icon: '',
                fullLabel: 'N/A',
            });
            assert.deepEqual(getBatteryDisplay(-10), {
                text: 'N/A',
                isLow: false,
                icon: '',
                fullLabel: 'N/A',
            });
            assert.deepEqual(getBatteryDisplay(150), {
                text: 'N/A',
                isLow: false,
                icon: '',
                fullLabel: 'N/A',
            });
        });

        it('formats normal battery levels with standard icon', () => {
            const result85 = getBatteryDisplay(85);
            assert.equal(result85.text, '85%');
            assert.equal(result85.isLow, false);
            assert.equal(result85.icon, '🔋');
            assert.equal(result85.fullLabel, '🔋 85%');

            const result16 = getBatteryDisplay(16);
            assert.equal(result16.isLow, false);
            assert.equal(result16.icon, '🔋');
        });

        it('identifies and formats low battery levels at or below 15%', () => {
            assert.equal(LOW_BATTERY_THRESHOLD, 15);

            const result15 = getBatteryDisplay(15);
            assert.equal(result15.text, '15%');
            assert.equal(result15.isLow, true);
            assert.equal(result15.icon, '🪫');
            assert.equal(result15.fullLabel, '🪫 15% (Low Battery)');

            const result5 = getBatteryDisplay(5.4);
            assert.equal(result5.text, '5%');
            assert.equal(result5.isLow, true);
            assert.equal(result5.icon, '🪫');
            assert.equal(result5.fullLabel, '🪫 5% (Low Battery)');

            const result0 = getBatteryDisplay(0);
            assert.equal(result0.text, '0%');
            assert.equal(result0.isLow, true);
            assert.equal(result0.icon, '🪫');
            assert.equal(result0.fullLabel, '🪫 0% (Low Battery)');
        });
    });

    describe('Viewer Network State Machine', () => {
        it('initializes to online state by default', () => {
            const sm = new ViewerNetworkStateMachine();
            assert.equal(sm.isOnline, true);
            assert.equal(sm.wasOffline, false);
            assert.equal(sm.offlineCount, 0);
        });

        it('transitions correctly between offline and online', () => {
            const sm = new ViewerNetworkStateMachine(true);

            // Transition to offline
            const transitionedToOffline = sm.setOffline();
            assert.equal(transitionedToOffline, true);
            assert.equal(sm.isOnline, false);
            assert.equal(sm.wasOffline, true);
            assert.equal(sm.offlineCount, 1);

            // Idempotent offline calls
            assert.equal(sm.setOffline(), false);
            assert.equal(sm.offlineCount, 1);

            // Transition to online
            const transitionedToOnline = sm.setOnline();
            assert.equal(transitionedToOnline, true);
            assert.equal(sm.isOnline, true);
            assert.equal(sm.wasOffline, true); // wasOffline remains true until consumed

            // Consume reconnection
            assert.equal(sm.consumeReconnection(), true);
            assert.equal(sm.wasOffline, false);
            assert.equal(sm.consumeReconnection(), false);
        });
    });

    describe('Stale Signal Detection & Banner Formatting (CIE-019)', () => {
        it('identifies fresh coordinates within 180s threshold as active', () => {
            const now = 1_700_000_000_000;
            const freshIso = new Date(now - 30_000).toISOString(); // 30s ago
            assert.equal(isSignalStale(freshIso, now), false);

            const exactlyUnder = new Date(now - 179_000).toISOString();
            assert.equal(isSignalStale(exactlyUnder, now), false);
        });

        it('identifies coordinates older than 180s as stale', () => {
            const now = 1_700_000_000_000;
            const staleIso = new Date(now - 180_000).toISOString(); // exactly 180s ago
            assert.equal(isSignalStale(staleIso, now), true);

            const veryStaleIso = new Date(now - 300_000).toISOString(); // 5m ago
            assert.equal(isSignalStale(veryStaleIso, now), true);

            const numericEpoch = now - 200_000;
            assert.equal(isSignalStale(numericEpoch, now), true);
        });

        it('handles null, undefined, and malformed timestamps gracefully', () => {
            assert.equal(isSignalStale(null), false);
            assert.equal(isSignalStale(undefined), false);
            assert.equal(isSignalStale('invalid-date'), false);
            assert.equal(isSignalStale(0), false);
            assert.equal(isSignalStale(-500), false);
        });

        it('formats user-facing stale signal banner message with elapsed time', () => {
            assert.equal(formatStaleSignalText(45), 'Signal paused · Waiting for rider GPS');
            assert.equal(formatStaleSignalText(180), 'Signal paused · Waiting for rider GPS (3m ago)');
            assert.equal(formatStaleSignalText(245), 'Signal paused · Waiting for rider GPS (4m ago)');
            assert.equal(formatStaleSignalText(0), 'Signal paused · Waiting for rider GPS');
        });
    });

    describe('Connection Retry Visibility (CIE-019)', () => {
        it('hides retry button when online with zero consecutive errors', () => {
            assert.equal(shouldShowConnectionRetry(0, true), false);
        });

        it('shows retry button when offline even with zero consecutive errors', () => {
            assert.equal(shouldShowConnectionRetry(0, false), true);
        });

        it('shows retry button when 1 or more consecutive fetch errors occur', () => {
            assert.equal(shouldShowConnectionRetry(1, true), true);
            assert.equal(shouldShowConnectionRetry(3, true), true);
            assert.equal(shouldShowConnectionRetry(2, false), true);
        });
    });

    describe('Live Share & Location Share Text Formatting (CIE-021)', () => {
        it('builds valid Google Maps and Apple Maps navigation URLs', () => {
            const urls = buildMapsUrls(28.6139, 77.2090);
            assert.equal(urls.googleMapsUrl, 'https://maps.google.com/?q=28.6139,77.209');
            assert.equal(urls.appleMapsUrl, 'https://maps.apple.com/?q=28.6139,77.209');
        });

        it('formats live share message text with rider name or fallback', () => {
            const withName = formatLiveShareText('Shivam', 'https://trackme.shvms.in/live/abc123');
            assert.equal(withName, "Track Shivam's live ride on TrackMe: https://trackme.shvms.in/live/abc123");

            const withoutName = formatLiveShareText(null, 'https://trackme.shvms.in/live/abc123');
            assert.equal(withoutName, 'Track my live ride on TrackMe: https://trackme.shvms.in/live/abc123');

            const emptyName = formatLiveShareText('   ', 'https://trackme.shvms.in/live/abc123');
            assert.equal(emptyName, 'Track my live ride on TrackMe: https://trackme.shvms.in/live/abc123');
        });

        it('formats location action text with live link, timestamp, and maps URLs', () => {
            const fixedTime = new Date('2026-11-13T10:30:00Z').getTime();
            const formatted = formatLocationShareText('RiderX', 'https://trackme.shvms.in/live/session1', 37.7749, -122.4194, fixedTime);
            assert.ok(formatted.includes("Track RiderX's live ride on TrackMe: https://trackme.shvms.in/live/session1"));
            assert.ok(formatted.includes('Google Maps: https://maps.google.com/?q=37.7749,-122.4194'));
            assert.ok(formatted.includes('Apple Maps: https://maps.apple.com/?q=37.7749,-122.4194'));
            assert.ok(formatted.includes('Last seen at'));
        });
    });

    describe('Low-Battery Warning Banner & Telemetry Deduplication (CIE-022)', () => {
        it('evaluates low battery banner visibility rules correctly', () => {
            // Low battery levels (<= 15) when active
            assert.equal(shouldShowLowBatteryBanner(15, false), true);
            assert.equal(shouldShowLowBatteryBanner(12, false), true);
            assert.equal(shouldShowLowBatteryBanner(15.4, false), true);
            assert.equal(shouldShowLowBatteryBanner(0, false), true);

            // Normal battery levels (> 15)
            assert.equal(shouldShowLowBatteryBanner(16, false), false);
            assert.equal(shouldShowLowBatteryBanner(15.5, false), false); // rounds to 16
            assert.equal(shouldShowLowBatteryBanner(85, false), false);

            // Stopped sessions should NEVER show low battery warning
            assert.equal(shouldShowLowBatteryBanner(10, true), false);
            assert.equal(shouldShowLowBatteryBanner(5, true), false);

            // Invalid/null/undefined battery values
            assert.equal(shouldShowLowBatteryBanner(null, false), false);
            assert.equal(shouldShowLowBatteryBanner(undefined, false), false);
            assert.equal(shouldShowLowBatteryBanner(NaN, false), false);
            assert.equal(shouldShowLowBatteryBanner(-5, false), false);
            assert.equal(shouldShowLowBatteryBanner(105, false), false);
        });

        it('formats low battery banner text with rounded percentage and warning', () => {
            assert.equal(
                formatLowBatteryBannerText(12),
                '🪫 Rider battery low (12%) · Signal may pause if phone powers off'
            );
            assert.equal(
                formatLowBatteryBannerText(15.2),
                '🪫 Rider battery low (15%) · Signal may pause if phone powers off'
            );
            assert.equal(
                formatLowBatteryBannerText(0),
                '🪫 Rider battery low (0%) · Signal may pause if phone powers off'
            );

            // Null when battery > 15 or invalid
            assert.equal(formatLowBatteryBannerText(16), null);
            assert.equal(formatLowBatteryBannerText(50), null);
            assert.equal(formatLowBatteryBannerText(null), null);
            assert.equal(formatLowBatteryBannerText(undefined), null);
        });

        it('deduplicates telemetry events on identical battery levels', () => {
            // First time seeing low battery 14%: emit
            assert.equal(shouldEmitLowBatteryTelemetry(null, 14), true);

            // Subsequent polls at 14%: suppress (zero spam)
            assert.equal(shouldEmitLowBatteryTelemetry(14, 14), false);
            assert.equal(shouldEmitLowBatteryTelemetry(14, 13.9), false); // rounds to 14

            // Dropped to 13%: emit
            assert.equal(shouldEmitLowBatteryTelemetry(14, 13), true);

            // Normal battery (> 15%): suppress
            assert.equal(shouldEmitLowBatteryTelemetry(null, 50), false);
            assert.equal(shouldEmitLowBatteryTelemetry(12, 80), false);

            // Invalid/null battery: suppress
            assert.equal(shouldEmitLowBatteryTelemetry(null, null), false);
            assert.equal(shouldEmitLowBatteryTelemetry(null, NaN), false);
        });
    });

    describe('Foreground Reconnection & Immediate Polling (CIE-027)', () => {
        it('suppresses polling when trip has already ended', () => {
            const res = evaluateForegroundReconnection(true, true, 'Sharing Stopped');
            assert.equal(res.shouldFetchImmediately, false);
            assert.equal(res.resetConsecutiveErrors, false);
            assert.equal(res.newStatusText, null);
            assert.equal(res.newStatusClass, null);
        });

        it('triggers immediate polling and error counter reset when active and online', () => {
            const res = evaluateForegroundReconnection(false, true, 'Live');
            assert.equal(res.shouldFetchImmediately, true);
            assert.equal(res.resetConsecutiveErrors, true);
            assert.equal(res.newStatusText, null);
            assert.equal(res.newStatusClass, null);
        });

        it('transitions status to Reconnecting... when returning online from offline or error status', () => {
            const offlineRes = evaluateForegroundReconnection(false, true, 'Viewer Offline');
            assert.equal(offlineRes.shouldFetchImmediately, true);
            assert.equal(offlineRes.resetConsecutiveErrors, true);
            assert.equal(offlineRes.newStatusText, 'Reconnecting...');
            assert.equal(offlineRes.newStatusClass, 'status delayed');

            const errorRes = evaluateForegroundReconnection(false, true, 'Connection Error');
            assert.equal(errorRes.shouldFetchImmediately, true);
            assert.equal(errorRes.resetConsecutiveErrors, true);
            assert.equal(errorRes.newStatusText, 'Reconnecting...');
            assert.equal(errorRes.newStatusClass, 'status delayed');

            const connectingRes = evaluateForegroundReconnection(false, true, 'Connecting...');
            assert.equal(connectingRes.shouldFetchImmediately, true);
            assert.equal(connectingRes.resetConsecutiveErrors, true);
            assert.equal(connectingRes.newStatusText, 'Reconnecting...');
            assert.equal(connectingRes.newStatusClass, 'status delayed');
        });

        it('does not trigger immediate polling if device is still offline upon foregrounding', () => {
            const res = evaluateForegroundReconnection(false, false, 'Viewer Offline');
            assert.equal(res.shouldFetchImmediately, false);
            assert.equal(res.resetConsecutiveErrors, true);
            assert.equal(res.newStatusText, null);
            assert.equal(res.newStatusClass, null);
        });
    });
});
