/**
 * Pure backoff and rate-limiting helpers for Live Share viewers and broadcasters.
 *
 * Designed to prevent Redis command stampedes and Vercel serverless function pileups
 * during cellular dead zones, tunnel traversals, and reconnection events ($0/mo cost guardrail).
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const TrackCore = require('../../public/js/tracker-core.js');

export interface BackoffOptions {
    baseMs?: number;
    maxMs?: number;
    jitterMaxMs?: number;
}

export function computeBackoffDelay(
    consecutiveFailures: number,
    options: BackoffOptions = {},
    randomFn: () => number = Math.random
): number {
    return TrackCore.computeBackoffDelay(consecutiveFailures, options, randomFn);
}

export function shouldSkipPresencePing(consecutiveFailures: number): boolean {
    return TrackCore.shouldSkipPresencePing(consecutiveFailures);
}

