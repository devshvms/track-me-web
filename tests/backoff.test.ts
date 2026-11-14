import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeBackoffDelay, shouldSkipPresencePing } from '../lib/track/backoff';

describe('Live Share Backoff & Throttling (CIE-003)', () => {
    it('returns base interval when failure count is zero or negative', () => {
        assert.equal(computeBackoffDelay(0), 5000);
        assert.equal(computeBackoffDelay(-1), 5000);
        assert.equal(computeBackoffDelay(0, { baseMs: 3000 }), 3000);
    });

    it('scales backoff progression predictably without jitter', () => {
        const noJitter = () => 0;

        // Base 5000ms:
        // failure 1: 5000 + 1000 = 6000
        assert.equal(computeBackoffDelay(1, {}, noJitter), 6000);

        // failure 2: 5000 + 3000 = 8000
        assert.equal(computeBackoffDelay(2, {}, noJitter), 8000);

        // failure 3: 5000 + 6000 = 11000
        assert.equal(computeBackoffDelay(3, {}, noJitter), 11000);

        // failure 4: 5000 + 10000 = 15000 (clamped to maxMs)
        assert.equal(computeBackoffDelay(4, {}, noJitter), 15000);

        // failure 10: clamped to maxMs (15000)
        assert.equal(computeBackoffDelay(10, {}, noJitter), 15000);
    });

    it('respects custom base and max ceilings', () => {
        const noJitter = () => 0;
        // Base 1000, Max 8000
        assert.equal(computeBackoffDelay(0, { baseMs: 1000, maxMs: 8000 }, noJitter), 1000);
        assert.equal(computeBackoffDelay(1, { baseMs: 1000, maxMs: 8000 }, noJitter), 2000);
        assert.equal(computeBackoffDelay(2, { baseMs: 1000, maxMs: 8000 }, noJitter), 4000);
        assert.equal(computeBackoffDelay(3, { baseMs: 1000, maxMs: 8000 }, noJitter), 7000);
        assert.equal(computeBackoffDelay(4, { baseMs: 1000, maxMs: 8000 }, noJitter), 8000);
    });

    it('injects bounded pseudo-random jitter', () => {
        const halfJitter = () => 0.5;
        // JitterMax = 500 -> 0.5 * 500 = 250
        const delay1 = computeBackoffDelay(1, { jitterMaxMs: 500 }, halfJitter);
        assert.equal(delay1, 6250);

        // Jitter should never push delay past maxMs
        const fullJitter = () => 0.9999;
        const delay4 = computeBackoffDelay(4, { maxMs: 15000, jitterMaxMs: 500 }, fullJitter);
        assert.equal(delay4, 15000);
    });

    it('skips presence ping only when consecutive failures >= 2', () => {
        assert.equal(shouldSkipPresencePing(0), false);
        assert.equal(shouldSkipPresencePing(1), false);
        assert.equal(shouldSkipPresencePing(2), true);
        assert.equal(shouldSkipPresencePing(5), true);
        assert.equal(shouldSkipPresencePing(0, false), true);
        assert.equal(shouldSkipPresencePing(1, true), false);
    });

    it('computes viewer ping delay with low-data/idle/background throttling and backoff (CIE-046)', () => {
        const {
            computeViewerPingDelay,
            VIEWER_PING_BASE_MS,
            VIEWER_PING_THROTTLED_MS,
            VIEWER_PING_MAX_BACKOFF_MS,
        } = require('../lib/track/backoff');
        const noJitter = () => 0;
        const fullJitter = () => 0.9999;

        assert.equal(VIEWER_PING_BASE_MS, 15000);
        assert.equal(VIEWER_PING_THROTTLED_MS, 30000);
        assert.equal(VIEWER_PING_MAX_BACKOFF_MS, 60000);

        // Healthy online normal active viewer -> 15s (well under 40s stale TTL)
        assert.equal(computeViewerPingDelay(0, {}, noJitter), 15000);

        // Healthy throttled viewer (low-data, background, or idle) -> 30s (still < 40s server TTL!)
        assert.equal(computeViewerPingDelay(0, { isLowDataMode: true }, noJitter), 30000);
        assert.equal(computeViewerPingDelay(0, { isBackground: true }, noJitter), 30000);
        assert.equal(computeViewerPingDelay(0, { isViewerIdle: true }, noJitter), 30000);

        // Exponential ping backoff on failures, normal cadence: 20s -> 30s -> 45s -> 60s
        assert.equal(computeViewerPingDelay(1, {}, noJitter), 20000);
        assert.equal(computeViewerPingDelay(2, {}, noJitter), 30000);
        assert.equal(computeViewerPingDelay(3, {}, noJitter), 45000);
        assert.equal(computeViewerPingDelay(4, {}, noJitter), 60000);
        assert.equal(computeViewerPingDelay(8, {}, noJitter), 60000);

        // Backoff while throttled: 35s -> 45s -> 60s
        assert.equal(computeViewerPingDelay(1, { isLowDataMode: true }, noJitter), 35000);
        assert.equal(computeViewerPingDelay(2, { isLowDataMode: true }, noJitter), 45000);
        assert.equal(computeViewerPingDelay(3, { isLowDataMode: true }, noJitter), 60000);

        // Jitter bounded and clamped at ceiling
        assert.equal(computeViewerPingDelay(1, {}, fullJitter), 20999);
        assert.equal(computeViewerPingDelay(4, {}, fullJitter), 60000);
    });

    it('evaluates zero-viewer broadcaster hibernation and builds sanitized telemetry (CIE-046)', () => {
        const {
            evaluateZeroViewerHibernation,
            buildZeroViewerHibernationTelemetryPayload,
            ZERO_VIEWER_HIBERNATION_THRESHOLD_MS,
            ZERO_VIEWER_HIBERNATION_INTERVAL_MS,
        } = require('../lib/track/backoff');

        assert.equal(ZERO_VIEWER_HIBERNATION_THRESHOLD_MS, 600000);
        assert.equal(ZERO_VIEWER_HIBERNATION_INTERVAL_MS, 30000);

        const t0 = 1700000000000;
        // Before 10m threshold with 0 viewers -> stays at normal cadence
        const beforeThreshold = evaluateZeroViewerHibernation({
            activeViewers: 0,
            zeroViewersSinceEpochMs: t0,
            nowEpochMs: t0 + 599999,
            configuredIntervalMs: 5000,
            isPowerSaveOrLowBattery: false,
        });
        assert.equal(beforeThreshold.isHibernating, false);
        assert.equal(beforeThreshold.zeroViewersSinceEpochMs, t0);
        assert.equal(beforeThreshold.effectiveIntervalMs, 5000);

        // At >= 10m with 0 viewers -> hibernates to 30s
        const hibernating = evaluateZeroViewerHibernation({
            activeViewers: 0,
            zeroViewersSinceEpochMs: t0,
            nowEpochMs: t0 + 600000,
            configuredIntervalMs: 5000,
            isPowerSaveOrLowBattery: false,
        });
        assert.equal(hibernating.isHibernating, true);
        assert.equal(hibernating.idleDurationMs, 600000);
        assert.equal(hibernating.effectiveIntervalMs, 30000);

        // Respects longer user-configured interval > 30s
        const longConfigured = evaluateZeroViewerHibernation({
            activeViewers: 0,
            zeroViewersSinceEpochMs: t0,
            nowEpochMs: t0 + 700000,
            configuredIntervalMs: 60000,
            isPowerSaveOrLowBattery: false,
        });
        assert.equal(longConfigured.isHibernating, true);
        assert.equal(longConfigured.effectiveIntervalMs, 60000);

        // Immediately wakes up as soon as a viewer connects
        const woken = evaluateZeroViewerHibernation({
            activeViewers: 1,
            zeroViewersSinceEpochMs: t0,
            nowEpochMs: t0 + 700000,
            configuredIntervalMs: 5000,
            isPowerSaveOrLowBattery: false,
        });
        assert.equal(woken.isHibernating, false);
        assert.equal(woken.zeroViewersSinceEpochMs, null);
        assert.equal(woken.effectiveIntervalMs, 5000);

        // Sanitized telemetry excludes coordinates, tokens, and PII
        const payload = buildZeroViewerHibernationTelemetryPayload('sess-123', true, 600000, 30000, 'web');
        assert.equal(payload.session_id, 'sess-123');
        assert.equal(payload.is_hibernating, true);
        assert.equal(payload.idle_seconds, 600);
        assert.equal(payload.interval_seconds, 30);
        assert.equal(payload.platform, 'web');
        assert.equal('lat' in payload, false);
        assert.equal('lng' in payload, false);
        assert.equal('token' in payload, false);
        assert.equal('email' in payload, false);
    });
});
