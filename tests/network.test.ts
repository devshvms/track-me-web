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
    shouldDecimatePolyline,
    computePerpendicularDistanceMeters,
    decimatePolyline,
    computeElapsedSeconds,
    computeAverageSpeed,
    formatAverageSpeed,
    formatConcludedSummary,
    computeOffCenterDistanceMeters,
    formatOffCenterDistance,
    formatRecenterButtonLabel,
    formatRecenterAccessibilityLabel,
    shouldResumeFollowMode,
    computePollLatencyMs,
    shouldSampleViewerHealth,
    classifyViewerError,
    buildViewerHealthTelemetryPayload,
    shouldPreserveViewerState,
    evaluateReconnectionResync,
    serializeViewerCachePayload,
    deserializeViewerCachePayload,
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

    describe('Live Share Viewer Breadcrumb Polyline Decimation & Memory Compaction (CIE-038)', () => {
        describe('shouldDecimatePolyline', () => {
            it('returns false when point count is below or equal to threshold', () => {
                assert.equal(shouldDecimatePolyline(0, 200), false);
                assert.equal(shouldDecimatePolyline(50, 200), false);
                assert.equal(shouldDecimatePolyline(200, 200), false);
            });

            it('returns true when point count exceeds threshold', () => {
                assert.equal(shouldDecimatePolyline(201, 200), true);
                assert.equal(shouldDecimatePolyline(500, 200), true);
            });

            it('respects custom minPointsThreshold', () => {
                assert.equal(shouldDecimatePolyline(100, 50), true);
                assert.equal(shouldDecimatePolyline(40, 50), false);
            });
        });

        describe('computePerpendicularDistanceMeters', () => {
            it('returns near-zero distance for a point on a line segment', () => {
                const a: [number, number] = [28.6139, 77.2090];
                const b: [number, number] = [28.6239, 77.2090];
                const p: [number, number] = [28.6189, 77.2090]; // exact midpoint
                const dist = computePerpendicularDistanceMeters(p, a, b);
                assert.ok(dist < 0.01, `Expected near zero, got ${dist}`);
            });

            it('calculates accurate perpendicular distance for an offset point', () => {
                // A and B on same latitude, P offset north by ~111 meters (0.001 deg)
                const a: [number, number] = [28.6139, 77.2000];
                const b: [number, number] = [28.6139, 77.2100];
                const p: [number, number] = [28.6149, 77.2050];
                const dist = computePerpendicularDistanceMeters(p, a, b);
                // ~0.001 deg lat * 111320 m/deg ≈ 111.3m
                assert.ok(Math.abs(dist - 111.3) < 1.0, `Expected ~111.3m, got ${dist}`);
            });

            it('handles coincident A and B points safely without divide-by-zero', () => {
                const a: [number, number] = [28.6139, 77.2090];
                const p: [number, number] = [28.6149, 77.2090];
                const dist = computePerpendicularDistanceMeters(p, a, a);
                assert.ok(dist > 100 && dist < 120, `Expected ~111.3m, got ${dist}`);
            });
        });

        describe('decimatePolyline', () => {
            it('bypasses decimation and returns points directly when count <= 2', () => {
                const twoPoints: Array<[number, number]> = [[28.61, 77.20], [28.62, 77.21]];
                const result = decimatePolyline(twoPoints, 3.5, 0);
                assert.deepEqual(result, twoPoints);
            });

            it('bypasses decimation when point count <= minPointsThreshold', () => {
                const points: Array<[number, number]> = [
                    [28.610, 77.200],
                    [28.611, 77.200],
                    [28.612, 77.200],
                    [28.613, 77.200],
                ];
                // Threshold = 10, points count = 4 -> should not decimate
                const result = decimatePolyline(points, 3.5, 10);
                assert.equal(result.length, 4);
                assert.deepEqual(result, points);
            });

            it('decimates perfectly collinear points down to first and last endpoints', () => {
                const collinearPoints: Array<[number, number]> = [
                    [28.6100, 77.2000],
                    [28.6110, 77.2000],
                    [28.6120, 77.2000],
                    [28.6130, 77.2000],
                    [28.6140, 77.2000],
                    [28.6150, 77.2000],
                ];
                const decimated = decimatePolyline(collinearPoints, 3.5, 0);
                assert.equal(decimated.length, 2);
                assert.deepEqual(decimated[0], collinearPoints[0]);
                assert.deepEqual(decimated[1], collinearPoints[5]);
            });

            it('preserves sharp corners and turns where perpendicular distance exceeds epsilon', () => {
                const rightAngleRoute: Array<[number, number]> = [
                    [28.6100, 77.2000], // Start
                    [28.6110, 77.2000], // Collinear on leg 1
                    [28.6120, 77.2000], // Corner turn point
                    [28.6120, 77.2010], // Collinear on leg 2
                    [28.6120, 77.2020], // Finish
                ];
                const decimated = decimatePolyline(rightAngleRoute, 3.5, 0);
                // Corner should be preserved, intermediate collinear points pruned
                assert.equal(decimated.length, 3);
                assert.deepEqual(decimated[0], rightAngleRoute[0]);
                assert.deepEqual(decimated[1], rightAngleRoute[2]); // Corner preserved
                assert.deepEqual(decimated[2], rightAngleRoute[4]); // Finish preserved
            });

            it('filters out GPS micro-jitter below epsilon while maintaining route shape', () => {
                // Jitter of 1-2 meters (< 3.5m epsilon) along North-bound path
                // 1 deg latitude ≈ 111,320m -> 0.00001 deg ≈ 1.11m
                const jitterRoute: Array<[number, number]> = [
                    [28.6100, 77.20000], // Start
                    [28.6110, 77.20001], // ~0.9m jitter east
                    [28.6120, 77.19999], // ~0.9m jitter west
                    [28.6130, 77.20001], // ~0.9m jitter east
                    [28.6140, 77.20000], // Finish
                ];
                const decimated = decimatePolyline(jitterRoute, 3.5, 0);
                assert.equal(decimated.length, 2);
                assert.deepEqual(decimated[0], jitterRoute[0]);
                assert.deepEqual(decimated[1], jitterRoute[4]);
            });
        });
    });

    describe('Concluded Trip Summary, Stop Reason & Average Speed Parity (CIE-039)', () => {
        describe('computeElapsedSeconds', () => {
            it('returns elapsed seconds between timestamps', () => {
                const start = '2026-11-13T10:00:00Z';
                const end = '2026-11-13T10:45:30Z';
                assert.equal(computeElapsedSeconds(start, end), 2730);
            });

            it('handles numeric epoch timestamps', () => {
                const start = 1700000000000;
                const end = 1700000060000;
                assert.equal(computeElapsedSeconds(start, end), 60);
            });

            it('returns null on invalid or future timestamps', () => {
                assert.equal(computeElapsedSeconds(null, '2026-11-13T10:00:00Z'), null);
                assert.equal(computeElapsedSeconds('2026-11-13T11:00:00Z', '2026-11-13T10:00:00Z'), null);
                assert.equal(computeElapsedSeconds('not-a-date'), null);
            });
        });

        describe('computeAverageSpeed', () => {
            it('computes metric average speed in km/h', () => {
                // 10,000 meters in 1,800 seconds (30m) = 20 km/h
                assert.equal(computeAverageSpeed(10000, 1800, false), 20.0);
                // 15,250 meters in 2,745 seconds ≈ 20.0 km/h
                assert.equal(computeAverageSpeed(15250, 2745, false), 20.0);
            });

            it('computes imperial average speed in mph', () => {
                // 10,000 meters in 1,800 seconds = 20 km/h * 0.621371 = 12.427 -> 12.4 mph
                assert.equal(computeAverageSpeed(10000, 1800, true), 12.4);
            });

            it('returns 0 for zero distance when duration >= 5s', () => {
                assert.equal(computeAverageSpeed(0, 60, false), 0.0);
                assert.equal(computeAverageSpeed(0, 60, true), 0.0);
            });

            it('returns null for short durations (< 5s), negative distances, or non-finite inputs', () => {
                assert.equal(computeAverageSpeed(1000, 4, false), null);
                assert.equal(computeAverageSpeed(1000, 0, false), null);
                assert.equal(computeAverageSpeed(-500, 60, false), null);
                assert.equal(computeAverageSpeed(null, 60, false), null);
                assert.equal(computeAverageSpeed(1000, null, false), null);
                assert.equal(computeAverageSpeed(NaN, 60, false), null);
                assert.equal(computeAverageSpeed(1000, Infinity, false), null);
            });

            it('rejects supersonic single-hop glitches (> 200 km/h)', () => {
                // 50,000 meters in 600 seconds = 300 km/h -> reject
                assert.equal(computeAverageSpeed(50000, 600, false), null);
            });
        });

        describe('formatAverageSpeed', () => {
            it('formats metric and imperial speeds with single decimal precision', () => {
                assert.equal(formatAverageSpeed(21.43, false), '21.4 km/h');
                assert.equal(formatAverageSpeed(13.28, true), '13.3 mph');
                assert.equal(formatAverageSpeed(0, false), '0.0 km/h');
            });

            it('returns null for invalid inputs', () => {
                assert.equal(formatAverageSpeed(null), null);
                assert.equal(formatAverageSpeed(undefined), null);
                assert.equal(formatAverageSpeed(-5), null);
                assert.equal(formatAverageSpeed(NaN), null);
            });
        });

        describe('formatConcludedSummary', () => {
            it('formats a complete summary with duration, distance, and average speed', () => {
                const summary = formatConcludedSummary(
                    'Arrived at destination safely.',
                    14200, // 14.2 km
                    2700,  // 45m
                    false  // metric
                );
                assert.equal(summary.statusText, 'Trip Completed');
                assert.equal(summary.avgSpeedStr, '18.9 km/h');
                assert.equal(summary.durationStr, '45m');
                assert.equal(summary.distanceStr, '14.2 km');
                assert.equal(summary.detailsText, 'Arrived at destination safely. · Duration: 45m · Distance: 14.2 km · Avg Speed: 18.9 km/h');
                assert.equal(summary.a11yText, 'Trip ended. Arrived at destination safely.. Total distance 14.2 km. Duration 45m. Average speed 18.9 km/h.');
            });

            it('uses fallback text when stopReason is null or empty', () => {
                const summary = formatConcludedSummary(null, 5000, 1200, false);
                assert.ok(summary.detailsText.startsWith('The rider has ended this live trip.'));
                assert.ok(summary.a11yText.includes('The rider has ended this live trip.'));
            });

            it('handles imperial unit conversion correctly', () => {
                const summary = formatConcludedSummary('Ride finished', 16093.44, 3600, true);
                assert.equal(summary.distanceStr, '10.0 mi');
                assert.equal(summary.avgSpeedStr, '10.0 mph');
                assert.ok(summary.detailsText.includes('Distance: 10.0 mi'));
                assert.ok(summary.detailsText.includes('Avg Speed: 10.0 mph'));
            });
        });
    });

    describe('Live Share Viewer Off-Screen Distance Badge & Follow-Mode Inactivity Auto-Resume (CIE-040)', () => {
        describe('computeOffCenterDistanceMeters', () => {
            it('returns 0 for coincident points or invalid inputs', () => {
                assert.equal(computeOffCenterDistanceMeters(28.6139, 77.2090, 28.6139, 77.2090), 0);
                assert.equal(computeOffCenterDistanceMeters(NaN, 77.2090, 28.6139, 77.2090), 0);
                assert.equal(computeOffCenterDistanceMeters(28.6139, Infinity, 28.6139, 77.2090), 0);
            });

            it('computes accurate geodesic distance between viewport center and rider', () => {
                // 0.01 deg latitude difference ≈ 1,113 meters
                const dist = computeOffCenterDistanceMeters(28.6100, 77.2000, 28.6200, 77.2000);
                assert.ok(Math.abs(dist - 1113.2) < 5.0, `Expected ~1113m, got ${dist}`);
            });
        });

        describe('formatOffCenterDistance', () => {
            it('returns null when distance is below threshold (< 250m)', () => {
                assert.equal(formatOffCenterDistance(0), null);
                assert.equal(formatOffCenterDistance(150), null);
                assert.equal(formatOffCenterDistance(249), null);
            });

            it('formats metric distance with 1 decimal precision when >= 250m', () => {
                assert.equal(formatOffCenterDistance(250), '0.3 km');
                assert.equal(formatOffCenterDistance(1400), '1.4 km');
                assert.equal(formatOffCenterDistance(10000), '10.0 km');
            });

            it('formats imperial distance in miles when requested', () => {
                assert.equal(formatOffCenterDistance(1609.344, true), '1.0 mi');
                assert.equal(formatOffCenterDistance(4828.032, true), '3.0 mi');
            });

            it('handles invalid inputs safely', () => {
                assert.equal(formatOffCenterDistance(null), null);
                assert.equal(formatOffCenterDistance(undefined), null);
                assert.equal(formatOffCenterDistance(NaN), null);
                assert.equal(formatOffCenterDistance(-500), null);
            });
        });

        describe('formatRecenterButtonLabel & AccessibilityLabel', () => {
            it('returns clean base label when rider is near viewport center', () => {
                assert.equal(formatRecenterButtonLabel(100, false, 250, 'Recenter'), 'Recenter');
                assert.equal(formatRecenterButtonLabel(100, false, 250, 'Follow'), 'Follow');
                assert.equal(formatRecenterAccessibilityLabel(100, false, 250, 'Recenter on rider'), 'Recenter on rider');
            });

            it('appends formatted distance badge when rider is far from center', () => {
                assert.equal(formatRecenterButtonLabel(1400, false, 250, 'Recenter'), 'Recenter · 1.4 km');
                assert.equal(formatRecenterButtonLabel(1400, false, 250, 'Follow'), 'Follow · 1.4 km');
                assert.equal(formatRecenterButtonLabel(1609.344, true, 250, 'Recenter'), 'Recenter · 1.0 mi');
                assert.equal(formatRecenterAccessibilityLabel(1400, false, 250, 'Recenter on rider'), 'Recenter on rider, 1.4 km away');
                assert.equal(formatRecenterAccessibilityLabel(1609.344, true, 250, 'Follow rider'), 'Follow rider, 1.0 mi away');
            });
        });

        describe('shouldResumeFollowMode', () => {
            it('returns false if already following rider', () => {
                const now = 1700000030000;
                const lastInteraction = 1700000000000; // 30s ago (> 20s timeout)
                assert.equal(shouldResumeFollowMode(true, false, lastInteraction, now, 20000), false);
            });

            it('returns false if trip has concluded', () => {
                const now = 1700000030000;
                const lastInteraction = 1700000000000; // 30s ago
                assert.equal(shouldResumeFollowMode(false, true, lastInteraction, now, 20000), false);
            });

            it('returns false if user recently interacted (< timeout)', () => {
                const now = 1700000015000;
                const lastInteraction = 1700000000000; // 15s ago (< 20s timeout)
                assert.equal(shouldResumeFollowMode(false, false, lastInteraction, now, 20000), false);
            });

            it('returns true when inactive for >= timeout during an active trip', () => {
                const now = 1700000020000;
                const lastInteraction = 1700000000000; // 20s exactly
                assert.equal(shouldResumeFollowMode(false, false, lastInteraction, now, 20000), true);

                const nowLater = 1700000045000; // 45s ago
                assert.equal(shouldResumeFollowMode(false, false, lastInteraction, nowLater, 20000), true);
            });

            it('handles invalid or zero timestamps safely', () => {
                assert.equal(shouldResumeFollowMode(false, false, 0, 1700000000000, 20000), false);
                assert.equal(shouldResumeFollowMode(false, false, null, 1700000000000, 20000), false);
                assert.equal(shouldResumeFollowMode(false, false, -100, 1700000000000, 20000), false);
            });
        });

        describe('computePollLatencyMs', () => {
            it('computes positive round latency between start and end ms', () => {
                assert.equal(computePollLatencyMs(1000, 1245), 245);
                assert.equal(computePollLatencyMs(1000.2, 1245.8), 246);
            });

            it('clamps negative durations to 0', () => {
                assert.equal(computePollLatencyMs(2000, 1000), 0);
            });

            it('handles non-finite values safely returning 0', () => {
                assert.equal(computePollLatencyMs(NaN, 1000), 0);
                assert.equal(computePollLatencyMs(1000, Infinity), 0);
            });
        });

        describe('shouldSampleViewerHealth', () => {
            it('samples at default 1% (0.01) rate', () => {
                assert.equal(shouldSampleViewerHealth(0.01, () => 0.005), true);
                assert.equal(shouldSampleViewerHealth(0.01, () => 0.015), false);
            });

            it('respects custom rates and clamps bounds', () => {
                assert.equal(shouldSampleViewerHealth(-0.5, () => 0.0001), false);
                assert.equal(shouldSampleViewerHealth(1.5, () => 0.999), true);
            });
        });

        describe('classifyViewerError', () => {
            it('classifies 404 and 410 as not_found_or_expired', () => {
                assert.equal(classifyViewerError(404), 'not_found_or_expired');
                assert.equal(classifyViewerError(410), 'not_found_or_expired');
            });

            it('classifies 429 as rate_limited', () => {
                assert.equal(classifyViewerError(429), 'rate_limited');
            });

            it('classifies 5xx as server_error', () => {
                assert.equal(classifyViewerError(500), 'server_error');
                assert.equal(classifyViewerError(502), 'server_error');
                assert.equal(classifyViewerError(503), 'server_error');
            });

            it('classifies malformed or JSON syntax errors as malformed_response', () => {
                assert.equal(classifyViewerError(null, 'SyntaxError: Unexpected token < in JSON at position 0'), 'malformed_response');
                assert.equal(classifyViewerError(200, 'Malformed response payload'), 'malformed_response');
            });

            it('classifies network, offline, or status 0 as offline_network', () => {
                assert.equal(classifyViewerError(0), 'offline_network');
                assert.equal(classifyViewerError(null, 'TypeError: Failed to fetch'), 'offline_network');
                assert.equal(classifyViewerError(null, 'AbortError: The operation was aborted'), 'offline_network');
                assert.equal(classifyViewerError(null, 'Network request timed out'), 'offline_network');
            });

            it('classifies unhandled errors as unknown', () => {
                assert.equal(classifyViewerError(400), 'unknown');
                assert.equal(classifyViewerError(null, 'Something unexpected happened'), 'unknown');
            });
        });

        describe('buildViewerHealthTelemetryPayload', () => {
            it('builds sanitized, privacy-safe telemetry payload without raw coordinates or PII', () => {
                const payload = buildViewerHealthTelemetryPayload({
                    sessionId: 'session_xyz-123!@#',
                    pollLatencyMs: 184,
                    statusCode: 200,
                    isActive: true,
                    hasLocation: true,
                    batteryLevel: 88,
                    pointCount: 12,
                    isStale: false,
                });

                assert.equal(payload.sessionId, 'session_xyz-123');
                assert.equal(payload.pollLatencyMs, 184);
                assert.equal(payload.statusCode, 200);
                assert.equal(payload.isActive, true);
                assert.equal(payload.hasLocation, true);
                assert.equal(payload.batteryLevel, 88);
                assert.equal(payload.pointCount, 12);
                assert.equal(payload.isStale, false);

                // Zero GPS coordinates or tokens in payload
                assert.equal((payload as any).lat, undefined);
                assert.equal((payload as any).lng, undefined);
                assert.equal((payload as any).token, undefined);
            });

            it('clamps battery levels and missing values gracefully', () => {
                const payload = buildViewerHealthTelemetryPayload({
                    sessionId: 'sess_1',
                    pollLatencyMs: -50,
                    statusCode: 500,
                    isActive: false,
                    hasLocation: false,
                    batteryLevel: 150,
                    pointCount: -4,
                });

                assert.equal(payload.pollLatencyMs, 0);
                assert.equal(payload.batteryLevel, null);
                assert.equal(payload.pointCount, 0);
                assert.equal(payload.isStale, false);
            });
        });
    });

    describe('Live Share Viewer Reconnection State Memory & Cache Resync (CIE-042)', () => {
        describe('shouldPreserveViewerState', () => {
            it('preserves map state when location was previously rendered even during offline dead zones', () => {
                assert.equal(shouldPreserveViewerState(true, true), true);
                assert.equal(shouldPreserveViewerState(true, false), true);
            });

            it('returns false if no location has been rendered yet', () => {
                assert.equal(shouldPreserveViewerState(false, true), false);
                assert.equal(shouldPreserveViewerState(false, false), false);
            });
        });

        describe('evaluateReconnectionResync', () => {
            it('does not trigger fetch if trip has ended', () => {
                const res = evaluateReconnectionResync({
                    isOnline: true,
                    wasOffline: true,
                    hasCachedSnapshot: true,
                    isTripEnded: true,
                });
                assert.equal(res.shouldFetchImmediately, false);
                assert.equal(res.shouldUseCachedState, true);
                assert.equal(res.resetConsecutiveErrors, false);
                assert.equal(res.statusMessage, null);
            });

            it('returns offline state when viewer disconnects', () => {
                const res = evaluateReconnectionResync({
                    isOnline: false,
                    wasOffline: false,
                    hasCachedSnapshot: true,
                    isTripEnded: false,
                });
                assert.equal(res.shouldFetchImmediately, false);
                assert.equal(res.shouldUseCachedState, true);
                assert.equal(res.resetConsecutiveErrors, false);
                assert.equal(res.statusMessage, 'Viewer Offline');
            });

            it('triggers immediate fetch and resets errors upon reconnecting after offline', () => {
                const res = evaluateReconnectionResync({
                    isOnline: true,
                    wasOffline: true,
                    hasCachedSnapshot: true,
                    isTripEnded: false,
                    isFetchInProgress: false,
                });
                assert.equal(res.shouldFetchImmediately, true);
                assert.equal(res.shouldUseCachedState, true);
                assert.equal(res.resetConsecutiveErrors, true);
                assert.equal(res.statusMessage, 'Reconnecting...');
            });

            it('suppresses immediate fetch if another fetch is already in flight during reconnection', () => {
                const res = evaluateReconnectionResync({
                    isOnline: true,
                    wasOffline: true,
                    hasCachedSnapshot: true,
                    isTripEnded: false,
                    isFetchInProgress: true,
                });
                assert.equal(res.shouldFetchImmediately, false);
                assert.equal(res.shouldUseCachedState, true);
                assert.equal(res.resetConsecutiveErrors, true);
                assert.equal(res.statusMessage, 'Reconnecting...');
            });

            it('maintains steady state when online without reconnection event', () => {
                const res = evaluateReconnectionResync({
                    isOnline: true,
                    wasOffline: false,
                    hasCachedSnapshot: true,
                    isTripEnded: false,
                });
                assert.equal(res.shouldFetchImmediately, false);
                assert.equal(res.shouldUseCachedState, true);
                assert.equal(res.resetConsecutiveErrors, false);
                assert.equal(res.statusMessage, null);
            });
        });

        describe('serializeViewerCachePayload & deserializeViewerCachePayload', () => {
            it('serializes and deserializes a valid viewer snapshot cleanly', () => {
                const snapshot = {
                    sessionId: 'session-alpha-42',
                    username: 'Priya S.',
                    status: 'active',
                    lastLocation: {
                        lat: 37.7749,
                        lng: -122.4194,
                        speed: 4.8,
                        heading: 180,
                        batteryLevel: 82,
                        timestamp: 1700000000000,
                        powerSaveMode: false,
                    },
                    path: [
                        [37.7740, -122.4190],
                        [37.7745, -122.4192],
                        [37.7749, -122.4194],
                    ],
                };

                const serialized = serializeViewerCachePayload(snapshot, 1700000005000);
                assert.ok(typeof serialized === 'string');

                const parsed = deserializeViewerCachePayload(serialized);
                assert.ok(parsed !== null);
                assert.equal(parsed?.sessionId, 'session-alpha-42');
                assert.equal(parsed?.username, 'Priya S.');
                assert.equal(parsed?.status, 'active');
                assert.equal(parsed?.lastLocation?.lat, 37.7749);
                assert.equal(parsed?.lastLocation?.lng, -122.4194);
                assert.equal(parsed?.lastLocation?.batteryLevel, 82);
                assert.equal(parsed?.path.length, 3);
                assert.equal(parsed?.cachedAtEpochMs, 1700000005000);
            });

            it('returns null on invalid input or empty session ID', () => {
                assert.equal(serializeViewerCachePayload(null), null);
                assert.equal(serializeViewerCachePayload({}), null);
                assert.equal(serializeViewerCachePayload({ sessionId: '   ' }), null);
                assert.equal(deserializeViewerCachePayload(''), null);
                assert.equal(deserializeViewerCachePayload('{ invalid json }'), null);
                assert.equal(deserializeViewerCachePayload(JSON.stringify({ notSession: 'test' })), null);
            });

            it('bounds path coordinates to maximum 500 points to preserve memory/storage', () => {
                const longPath: Array<[number, number]> = [];
                for (let i = 0; i < 600; i++) {
                    longPath.push([37.0 + (i * 0.0001), -122.0]);
                }
                const snapshot = {
                    sessionId: 'session_long_path',
                    status: 'active',
                    lastLocation: { lat: 37.06, lng: -122.0 },
                    path: longPath,
                };

                const serialized = serializeViewerCachePayload(snapshot);
                assert.ok(serialized !== null);
                const parsed = deserializeViewerCachePayload(serialized);
                assert.equal(parsed?.path.length, 500);
            });

            it('sanitizes malformed latitude, longitude, and battery values', () => {
                const snapshot = {
                    sessionId: 'session_malformed',
                    status: 'active',
                    lastLocation: {
                        lat: 1000, // Invalid latitude
                        lng: -122.0,
                        batteryLevel: 250, // Invalid battery
                    },
                    path: [
                        [999, 999], // Invalid point
                        [37.77, -122.41], // Valid point
                    ],
                };

                const serialized = serializeViewerCachePayload(snapshot);
                const parsed = deserializeViewerCachePayload(serialized);
                assert.equal(parsed?.lastLocation, null);
                assert.equal(parsed?.path.length, 1);
                assert.deepEqual(parsed?.path[0], [37.77, -122.41]);
            });
        });
    });
});


