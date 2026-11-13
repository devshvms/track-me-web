export const MAX_PATH_POINTS = 300;
export const MIN_POINT_DISTANCE_METERS = 15;
export const STALE_VIEWER_WINDOW_MS = 40_000;

export type LatLngTuple = [number, number];

/** Rounds a coordinate to 5 decimal places (~1.1 m precision). */
export function roundCoord(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}

/** Validates latitude/longitude bounds and finiteness. */
export function isValidLatLng(lat: unknown, lng: unknown): lat is number {
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

/** Haversine distance in meters between two [lat, lng] points. */
export function haversineMeters(a: LatLngTuple, b: LatLngTuple): number {
  const R = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

/** Forward azimuth bearing in degrees [0, 360) from `from` to `to`. */
export function computeBearingDegrees(from: LatLngTuple, to: LatLngTuple): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const toDeg = (rad: number) => (rad * 180) / Math.PI;
  const lat1 = toRad(from[0]);
  const lat2 = toRad(to[0]);
  const dLng = toRad(to[1] - from[1]);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  const bearing = (toDeg(Math.atan2(y, x)) + 360) % 360;
  return Math.round(bearing * 10) / 10;
}

/**
 * Uniformly decimates `path` when it exceeds `maxPoints` while strictly preserving
 * `path[0]` (origin/start) and `path[path.length - 1]` (latest location).
 * Keeps total serialized footprint <= ~5.4 KB per live session on free-tier Redis.
 */
export function compactPath(
  path: LatLngTuple[],
  maxPoints = MAX_PATH_POINTS,
): LatLngTuple[] {
  if (path.length <= maxPoints) {
    return path;
  }
  const compacted: LatLngTuple[] = [];
  for (let i = 0; i < path.length; i += 2) {
    compacted.push(path[i]);
  }
  const last = path[path.length - 1];
  const lastCompacted = compacted[compacted.length - 1];
  if (!lastCompacted || lastCompacted[0] !== last[0] || lastCompacted[1] !== last[1]) {
    compacted.push(last);
  }
  return compacted;
}

/**
 * Appends `[lat, lng]` to the session's bounded breadcrumb trail if displaced >= 15 m
 * from the last stored trail point, and computes a fallback bearing when GPS heading
 * is absent/invalid during movement.
 */
export function appendPathPoint(
  existingPath: unknown,
  lat: number,
  lng: number,
  rawHeading?: unknown,
): { path: LatLngTuple[]; heading: number | null } {
  const sanitized: LatLngTuple[] = Array.isArray(existingPath)
    ? existingPath.filter(
        (entry): entry is LatLngTuple =>
          Array.isArray(entry) &&
          entry.length === 2 &&
          isValidLatLng(entry[0], entry[1]),
      )
    : [];

  const pt: LatLngTuple = [roundCoord(lat), roundCoord(lng)];
  const path = sanitized.slice();

  if (path.length === 0) {
    path.push(pt);
  } else {
    const last = path[path.length - 1];
    if (haversineMeters(last, pt) >= MIN_POINT_DISTANCE_METERS) {
      path.push(pt);
    }
  }

  const boundedPath = compactPath(path);

  let resolvedHeading: number | null = null;
  if (typeof rawHeading === 'number' && Number.isFinite(rawHeading) && rawHeading >= 0 && rawHeading <= 360) {
    resolvedHeading = Math.round(rawHeading * 10) / 10;
  } else if (boundedPath.length >= 2) {
    // Find nearest prior point at least 3 m away for an accurate fallback bearing.
    for (let i = boundedPath.length - 2; i >= 0; i--) {
      if (haversineMeters(boundedPath[i], pt) >= 3) {
        resolvedHeading = computeBearingDegrees(boundedPath[i], pt);
        break;
      }
    }
  }

  return {
    path: boundedPath,
    heading: resolvedHeading,
  };
}
