/**
 * Live Share Unit System & Preference Utilities (CIE-030)
 *
 * Provides pure, deterministic helpers for:
 * 1. Resolving user's initial unit preference (URL query -> localStorage -> navigator locale -> metric fallback)
 * 2. Toggling and persisting unit systems (metric km/kmh <-> imperial mi/mph)
 * 3. Formatting live viewer speed and path distance in the active unit system
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const TrackCore = require('../../public/js/tracker-core.js');

export type UnitSystem = 'metric' | 'imperial';

export const PREFERRED_UNITS_STORAGE_KEY: string = TrackCore.PREFERRED_UNITS_STORAGE_KEY;

export function resolveInitialUnits(
  queryParam?: string | null,
  storedPreference?: string | null,
  navigatorLanguages?: readonly string[] | string | null,
): UnitSystem {
  return TrackCore.resolveInitialUnits(queryParam, storedPreference, navigatorLanguages);
}

export function toggleUnitSystem(current: UnitSystem): UnitSystem {
  return TrackCore.toggleUnitSystem(current);
}

export function formatViewerSpeed(
  speedKmh: number | null | undefined,
  unit: UnitSystem,
): string {
  return TrackCore.formatViewerSpeed(speedKmh, unit);
}

export function formatViewerDistance(
  meters: number | null | undefined,
  unit: UnitSystem,
): string {
  return TrackCore.formatViewerDistance(meters, unit);
}

