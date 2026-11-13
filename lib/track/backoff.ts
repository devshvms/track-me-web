/**
 * Pure backoff and rate-limiting helpers for Live Share viewers and broadcasters.
 *
 * Designed to prevent Redis command stampedes and Vercel serverless function pileups
 * during cellular dead zones, tunnel traversals, and reconnection events ($0/mo cost guardrail).
 */

export interface BackoffOptions {
    baseMs?: number;
    maxMs?: number;
    jitterMaxMs?: number;
}

/**
 * Computes an adaptive, jittered exponential backoff delay for polling or retrying.
 *
 * Progression (with baseMs = 5000, maxMs = 15000):
 * - 0 failures: 5000 ms (normal interval)
 * - 1 failure:  5000 + 1000 + jitter (~6000-6500 ms)
 * - 2 failures: 5000 + 3000 + jitter (~8000-8500 ms)
 * - 3 failures: 5000 + 6000 + jitter (~11000-11500 ms)
 * - 4+ failures: 15000 ms (clamped to maxMs)
 *
 * @param consecutiveFailures Count of consecutive network or HTTP errors
 * @param options Base delay, maximum delay ceiling, and optional jitter
 * @param randomFn Optional deterministic random provider for testing
 */
export function computeBackoffDelay(
    consecutiveFailures: number,
    options: BackoffOptions = {},
    randomFn: () => number = Math.random
): number {
    const baseMs = Math.max(1000, options.baseMs ?? 5000);
    const maxMs = Math.max(baseMs, options.maxMs ?? 15000);
    const jitterMaxMs = Math.max(0, options.jitterMaxMs ?? 500);

    if (consecutiveFailures <= 0) {
        return baseMs;
    }

    // Step increments added to base interval: +1s, +3s, +6s, +10s
    const increments = [1000, 3000, 6000, 10000];
    const stepIndex = Math.min(consecutiveFailures - 1, increments.length - 1);
    const stepIncrement = increments[stepIndex];

    const jitter = jitterMaxMs > 0 ? Math.floor(randomFn() * jitterMaxMs) : 0;
    const computed = baseMs + stepIncrement + jitter;

    return Math.min(maxMs, computed);
}

/**
 * Evaluates whether a secondary heartbeat (like viewer presence ping) should be suppressed
 * when the primary telemetry stream is experiencing consecutive connectivity failures.
 *
 * Suppressing heartbeats during outages prevents useless Redis write commands.
 */
export function shouldSkipPresencePing(consecutiveFailures: number): boolean {
    return consecutiveFailures >= 2;
}
