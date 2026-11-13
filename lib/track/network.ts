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

