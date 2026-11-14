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

export const VIEWER_PING_BASE_MS: number = TrackCore.VIEWER_PING_BASE_MS;
export const VIEWER_PING_THROTTLED_MS: number = TrackCore.VIEWER_PING_THROTTLED_MS;
export const VIEWER_PING_MAX_BACKOFF_MS: number = TrackCore.VIEWER_PING_MAX_BACKOFF_MS;
export const ZERO_VIEWER_HIBERNATION_THRESHOLD_MS: number = TrackCore.ZERO_VIEWER_HIBERNATION_THRESHOLD_MS;
export const ZERO_VIEWER_HIBERNATION_INTERVAL_MS: number = TrackCore.ZERO_VIEWER_HIBERNATION_INTERVAL_MS;

export interface ViewerPingDelayOptions extends BackoffOptions {
    throttledMs?: number;
    isLowDataMode?: boolean;
    isBackground?: boolean;
    isViewerIdle?: boolean;
}

export interface ZeroViewerHibernationParams {
    activeViewers: number;
    zeroViewersSinceEpochMs: number | null;
    nowEpochMs: number;
    configuredIntervalMs?: number;
    isPowerSaveOrLowBattery?: boolean;
    thresholdMs?: number;
    hibernationIntervalMs?: number;
}

export interface ZeroViewerHibernationEvaluation {
    isHibernating: boolean;
    zeroViewersSinceEpochMs: number | null;
    idleDurationMs: number;
    effectiveIntervalMs: number;
}

export function shouldSkipPresencePing(consecutiveFailures: number, isOnline: boolean = true): boolean {
    return TrackCore.shouldSkipPresencePing(consecutiveFailures, isOnline);
}

export function computeViewerPingDelay(
    consecutivePingFailures: number,
    options: ViewerPingDelayOptions = {},
    randomFn: () => number = Math.random
): number {
    return TrackCore.computeViewerPingDelay(consecutivePingFailures, options, randomFn);
}

export function evaluateZeroViewerHibernation(
    params: ZeroViewerHibernationParams
): ZeroViewerHibernationEvaluation {
    return TrackCore.evaluateZeroViewerHibernation(params);
}

export function buildZeroViewerHibernationTelemetryPayload(
    sessionId: string,
    isHibernating: boolean,
    idleDurationMs: number,
    intervalMs: number,
    platform: string = 'web'
): Record<string, string | number | boolean> {
    return TrackCore.buildZeroViewerHibernationTelemetryPayload(
        sessionId,
        isHibernating,
        idleDurationMs,
        intervalMs,
        platform
    );
}

