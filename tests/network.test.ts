import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    getTileLayerConfig,
    getAvailableTileProvidersCount,
    getBatteryDisplay,
    LOW_BATTERY_THRESHOLD,
    shouldSwitchTileMirror,
    ViewerNetworkStateMachine,
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
});
