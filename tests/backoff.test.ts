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
    });
});
