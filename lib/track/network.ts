/**
 * Live Viewer Network Resilience and Tile Mirror Fallback Helpers.
 *
 * Provides pure, deterministic helpers for:
 * 1. OpenStreetMap tile layer configuration with automatic fallback mirrors when primary tile CDN glitches.
 * 2. Battery telemetry formatting with low-battery (<15%) alert states for watchers.
 * 3. Online/offline connection state machine for responsive reconnection and error clearing.
 *
 * Enterprise standards: strictly typed, zero external dependencies, 100% testable in Node.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const TrackCore = require('../../public/js/tracker-core.js');

export interface TileLayerConfig {
    readonly url: string;
    readonly subdomains: string[];
    readonly maxZoom: number;
    readonly attribution: string;
    readonly isFallback: boolean;
    readonly name: string;
}

export interface BatteryDisplay {
    readonly text: string;
    readonly isLow: boolean;
    readonly icon: string;
    readonly fullLabel: string;
}

/**
 * Ordered list of reliable, free OpenStreetMap tile provider mirrors.
 */
const TILE_PROVIDERS: readonly TileLayerConfig[] = [
    {
        name: 'OpenStreetMap Primary',
        url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        subdomains: ['a', 'b', 'c'],
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        isFallback: false,
    },
    {
        name: 'OSM France Humanitarian',
        url: 'https://tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
        subdomains: [],
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors, Tiles style by Humanitarian OpenStreetMap Team hosted by OSM France',
        isFallback: true,
    },
    {
        name: 'CartoDB Voyager',
        url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
        subdomains: ['a', 'b', 'c', 'd'],
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        isFallback: true,
    },
];

/**
 * Retrieves tile layer configuration based on fallback attempt index.
 * Clamps to the highest fallback tier if attempt exceeds available providers.
 *
 * @param attempt 0-based fallback attempt (0 = primary OSM, 1+ = fallbacks)
 */
export function getTileLayerConfig(attempt: number): TileLayerConfig {
    const safeIndex = Math.max(0, Math.min(attempt, TILE_PROVIDERS.length - 1));
    return TILE_PROVIDERS[safeIndex];
}

/**
 * Total count of registered tile providers.
 */
export function getAvailableTileProvidersCount(): number {
    return TILE_PROVIDERS.length;
}

/**
 * Low battery threshold percentage (below or equal to 15% is considered low).
 */
export const LOW_BATTERY_THRESHOLD = 15;

/**
 * Formats battery percentage with visual alert icons for live viewers.
 *
 * Watchers need immediate awareness when a rider's phone is dying, especially
 * on night rides or unfamiliar routes.
 *
 * @param batteryLevel Raw battery level (0-100) from telemetry, or null/undefined
 */
export function getBatteryDisplay(batteryLevel: number | null | undefined): BatteryDisplay {
    if (typeof batteryLevel !== 'number' || !Number.isFinite(batteryLevel) || batteryLevel < 0 || batteryLevel > 100) {
        return {
            text: 'N/A',
            isLow: false,
            icon: '',
            fullLabel: 'N/A',
        };
    }

    const rounded = Math.round(batteryLevel);
    const isLow = rounded <= LOW_BATTERY_THRESHOLD;
    const icon = isLow ? '🪫' : '🔋';
    const text = `${rounded}%`;
    const fullLabel = isLow ? `${icon} ${text} (Low Battery)` : `${icon} ${text}`;

    return {
        text,
        isLow,
        icon,
        fullLabel,
    };
}

/**
 * Evaluates whether the low-battery warning banner should be displayed to live viewers.
 *
 * Rules:
 * 1. Session must NOT be stopped (active live tracking).
 * 2. Battery level must be a valid, finite number between 0 and 100.
 * 3. Rounded battery level must be <= LOW_BATTERY_THRESHOLD (15%).
 *
 * @param batteryLevel Raw battery level (0-100) or null/undefined
 * @param isStopped Whether the live sharing session has ended
 */
export function shouldShowLowBatteryBanner(batteryLevel: number | null | undefined, isStopped: boolean): boolean {
    if (isStopped) return false;
    if (typeof batteryLevel !== 'number' || !Number.isFinite(batteryLevel) || batteryLevel < 0 || batteryLevel > 100) {
        return false;
    }
    return Math.round(batteryLevel) <= LOW_BATTERY_THRESHOLD;
}

/**
 * Formats user-facing text for the prominent low-battery warning banner.
 *
 * Returns null if battery is not in low state.
 *
 * @param batteryLevel Raw battery level (0-100) or null/undefined
 */
export function formatLowBatteryBannerText(batteryLevel: number | null | undefined): string | null {
    if (typeof batteryLevel !== 'number' || !Number.isFinite(batteryLevel) || batteryLevel < 0 || batteryLevel > 100) {
        return null;
    }
    const rounded = Math.round(batteryLevel);
    if (rounded > LOW_BATTERY_THRESHOLD) {
        return null;
    }
    return `🪫 Rider battery low (${rounded}%) · Signal may pause if phone powers off`;
}

