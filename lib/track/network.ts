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
