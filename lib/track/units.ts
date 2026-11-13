/**
 * Live Share Unit System & Preference Utilities (CIE-030)
 *
 * Provides pure, deterministic helpers for:
 * 1. Resolving user's initial unit preference (URL query -> localStorage -> navigator locale -> metric fallback)
 * 2. Toggling and persisting unit systems (metric km/kmh <-> imperial mi/mph)
 * 3. Formatting live viewer speed and path distance in the active unit system
 */

export type UnitSystem = 'metric' | 'imperial';

export const PREFERRED_UNITS_STORAGE_KEY = 'trackme_preferred_units';

/**
 * Resolves initial unit system from hierarchical sources:
 * 1. Explicit URL query parameter (?units=imperial | ?units=metric | ?unit=mi | ?unit=km)
 * 2. Persistent storage preference in localStorage
 * 3. Browser locale / language settings (e.g. en-US, en-LR, en-MM default to imperial)
 * 4. Default: 'metric'
 */
export function resolveInitialUnits(
  queryParam?: string | null,
  storedPreference?: string | null,
  navigatorLanguages?: readonly string[] | string | null,
): UnitSystem {
  if (queryParam) {
    const q = queryParam.trim().toLowerCase();
    if (q === 'imperial' || q === 'mi' || q === 'mph' || q === 'miles') {
      return 'imperial';
    }
    if (q === 'metric' || q === 'km' || q === 'kmh' || q === 'kilometers') {
      return 'metric';
    }
  }

  if (storedPreference) {
    const s = storedPreference.trim().toLowerCase();
    if (s === 'imperial') return 'imperial';
    if (s === 'metric') return 'metric';
  }

  if (navigatorLanguages) {
    const langs = Array.isArray(navigatorLanguages)
      ? navigatorLanguages
      : [navigatorLanguages];
    for (const lang of langs) {
      if (typeof lang === 'string') {
        const clean = lang.trim();
        // US (United States), LR (Liberia), MM (Myanmar) primarily use imperial units
        if (/(?:-|_)US$/i.test(clean) || /(?:-|_)LR$/i.test(clean) || /(?:-|_)MM$/i.test(clean)) {
          return 'imperial';
        }
      }
    }
  }

  return 'metric';
}

/**
 * Toggles between metric and imperial unit systems.
 */
export function toggleUnitSystem(current: UnitSystem): UnitSystem {
  return current === 'imperial' ? 'metric' : 'imperial';
}

/**
 * Formats speed in km/h or mph.
 */
export function formatViewerSpeed(
  speedKmh: number | null | undefined,
  unit: UnitSystem,
): string {
  const isImperial = unit === 'imperial';
  const unitLabel = isImperial ? 'mph' : 'km/h';

  if (speedKmh === null || speedKmh === undefined || !Number.isFinite(speedKmh) || speedKmh < 0) {
    return `0 ${unitLabel}`;
  }

  const rawVal = isImperial ? speedKmh * 0.621371 : speedKmh;
  const rounded = Math.round(rawVal);
  return `${rounded} ${unitLabel}`;
}

/**
 * Formats total accumulated distance in km or mi with one decimal precision.
 */
export function formatViewerDistance(
  meters: number | null | undefined,
  unit: UnitSystem,
): string {
  const isImperial = unit === 'imperial';
  if (meters === null || meters === undefined || !Number.isFinite(meters) || meters <= 0) {
    return isImperial ? '0.0 mi' : '0.0 km';
  }

  if (isImperial) {
    return `${(meters / 1609.344).toFixed(1)} mi`;
  }
  return `${(meters / 1000).toFixed(1)} km`;
}