/**
 * Determines whether low battery telemetry should be emitted, deduplicating identical levels.
 *
 * Emits when:
 * 1. Current level is valid, <= LOW_BATTERY_THRESHOLD (15%).
 * 2. Current rounded level is different from the last emitted level.
 *
 * @param lastEmittedLevel Previously emitted low battery level (or null if none emitted yet)
 * @param currentLevel Current battery level from telemetry
 */
export function shouldEmitLowBatteryTelemetry(
    lastEmittedLevel: number | null,
    currentLevel: number | null | undefined
): boolean {
    if (typeof currentLevel !== 'number' || !Number.isFinite(currentLevel) || currentLevel < 0 || currentLevel > 100) {
        return false;
    }
    const rounded = Math.round(currentLevel);
    if (rounded > LOW_BATTERY_THRESHOLD) {
        return false;
    }
    return lastEmittedLevel !== rounded;
}

/**
 * Evaluates whether tile errors have crossed the tolerance threshold to trigger a mirror switch.
 *
 * @param consecutiveTileErrors Count of failed tile fetches
 * @param threshold Threshold before switching to fallback (default: 3)
 */
export function shouldSwitchTileMirror(consecutiveTileErrors: number, threshold: number = 3): boolean {
    return consecutiveTileErrors >= threshold;
}

/**
 * Pure state machine representing the viewer's network connectivity.
 */
export class ViewerNetworkStateMachine {
    private _isOnline: boolean;
    private _wasOffline: boolean = false;
    private _offlineCount: number = 0;

    constructor(initialOnline: boolean = true) {
        this._isOnline = initialOnline;
    }

    get isOnline(): boolean {
        return this._isOnline;
    }

    get wasOffline(): boolean {
        return this._wasOffline;
    }

    get offlineCount(): number {
        return this._offlineCount;
    }

    /**
     * Marks the client as offline. Returns true if this was a state transition.
     */
    setOffline(): boolean {
        if (!this._isOnline) return false;
        this._isOnline = false;
        this._wasOffline = true;
        this._offlineCount++;
        return true;
    }

    /**
     * Marks the client as online. Returns true if transitioning from offline to online.
     */
    setOnline(): boolean {
        if (this._isOnline) return false;
        this._isOnline = true;
        return true;
    }

    /**
     * Resets the reconnection flag once re-fetch has been initiated.
     */
    consumeReconnection(): boolean {
        if (!this._wasOffline) return false;
        this._wasOffline = false;
        return true;
    }
}

/**
 * Stale signal threshold in seconds.
 * If 180 seconds (3 minutes) have passed without a fresh coordinate update from an active trip,
 * the viewer considers the signal paused (e.g., rider in a dead zone, tunnel, or app suspended).
 */
export const STALE_SIGNAL_THRESHOLD_SECONDS = 180;

/**
 * Checks whether an active location timestamp has gone stale (>= 180s without updates).
 *
 * @param timestampIso ISO timestamp string or epoch ms number
 * @param nowMs Current timestamp in epoch ms (defaults to Date.now())
 * @param thresholdSeconds Stale threshold in seconds (defaults to 180s)
 */
export function isSignalStale(
    timestampIso: string | number | null | undefined,
    nowMs: number = Date.now(),
    thresholdSeconds: number = STALE_SIGNAL_THRESHOLD_SECONDS
): boolean {
    if (!timestampIso) return false;
    let parsedMs: number;
    if (typeof timestampIso === 'number') {
        parsedMs = timestampIso;
    } else {
        const num = Number(timestampIso);
        if (!isNaN(num) && num > 0) {
            parsedMs = num;
        } else {
            parsedMs = new Date(timestampIso).getTime();
        }
    }
    if (isNaN(parsedMs) || parsedMs <= 0) return false;

    const diffSeconds = Math.max(0, (nowMs - parsedMs) / 1000);
    return diffSeconds >= thresholdSeconds;
}

/**
 * Formats user-facing stale signal banner text including elapsed minutes.
 *
 * @param elapsedSeconds Seconds elapsed since last coordinate
 */
export function formatStaleSignalText(elapsedSeconds: number): string {
    const safeSec = Math.max(0, Math.floor(elapsedSeconds));
    if (safeSec < 60) {
        return 'Signal paused · Waiting for rider GPS';
    }
    const mins = Math.floor(safeSec / 60);
    return `Signal paused · Waiting for rider GPS (${mins}m ago)`;
}

/**
 * Evaluates whether the connection retry button should be visible.
 * Visible if the client is currently offline or has encountered 1 or more consecutive fetch errors.
 *
 * @param consecutiveFetchErrors Number of consecutive fetch failures
 * @param isOnline Whether the browser reports online connectivity
 */
export function shouldShowConnectionRetry(consecutiveFetchErrors: number, isOnline: boolean = true): boolean {
    return !isOnline || consecutiveFetchErrors >= 1;
}

/**
 * Constructs Google Maps and Apple Maps navigation links for a given coordinate.
 */
export function buildMapsUrls(lat: number, lon: number): { googleMapsUrl: string; appleMapsUrl: string } {
    const safeLat = Number(lat) || 0;
    const safeLon = Number(lon) || 0;
    return {
        googleMapsUrl: `https://maps.google.com/?q=${safeLat},${safeLon}`,
        appleMapsUrl: `https://maps.apple.com/?q=${safeLat},${safeLon}`,
    };
}

