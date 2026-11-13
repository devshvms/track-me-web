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
    NETWORK_OFFLINE_TOAST_MESSAGE,
    NETWORK_RECONNECTED_TOAST_MESSAGE,
    evaluateNetworkToastState,
    evaluateNetworkTransition,
    evaluateViewportPreservation,
    shouldAnimateViewerTransition,
    formatA11yLiveAnnouncement,
    clampBatteryLevel,
    shouldAnnounceLowBattery,
    computeViewerAdaptivePollMs,
    formatPowerSaveCadenceNotice,
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

    describe('Live Viewer Network Reconnection Toast & Resiliency (CIE-034)', () => {
        it('returns persistent offline toast pill when client is offline during active trip', () => {
            const toast = evaluateNetworkToastState(false, false, false);
            assert.ok(toast);
            assert.equal(toast.isVisible, true);
            assert.equal(toast.message, NETWORK_OFFLINE_TOAST_MESSAGE);
            assert.equal(toast.message, 'Network offline · Retrying automatically');
            assert.equal(toast.type, 'offline');
            assert.equal(toast.icon, '⚡');
            assert.equal(toast.isPersistent, true);
        });

        it('returns transient green reconnected toast pill with auto-dismiss delay when reconnecting', () => {
            const toast = evaluateNetworkToastState(true, true, false);
            assert.ok(toast);
            assert.equal(toast.isVisible, true);
            assert.equal(toast.message, NETWORK_RECONNECTED_TOAST_MESSAGE);
            assert.equal(toast.message, 'Reconnected · Updating…');
            assert.equal(toast.type, 'reconnected');
            assert.equal(toast.icon, '✓');
            assert.equal(toast.isPersistent, false);
            assert.equal(toast.autoDismissDelayMs, 2500);
        });

        it('returns null toast when steadily online without recent offline state', () => {
            const toast = evaluateNetworkToastState(true, false, false);
            assert.equal(toast, null);
        });

        it('suppresses network toasts when trip has ended', () => {
            assert.equal(evaluateNetworkToastState(false, false, true), null);
            assert.equal(evaluateNetworkToastState(true, true, true), null);
            assert.equal(evaluateNetworkToastState(true, false, true), null);
        });

        it('evaluates network transition on offline event', () => {
            const evaluation = evaluateNetworkTransition(false, false, false);
            assert.equal(evaluation.shouldTriggerImmediateFetch, false);
            assert.equal(evaluation.resetConsecutiveErrors, false);
            assert.ok(evaluation.toast);
            assert.equal(evaluation.toast.type, 'offline');
        });

        it('evaluates network transition on reconnection event (resets errors and fetches immediately)', () => {
            const evaluation = evaluateNetworkTransition(true, true, false, false);
            assert.equal(evaluation.shouldTriggerImmediateFetch, true);
            assert.equal(evaluation.resetConsecutiveErrors, true);
            assert.ok(evaluation.toast);
            assert.equal(evaluation.toast.type, 'reconnected');
        });

        it('does not trigger duplicate fetch if fetch is already in progress on reconnection', () => {
            const evaluation = evaluateNetworkTransition(true, true, false, true);
            assert.equal(evaluation.shouldTriggerImmediateFetch, false);
            assert.equal(evaluation.resetConsecutiveErrors, true);
            assert.ok(evaluation.toast);
        });

        it('evaluates state transitions in ViewerNetworkStateMachine', () => {
            const sm = new ViewerNetworkStateMachine(true);
            assert.equal(sm.isOnline, true);
            assert.equal(sm.wasOffline, false);
            assert.equal(sm.offlineCount, 0);

            // Go offline
            assert.equal(sm.setOffline(), true);
            assert.equal(sm.isOnline, false);
            assert.equal(sm.wasOffline, true);
            assert.equal(sm.offlineCount, 1);

            // Redundant offline call returns false
            assert.equal(sm.setOffline(), false);
            assert.equal(sm.offlineCount, 1);

            // Come back online
            assert.equal(sm.setOnline(), true);
            assert.equal(sm.isOnline, true);
            assert.equal(sm.wasOffline, true);

            // Consume reconnection flag
            assert.equal(sm.consumeReconnection(), true);
            assert.equal(sm.wasOffline, false);
            assert.equal(sm.consumeReconnection(), false);
        });
    });

    describe('Live Viewer State Preservation across Orientation & Theme Changes (CIE-035)', () => {
        it('preserves rider focus when following rider with valid last position', () => {
            const riderPos: [number, number] = [28.6139, 77.2090];
            const currentCenter: [number, number] = [28.6100, 77.2000];
            const state = evaluateViewportPreservation(true, riderPos, currentCenter, 16, 'metric');

            assert.equal(state.isFollowingRider, true);
            assert.deepEqual(state.targetCenter, riderPos);
            assert.equal(state.targetZoom, 16);
            assert.equal(state.shouldPanToRider, true);
            assert.equal(state.preservedUnitSystem, 'metric');
        });

        it('enforces minimum zoom level 15 when centering on rider', () => {
            const riderPos: [number, number] = [28.6139, 77.2090];
            const currentCenter: [number, number] = [28.6100, 77.2000];
            const state = evaluateViewportPreservation(true, riderPos, currentCenter, 10, 'imperial');

            assert.equal(state.isFollowingRider, true);
            assert.deepEqual(state.targetCenter, riderPos);
            assert.equal(state.targetZoom, 15);
            assert.equal(state.shouldPanToRider, true);
            assert.equal(state.preservedUnitSystem, 'imperial');
        });

        it('preserves custom pan/zoom viewport when user panned away', () => {
            const riderPos: [number, number] = [28.6139, 77.2090];
            const customCenter: [number, number] = [28.7000, 77.1000];
            const state = evaluateViewportPreservation(false, riderPos, customCenter, 14, 'metric');

            assert.equal(state.isFollowingRider, false);
            assert.deepEqual(state.targetCenter, customCenter);
            assert.equal(state.targetZoom, 14);
            assert.equal(state.shouldPanToRider, false);
            assert.equal(state.preservedUnitSystem, 'metric');
        });

        it('handles null rider position gracefully without resetting custom viewport', () => {
            const customCenter: [number, number] = [20.5937, 78.9629];
            const state = evaluateViewportPreservation(true, null, customCenter, 12, 'imperial');

            assert.equal(state.isFollowingRider, false);
            assert.deepEqual(state.targetCenter, customCenter);
            assert.equal(state.targetZoom, 12);
            assert.equal(state.shouldPanToRider, false);
            assert.equal(state.preservedUnitSystem, 'imperial');
        });
    });

    describe('Reduced Motion & Screen Reader Accessibility (CIE-036)', () => {
        it('suppresses animations when user prefers reduced motion', () => {
            assert.equal(shouldAnimateViewerTransition(true), false);
            assert.equal(shouldAnimateViewerTransition(false), true);
        });

        it('formats polite screen reader live announcements for core tracking events', () => {
            assert.equal(formatA11yLiveAnnouncement('offline'), 'Network offline · Retrying automatically');
            assert.equal(formatA11yLiveAnnouncement('reconnected'), 'Network reconnected · Updating location');
            assert.equal(formatA11yLiveAnnouncement('stale'), 'Signal paused · Waiting for rider GPS');
            assert.equal(formatA11yLiveAnnouncement('ended', 'Priya'), 'Priya has ended this live trip');
            assert.equal(formatA11yLiveAnnouncement('ended', null), 'Rider has ended this live trip');
            assert.equal(formatA11yLiveAnnouncement('low_battery', null, 12), 'Rider phone battery low: 12%');
            assert.equal(formatA11yLiveAnnouncement('low_battery', null, null), 'Rider phone battery low');
        });
    });

    describe('Live Share Viewer Low Battery Throttle & Power-Save Mode Parity (CIE-037)', () => {
        describe('clampBatteryLevel', () => {
            it('preserves valid percentage values', () => {
                assert.equal(clampBatteryLevel(0), 0);
                assert.equal(clampBatteryLevel(15), 15);
                assert.equal(clampBatteryLevel(50), 50);
                assert.equal(clampBatteryLevel(100), 100);
            });

            it('rounds fractional battery percentages', () => {
                assert.equal(clampBatteryLevel(14.8), 15);
                assert.equal(clampBatteryLevel(4.2), 4);
                assert.equal(clampBatteryLevel(0.4), 0);
            });

            it('rejects simulator fallbacks (-1) and out-of-range values', () => {
                assert.equal(clampBatteryLevel(-1), null);
                assert.equal(clampBatteryLevel(-50), null);
                assert.equal(clampBatteryLevel(101), null);
                assert.equal(clampBatteryLevel(200), null);
            });

            it('rejects non-numeric and non-finite values', () => {
                assert.equal(clampBatteryLevel(NaN), null);
                assert.equal(clampBatteryLevel(Infinity), null);
                assert.equal(clampBatteryLevel(null), null);
                assert.equal(clampBatteryLevel(undefined), null);
                assert.equal(clampBatteryLevel('50'), null);
            });
        });

        describe('shouldAnnounceLowBattery', () => {
            it('triggers initial announcement when transitioning into <= 15%', () => {
                assert.equal(shouldAnnounceLowBattery(null, 15), true);
                assert.equal(shouldAnnounceLowBattery(80, 15), true);
                assert.equal(shouldAnnounceLowBattery(16, 14), true);
            });

            it('suppresses redundant intermediate announcements on 1% battery drops', () => {
                assert.equal(shouldAnnounceLowBattery(15, 14), false);
                assert.equal(shouldAnnounceLowBattery(14, 13), false);
                assert.equal(shouldAnnounceLowBattery(13, 10), false);
                assert.equal(shouldAnnounceLowBattery(10, 8), false);
                assert.equal(shouldAnnounceLowBattery(8, 6), false);
            });

            it('triggers critical announcement when transitioning into <= 5%', () => {
                assert.equal(shouldAnnounceLowBattery(12, 5), true);
                assert.equal(shouldAnnounceLowBattery(6, 4), true);
                assert.equal(shouldAnnounceLowBattery(15, 3), true);
            });

            it('suppresses intermediate announcements once in critical <= 5%', () => {
                assert.equal(shouldAnnounceLowBattery(5, 4), false);
                assert.equal(shouldAnnounceLowBattery(4, 3), false);
                assert.equal(shouldAnnounceLowBattery(3, 1), false);
            });

            it('does not trigger when battery is above 15% or charging', () => {
                assert.equal(shouldAnnounceLowBattery(null, 80), false);
                assert.equal(shouldAnnounceLowBattery(15, 20), false);
                assert.equal(shouldAnnounceLowBattery(5, 5), false);
            });

            it('handles simulator fallback and invalid inputs safely', () => {
                assert.equal(shouldAnnounceLowBattery(null, -1), false);
                assert.equal(shouldAnnounceLowBattery(-1, -1), false);
                assert.equal(shouldAnnounceLowBattery(80, null), false);
            });
        });

        describe('computeViewerAdaptivePollMs', () => {
            it('relaxes polling to 12s when rider device is in power-save mode', () => {
                assert.equal(computeViewerAdaptivePollMs(true, 80), 12000);
                assert.equal(computeViewerAdaptivePollMs(true, null), 12000);
            });

            it('relaxes polling to 12s when battery is <= 15%', () => {
                assert.equal(computeViewerAdaptivePollMs(false, 15), 12000);
                assert.equal(computeViewerAdaptivePollMs(false, 5), 12000);
                assert.equal(computeViewerAdaptivePollMs(false, 0), 12000);
            });

            it('maintains 5s default polling under normal battery and power state', () => {
                assert.equal(computeViewerAdaptivePollMs(false, 80), 5000);
                assert.equal(computeViewerAdaptivePollMs(false, 16), 5000);
                assert.equal(computeViewerAdaptivePollMs(false, null), 5000);
                assert.equal(computeViewerAdaptivePollMs(false, -1), 5000);
            });

            it('respects custom base polling intervals when not in power save', () => {
                assert.equal(computeViewerAdaptivePollMs(false, 80, 7000), 7000);
                assert.equal(computeViewerAdaptivePollMs(true, 80, 7000), 12000);
            });
        });

        describe('formatPowerSaveCadenceNotice', () => {
            it('returns disclosure string when power-save mode is active', () => {
                assert.equal(formatPowerSaveCadenceNotice(true, 80), 'Power save active · Location updates every ~15s');
            });

            it('returns disclosure string when battery is <= 15%', () => {
                assert.equal(formatPowerSaveCadenceNotice(false, 14), 'Power save active · Location updates every ~15s');
            });

            it('returns null under standard conditions', () => {
                assert.equal(formatPowerSaveCadenceNotice(false, 50), null);
                assert.equal(formatPowerSaveCadenceNotice(false, null), null);
                assert.equal(formatPowerSaveCadenceNotice(false, -1), null);
            });
        });
    });
});