/**
 * Constructs direct navigation URL to destination/rider coordinate.
 * Clamps and validates latitude (-90..90) and longitude (-180..180).
 */
export function buildDirectionsUrl(
    lat: number,
    lon: number,
    provider: 'google_maps' | 'apple_maps' = 'google_maps'
): string | null {
    const safeLat = Number(lat);
    const safeLon = Number(lon);
    if (!Number.isFinite(safeLat) || !Number.isFinite(safeLon)) return null;
    if (safeLat < -90 || safeLat > 90 || safeLon < -180 || safeLon > 180) return null;

    if (provider === 'apple_maps') {
        return `https://maps.apple.com/?daddr=${safeLat},${safeLon}`;
    }
    return `https://maps.google.com/?daddr=${safeLat},${safeLon}`;
}

/**
 * Formats a clean, standard live share message text matching iOS & Android formats.
 *
 * @param username Optional username of the rider
 * @param liveUrl Full web URL of the live tracking session
 */
export function formatLiveShareText(username: string | null | undefined, liveUrl: string): string {
    const cleanName = username?.trim();
    if (cleanName) {
        return `Track ${cleanName}'s live ride on TrackMe: ${liveUrl}`;
    }
    return `Track my live ride on TrackMe: ${liveUrl}`;
}

/**
 * Formats location action text including live link, last seen time, and maps navigation links.
 */
export function formatLocationShareText(
    username: string | null | undefined,
    liveUrl: string,
    lat: number,
    lon: number,
    timestampMs?: number
): string {
    const { googleMapsUrl, appleMapsUrl } = buildMapsUrls(lat, lon);
    const timeStr = timestampMs && timestampMs > 0
        ? new Date(timestampMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : null;

    const lines = [
        formatLiveShareText(username, liveUrl),
    ];
    if (timeStr) {
        lines.push(`Last seen at ${timeStr}`);
    }
    lines.push(`Google Maps: ${googleMapsUrl}`);
    lines.push(`Apple Maps: ${appleMapsUrl}`);

    return lines.join('\n');
}

export interface ForegroundReconnectionTransition {
    readonly shouldFetchImmediately: boolean;
    readonly resetConsecutiveErrors: boolean;
    readonly newStatusText: string | null;
    readonly newStatusClass: string | null;
}

/**
 * Evaluates foreground return transition state for active live session viewers (CIE-027).
 *
 * Rules:
 * 1. If trip has already ended, no foreground polling is triggered.
 * 2. If trip is active:
 *    - Backoff failure count resets so the fresh attempt happens immediately.
 *    - If device/browser is online, triggers an immediate poll.
 *    - If previously in an error or offline status, transitions to 'Reconnecting...'.
 *
 * @param isTripEnded Whether the session is stopped/ended
 * @param isOnline Whether current network is reachable
 * @param currentStatusText Current displayed status text (e.g. 'Viewer Offline', 'Connection Error', 'Connecting...')
 */
export function evaluateForegroundReconnection(
    isTripEnded: boolean,
    isOnline: boolean = true,
    currentStatusText: string = ''
): ForegroundReconnectionTransition {
    if (isTripEnded) {
        return {
            shouldFetchImmediately: false,
            resetConsecutiveErrors: false,
            newStatusText: null,
            newStatusClass: null,
        };
    }

    const isErrorOrOffline =
        currentStatusText.includes('Offline') ||
        currentStatusText.includes('Error') ||
        currentStatusText.includes('Connecting');

    const newStatusText = isOnline && isErrorOrOffline ? 'Reconnecting...' : null;
    const newStatusClass = newStatusText ? 'status delayed' : null;

    return {
        shouldFetchImmediately: isOnline,
        resetConsecutiveErrors: true,
        newStatusText,
        newStatusClass,
    };
}

export const NETWORK_OFFLINE_TOAST_MESSAGE = 'Network offline · Retrying automatically';
export const NETWORK_RECONNECTED_TOAST_MESSAGE = 'Reconnected · Updating…';

export interface NetworkToastState {
    readonly isVisible: boolean;
    readonly message: string;
    readonly icon: string;
    readonly type: 'offline' | 'reconnected';
    readonly isPersistent: boolean;
    readonly autoDismissDelayMs?: number;
}

/**
 * Evaluates the non-blocking network reconnection toast state (CIE-034).
 *
 * Rules:
 * 1. If trip has ended, return null (no transient network alerts needed on completed rides).
 * 2. When offline: display persistent offline toast pill with retry indication.
 * 3. When transitioning from offline back to online (wasOffline=true):
 *    display transient green reconnected toast pill with auto-dismissal (2500ms).
 * 4. When steadily online: return null (clean UI).
 *
 * @param isOnline Whether current device/browser connection is reachable
 * @param wasOffline Whether the client recently experienced an offline state
 * @param isTripEnded Whether the session is stopped/ended
 */
export function evaluateNetworkToastState(
    isOnline: boolean,
    wasOffline: boolean,
    isTripEnded: boolean
): NetworkToastState | null {
    if (isTripEnded) return null;

    if (!isOnline) {
        return {
            isVisible: true,
            message: NETWORK_OFFLINE_TOAST_MESSAGE,
            icon: '⚡',
            type: 'offline',
            isPersistent: true,
        };
    }

    if (wasOffline) {
        return {
            isVisible: true,
            message: NETWORK_RECONNECTED_TOAST_MESSAGE,
            icon: '✓',
            type: 'reconnected',
            isPersistent: false,
            autoDismissDelayMs: 2500,
        };
    }

    return null;
}

export interface NetworkTransitionEvaluation {
    readonly shouldTriggerImmediateFetch: boolean;
    readonly resetConsecutiveErrors: boolean;
    readonly toast: NetworkToastState | null;
}

/**
 * Evaluates state transition upon network status change (CIE-034).
 *
 * @param isOnline Current network online status
 * @param wasOffline Whether previously offline
 * @param isTripEnded Whether session has concluded
 * @param isFetchInProgress Whether a location fetch is currently in flight
 */
export function evaluateNetworkTransition(
    isOnline: boolean,
    wasOffline: boolean,
    isTripEnded: boolean,
    isFetchInProgress: boolean = false
): NetworkTransitionEvaluation {
    if (isTripEnded) {
        return {
            shouldTriggerImmediateFetch: false,
            resetConsecutiveErrors: false,
            toast: null,
        };
    }

    const toast = evaluateNetworkToastState(isOnline, wasOffline, isTripEnded);
    const isReconnecting = isOnline && wasOffline;

    return {
        shouldTriggerImmediateFetch: isReconnecting && !isFetchInProgress,
        resetConsecutiveErrors: isReconnecting,
        toast,
    };
}

/**
 * CIE-035: Live Share Viewer State Preservation across Device Orientation & Theme Changes.
 */
export interface ViewportPreservationState {
    readonly isFollowingRider: boolean;
    readonly targetCenter: [number, number];
    readonly targetZoom: number;
    readonly shouldPanToRider: boolean;
    readonly preservedUnitSystem: 'metric' | 'imperial';
}

/**
 * Evaluates map viewport preservation across orientation changes or window resizes.
 *
 * Rules:
 * 1. If following rider and rider location is known, maintain rider centered.
 * 2. If user panned/zoomed away (isFollowingRider = false), preserve custom center and zoom.
 * 3. Never reset zoom or pan unexpectedly on orientation change.
 */
export function evaluateViewportPreservation(
    isFollowingRider: boolean,
    lastRiderPos: [number, number] | null,
    currentCenter: [number, number],
    currentZoom: number,
    preferredUnits: 'metric' | 'imperial' = 'metric'
): ViewportPreservationState {
    if (isFollowingRider && lastRiderPos) {
        return {
            isFollowingRider: true,
            targetCenter: lastRiderPos,
            targetZoom: Math.max(currentZoom, 15),
            shouldPanToRider: true,
            preservedUnitSystem: preferredUnits,
        };
    }

    return {
        isFollowingRider: false,
        targetCenter: currentCenter,
        targetZoom: currentZoom,
        shouldPanToRider: false,
        preservedUnitSystem: preferredUnits,
    };
}

/**
 * CIE-036: Reduced Motion & Screen Reader Accessibility Evaluation.
 */
export function shouldAnimateViewerTransition(prefersReducedMotion: boolean): boolean {
    return !prefersReducedMotion;
}

export type A11yViewerEvent = 'offline' | 'reconnected' | 'stale' | 'ended' | 'low_battery';

export function formatA11yLiveAnnouncement(
    event: A11yViewerEvent,
    riderName?: string | null,
    batteryLevel?: number | null
): string {
    const name = riderName?.trim() || 'Rider';
    switch (event) {
        case 'offline':
            return 'Network offline · Retrying automatically';
        case 'reconnected':
            return 'Network reconnected · Updating location';
        case 'stale':
            return 'Signal paused · Waiting for rider GPS';
        case 'ended':
            return `${name} has ended this live trip`;
        case 'low_battery':
            return typeof batteryLevel === 'number' && Number.isFinite(batteryLevel)
                ? `Rider phone battery low: ${Math.round(batteryLevel)}%`
                : 'Rider phone battery low';
    }
}

/**
 * CIE-037: Sanitize and clamp battery level to 0-100%, rejecting negative simulator fallbacks (-1) and non-finite values.
 */
export function clampBatteryLevel(batteryLevel: unknown): number | null {
    return TrackCore.clampBatteryLevel(batteryLevel);
}

export function shouldAnnounceLowBattery(
    previousBattery: number | null,
    newBattery: number | null
): boolean {
    return TrackCore.shouldAnnounceLowBattery(previousBattery, newBattery);
}

export function computeViewerAdaptivePollMs(
    isPowerSaveMode: boolean,
    batteryLevel: number | null,
    basePollMs: number = 5000
): number {
    return TrackCore.computeViewerAdaptivePollMs(isPowerSaveMode, batteryLevel, basePollMs);
}

export function formatPowerSaveCadenceNotice(
    isPowerSaveMode: boolean,
    batteryLevel: number | null
): string | null {
    return TrackCore.formatPowerSaveCadenceNotice(isPowerSaveMode, batteryLevel);
}

/**
 * CIE-038: Evaluates whether a polyline should be decimated based on point count.
 * For short trips (<= minPointsThreshold, default 200), points are preserved without decimation.
 */
export function shouldDecimatePolyline(pointCount: number, minPointsThreshold: number = 200): boolean {
    return pointCount > minPointsThreshold;
}

export function computePerpendicularDistanceMeters(
    p: [number, number],
    a: [number, number],
    b: [number, number]
): number {
    return TrackCore.computePerpendicularDistanceMeters(p, a, b);
}

export function decimatePolyline(
    points: Array<[number, number]>,
    epsilonMeters: number = 3.5,
    minPointsThreshold: number = 200
): Array<[number, number]> {
    return TrackCore.decimatePolyline(points, epsilonMeters, minPointsThreshold);
}

/**
 * CIE-039: Calculates total elapsed duration in seconds between two ISO timestamps or millisecond epochs.
 * Returns null if start timestamp is missing, invalid, or in the future relative to end.
 */
export function computeElapsedSeconds(
    startedAt: number | string | null | undefined,
    endedAt?: number | string | null | undefined
): number | null {
    if (!startedAt) return null;
    const startMs = typeof startedAt === 'number' ? startedAt : new Date(startedAt).getTime();
    if (!Number.isFinite(startMs) || startMs <= 0) return null;

    const endMs = endedAt
        ? (typeof endedAt === 'number' ? endedAt : new Date(endedAt).getTime())
        : Date.now();
    if (!Number.isFinite(endMs)) return null;

    const diffSeconds = Math.floor((endMs - startMs) / 1000);
    return diffSeconds >= 0 ? diffSeconds : null;
}

/**
 * CIE-039: Calculates average speed in km/h or mph for a completed or active trip.
 * Rejects negative distances, non-finite inputs, short durations (< 5 seconds),
 * and supersonic single-hop glitches (> 200 km/h).
 */
export function computeAverageSpeed(
    distanceMeters: number | null | undefined,
    durationSeconds: number | null | undefined,
    useMiles: boolean = false
): number | null {
    return TrackCore.computeAverageSpeed(distanceMeters, durationSeconds, useMiles);
}

export function formatAverageSpeed(
    averageSpeed: number | null | undefined,
    useMiles: boolean = false
): string | null {
    return TrackCore.formatAverageSpeed(averageSpeed, useMiles);
}

export interface ConcludedSummary {
    statusText: string;
    detailsText: string;
    a11yText: string;
    avgSpeedStr: string | null;
    durationStr: string;
    distanceStr: string;
}

/**
 * CIE-039: Constructs a unified summary display and screen-reader accessibility description
 * for a concluded live share session.
 */
export function formatConcludedSummary(
    stopReason: string | null | undefined,
    totalDistanceMeters: number,
    durationSeconds: number,
    useMiles: boolean = false
): ConcludedSummary {
    const cleanStop = stopReason?.trim() || 'The rider has ended this live trip.';
    const safeDurationSec = Math.max(0, Number.isFinite(durationSeconds) ? durationSeconds : 0);
    const durationMinutes = Math.floor(safeDurationSec / 60);
    const hours = Math.floor(durationMinutes / 60);
    const minutes = durationMinutes % 60;
    const durationStr = durationMinutes < 1 ? '< 1m' : (hours === 0 ? `${minutes}m` : (minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`));

    const distanceUnit = useMiles ? 'mi' : 'km';
    const distanceVal = useMiles ? totalDistanceMeters / 1609.344 : totalDistanceMeters / 1000.0;
    const distanceStr = totalDistanceMeters <= 0 ? (useMiles ? '0.0 mi' : '0.0 km') : `${distanceVal.toFixed(1)} ${distanceUnit}`;

    const avgSpeed = computeAverageSpeed(totalDistanceMeters, safeDurationSec, useMiles);
    const avgSpeedStr = formatAverageSpeed(avgSpeed, useMiles);

    const parts = [cleanStop];
    if (durationStr) parts.push(`Duration: ${durationStr}`);
    if (distanceStr) parts.push(`Distance: ${distanceStr}`);
    if (avgSpeedStr) parts.push(`Avg Speed: ${avgSpeedStr}`);

    const detailsText = parts.join(' · ');
    const a11yText = `Trip ended. ${cleanStop}. Total distance ${distanceStr}. Duration ${durationStr}.${avgSpeedStr ? ` Average speed ${avgSpeedStr}.` : ''}`;

    return {
        statusText: 'Trip Completed',
        detailsText,
        a11yText,
        avgSpeedStr,
        durationStr,
        distanceStr,
    };
}

/**
 * CIE-040: Computes geodesic distance in meters between viewport center and rider position using Haversine formula.
 * Returns 0 if any coordinate is missing or non-finite.
 */
export function computeOffCenterDistanceMeters(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number
): number {
    return TrackCore.computeOffCenterDistanceMeters(lat1, lon1, lat2, lon2);
}

export function formatOffCenterDistance(
    distanceMeters: number | null | undefined,
    useMiles: boolean = false,
    thresholdMeters: number = 250
): string | null {
    return TrackCore.formatOffCenterDistance(distanceMeters, useMiles, thresholdMeters);
}

export function formatRecenterButtonLabel(
    distanceMeters: number | null | undefined,
    useMiles: boolean = false,
    thresholdMeters: number = 250,
    baseLabel: string = 'Recenter'
): string {
    return TrackCore.formatRecenterButtonLabel(distanceMeters, useMiles, thresholdMeters, baseLabel);
}

export function formatRecenterAccessibilityLabel(
    distanceMeters: number | null | undefined,
    useMiles: boolean = false,
    thresholdMeters: number = 250,
    baseLabel: string = 'Recenter on rider'
): string {
    return TrackCore.formatRecenterAccessibilityLabel(distanceMeters, useMiles, thresholdMeters, baseLabel);
}

export function shouldResumeFollowMode(
    isFollowing: boolean,
    isEnded: boolean,
    lastInteractionEpochMs: number | null | undefined,
    nowEpochMs: number = Date.now(),
    timeoutMs: number = 20000
): boolean {
    return TrackCore.shouldResumeFollowMode(isFollowing, isEnded, lastInteractionEpochMs, nowEpochMs, timeoutMs);
}

/**
 * CIE-041: Live Share Viewer Session Health Telemetry & Diagnostics Parity.
 */
export type ViewerErrorCode =
    | 'not_found_or_expired'
    | 'rate_limited'
    | 'offline_network'
    | 'server_error'
    | 'malformed_response'
    | 'unknown';

export interface ViewerHealthTelemetryPayload {
    readonly sessionId: string;
    readonly pollLatencyMs: number;
    readonly statusCode: number;
    readonly isActive: boolean;
    readonly hasLocation: boolean;
    readonly batteryLevel: number | null;
    readonly pointCount: number;
    readonly isStale: boolean;
}

export function computePollLatencyMs(startTimeMs: number, endTimeMs: number): number {
    if (!Number.isFinite(startTimeMs) || !Number.isFinite(endTimeMs)) return 0;
    return Math.max(0, Math.round(endTimeMs - startTimeMs));
}

export function shouldSampleViewerHealth(
    sampleRate: number = 0.01,
    randomFn: () => number = Math.random
): boolean {
    const rate = Math.max(0, Math.min(1, Number.isFinite(sampleRate) ? sampleRate : 0.01));
    return randomFn() < rate;
}

export function classifyViewerError(
    statusCode: number | null | undefined,
    errorMessage?: string | null
): ViewerErrorCode {
    if (statusCode === 404 || statusCode === 410) {
        return 'not_found_or_expired';
    }
    if (statusCode === 429) {
        return 'rate_limited';
    }
    if (typeof statusCode === 'number' && statusCode >= 500 && statusCode < 600) {
        return 'server_error';
    }
    const msg = (errorMessage || '').toLowerCase();
    if (
        msg.includes('syntaxerror') ||
        msg.includes('json') ||
        msg.includes('unexpected token') ||
        msg.includes('malformed')
    ) {
        return 'malformed_response';
    }
    if (
        statusCode === 0 ||
        msg.includes('network') ||
        msg.includes('offline') ||
        msg.includes('failed to fetch') ||
        msg.includes('timeout') ||
        msg.includes('aborterror')
    ) {
        return 'offline_network';
    }
    return 'unknown';
}

export function buildViewerHealthTelemetryPayload(params: {
    sessionId: string;
    pollLatencyMs: number;
    statusCode: number;
    isActive: boolean;
    hasLocation: boolean;
    batteryLevel?: number | null;
    pointCount?: number;
    isStale?: boolean;
}): ViewerHealthTelemetryPayload {
    const cleanSessionId = (params.sessionId || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
    const latency = computePollLatencyMs(0, params.pollLatencyMs);
    const status = Number.isFinite(params.statusCode) ? Math.round(params.statusCode) : 200;
    const pointCount = typeof params.pointCount === 'number' && Number.isFinite(params.pointCount)
        ? Math.max(0, Math.round(params.pointCount))
        : 0;
    const clampedBattery = clampBatteryLevel(params.batteryLevel);

    return {
        sessionId: cleanSessionId,
        pollLatencyMs: latency,
        statusCode: status,
        isActive: !!params.isActive,
        hasLocation: !!params.hasLocation,
        batteryLevel: clampedBattery,
        pointCount,
        isStale: !!params.isStale,
    };
}

/**
 * CIE-042: Live Share Viewer Reconnection State Memory & Seamless Resynchronization Parity.
 */
export interface ViewerCachePayload {
    readonly sessionId: string;
    readonly username?: string;
    readonly status: string;
    readonly lastLocation: {
        readonly lat: number;
        readonly lng: number;
        readonly speed?: number | null;
        readonly heading?: number | null;
        readonly batteryLevel?: number | null;
        readonly timestamp?: number | string | null;
        readonly powerSaveMode?: boolean;
    } | null;
    readonly path: Array<[number, number]>;
    readonly cachedAtEpochMs: number;
}

export interface ReconnectionResyncEvaluation {
    readonly shouldFetchImmediately: boolean;
    readonly shouldUseCachedState: boolean;
    readonly resetConsecutiveErrors: boolean;
    readonly statusMessage: string | null;
}

/**
 * Evaluates whether map viewport, breadcrumb route, and marker should be preserved during network dropouts.
 * Prevents disruptive map resets or clearing when entering offline dead zones.
 */
export function shouldPreserveViewerState(
    hasRenderedLocation: boolean,
    isOffline: boolean
): boolean {
    return hasRenderedLocation;
}

/**
 * Evaluates offline-to-online reconnection resynchronization logic.
 */
export function evaluateReconnectionResync(params: {
    isOnline: boolean;
    wasOffline: boolean;
    hasCachedSnapshot: boolean;
    isTripEnded: boolean;
    isFetchInProgress?: boolean;
}): ReconnectionResyncEvaluation {
    if (params.isTripEnded) {
        return {
            shouldFetchImmediately: false,
            shouldUseCachedState: params.hasCachedSnapshot,
            resetConsecutiveErrors: false,
            statusMessage: null,
        };
    }

    if (!params.isOnline) {
        return {
            shouldFetchImmediately: false,
            shouldUseCachedState: params.hasCachedSnapshot,
            resetConsecutiveErrors: false,
            statusMessage: 'Viewer Offline',
        };
    }

    if (params.isOnline && params.wasOffline) {
        return {
            shouldFetchImmediately: !params.isFetchInProgress,
            shouldUseCachedState: params.hasCachedSnapshot,
            resetConsecutiveErrors: true,
            statusMessage: 'Reconnecting...',
        };
    }

    return {
        shouldFetchImmediately: false,
        shouldUseCachedState: params.hasCachedSnapshot,
        resetConsecutiveErrors: false,
        statusMessage: null,
    };
}

/**
 * Serializes and sanitizes a viewer snapshot into a compact JSON string for safe local/session cache.
 * Strips any sensitive tokens, clamps coordinates, and bounds path size to max 500 points.
 */
export function serializeViewerCachePayload(
    snapshot: any,
    nowEpochMs: number = Date.now()
): string | null {
    if (!snapshot || typeof snapshot !== 'object') return null;
    const cleanId = typeof snapshot.sessionId === 'string'
        ? snapshot.sessionId.trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)
        : '';
    if (!cleanId) return null;

    let sanitizedLoc: ViewerCachePayload['lastLocation'] = null;
    if (snapshot.lastLocation && typeof snapshot.lastLocation === 'object') {
        const rawLat = Number(snapshot.lastLocation.lat);
        const rawLng = Number(snapshot.lastLocation.lng !== undefined ? snapshot.lastLocation.lng : snapshot.lastLocation.lon);
        if (Number.isFinite(rawLat) && Number.isFinite(rawLng) && rawLat >= -90 && rawLat <= 90 && rawLng >= -180 && rawLng <= 180) {
            sanitizedLoc = {
                lat: rawLat,
                lng: rawLng,
                speed: typeof snapshot.lastLocation.speed === 'number' && Number.isFinite(snapshot.lastLocation.speed) ? Math.max(0, snapshot.lastLocation.speed) : null,
                heading: typeof snapshot.lastLocation.heading === 'number' && Number.isFinite(snapshot.lastLocation.heading) ? snapshot.lastLocation.heading : null,
                batteryLevel: clampBatteryLevel(snapshot.lastLocation.batteryLevel),
                timestamp: snapshot.lastLocation.timestamp || null,
                powerSaveMode: Boolean(snapshot.lastLocation.powerSaveMode),
            };
        }
    }

    const rawPath = Array.isArray(snapshot.path) ? snapshot.path : [];
    const sanitizedPath: Array<[number, number]> = [];
    for (const pt of rawPath) {
        if (Array.isArray(pt) && pt.length >= 2) {
            const pLat = Number(pt[0]);
            const pLng = Number(pt[1]);
            if (Number.isFinite(pLat) && Number.isFinite(pLng) && pLat >= -90 && pLat <= 90 && pLng >= -180 && pLng <= 180) {
                sanitizedPath.push([pLat, pLng]);
            }
        }
    }
    // Cap path to latest 500 points to keep storage minimal
    const boundedPath = sanitizedPath.length > 500 ? sanitizedPath.slice(-500) : sanitizedPath;

    const payload: ViewerCachePayload = {
        sessionId: cleanId,
        username: typeof snapshot.username === 'string' ? snapshot.username.trim().slice(0, 60) : undefined,
        status: typeof snapshot.status === 'string' ? snapshot.status : 'active',
        lastLocation: sanitizedLoc,
        path: boundedPath,
        cachedAtEpochMs: Number.isFinite(nowEpochMs) ? nowEpochMs : Date.now(),
    };

    try {
        return JSON.stringify(payload);
    } catch {
        return null;
    }
}

/**
 * Safely parses and validates a cached viewer snapshot from JSON string.
 */
export function deserializeViewerCachePayload(jsonStr: unknown): ViewerCachePayload | null {
    if (typeof jsonStr !== 'string' || !jsonStr.trim()) return null;
    try {
        const parsed = JSON.parse(jsonStr);
        if (!parsed || typeof parsed !== 'object') return null;
        if (typeof parsed.sessionId !== 'string' || !parsed.sessionId.trim()) return null;
        return parsed as ViewerCachePayload;
    } catch {
        return null;
    }
}

export interface SpectatorThrottleEvaluation {
    readonly isInactive: boolean;
    readonly isThrottled: boolean;
    readonly pollDelayMs: number;
    readonly shouldAnimateMap: boolean;
    readonly noticeText: string | null;
}

/**
 * CIE-044: Evaluates spectator idle inactivity and render throttling state across Web & Mobile.
 *
 * Rules:
 * 1. If trip has ended, disable animations and return base delay with no notice.
 * 2. If tab/app is in the background or obscured (isDocumentHidden=true):
 *    - Throttled = true, shouldAnimateMap = false (prevent useless GPU/DOM re-paints while invisible).
 *    - pollDelayMs = 30,000ms.
 * 3. If spectator has not interacted for >= inactivityThresholdMs (default: 300,000ms / 5 min):
 *    - isInactive = true, isThrottled = true.
 *    - pollDelayMs = 15,000ms (relaxed from 5,000ms, saving 66% network/CPU).
 *    - shouldAnimateMap = false (avoid battery-draining continuous pan/rotate animation).
 *    - noticeText = 'Viewer idle · Updates slowed to save battery'.
 * 4. If rider is in power-save mode or low battery (<= 15%):
 *    - isThrottled = true, pollDelayMs = 12,000ms.
 *    - shouldAnimateMap = true.
 *    - noticeText = 'Power save active · Location updates every ~15s'.
 * 5. Active foreground with recent interaction:
 *    - isInactive = false, isThrottled = false, pollDelayMs = basePollDelayMs (5,000ms), shouldAnimateMap = true.
 */
export function evaluateSpectatorThrottleState(
    isTripEnded: boolean,
    isDocumentHidden: boolean = false,
    lastInteractionEpochMs: number | null = null,
    nowEpochMs: number = Date.now(),
    riderPowerSave: boolean = false,
    riderBatteryLevel: number | null = null,
    basePollDelayMs: number = 5000,
    inactivityThresholdMs: number = 300000 // 5 minutes
): SpectatorThrottleEvaluation {
    return TrackCore.evaluateSpectatorThrottleState(
        isTripEnded,
        isDocumentHidden,
        lastInteractionEpochMs,
        nowEpochMs,
        riderPowerSave,
        riderBatteryLevel,
        basePollDelayMs,
        inactivityThresholdMs
    );
}

/**
 * Metrics describing breadcrumb decimation efficiency.
 */
export interface DecimationMetrics {
    pointsPreDecimation: number;
    pointsPostDecimation: number;
    pointsSaved: number;
    decimationRatio: number;
    estimatedBytesSaved: number;
}

/**
 * Computes polling delay under Low-Data Mode.
 * When Low-Data Mode is enabled, polling slows to 30,000ms (30s) to conserve cellular data.
 *
 * @param isLowDataMode Whether low-data mode is activated
 * @param defaultDelayMs Default polling delay in ms (defaults to 5000)
 */
export function computeLowDataPollDelay(isLowDataMode: boolean, defaultDelayMs: number = 5000): number {
    return isLowDataMode ? 30000 : Math.max(1000, defaultDelayMs);
}

/**
 * Computes decimation metrics comparing raw points to decimated stored points.
 * Standard JSON format for coordinate pair `[lat, lng]` consumes ~28 bytes.
 *
 * @param preCount Total points recorded prior to decimation
 * @param postCount Points retained following decimation
 */
export function computeDecimationMetrics(preCount: number, postCount: number): DecimationMetrics {
    const safePre = Math.max(0, Math.floor(preCount || 0));
    const safePost = Math.max(0, Math.floor(postCount || 0));
    const pointsSaved = Math.max(0, safePre - safePost);
    const decimationRatio = safePre > 0 ? pointsSaved / safePre : 0;
    const estimatedBytesSaved = pointsSaved * 28;

    return {
        pointsPreDecimation: safePre,
        pointsPostDecimation: safePost,
        pointsSaved,
        decimationRatio,
        estimatedBytesSaved,
    };
}

/**
 * Builds a sanitized, non-PII telemetry payload for low-data mode and decimation.
 * Strictly adheres to privacy invariants: zero raw coordinates, session tokens, or personal info.
 */
export function buildLowDataTelemetryPayload(
    isLowDataMode: boolean,
    preCount: number = 0,
    postCount: number = 0
): Record<string, any> {
    const metrics = computeDecimationMetrics(preCount, postCount);
    return {
        low_data_mode: isLowDataMode,
        points_pre_decimation: metrics.pointsPreDecimation,
        points_post_decimation: metrics.pointsPostDecimation,
        points_saved: metrics.pointsSaved,
        decimation_ratio: Number(metrics.decimationRatio.toFixed(3)),
        estimated_bytes_saved: metrics.estimatedBytesSaved,
    };
}

/**
 * Formats user-facing status notice when low-data mode is active.
 */
export function formatLowDataNoticeText(isLowDataMode: boolean): string | null {
    if (!isLowDataMode) return null;
    return 'Low-data mode active · Polling every 30s';
}
