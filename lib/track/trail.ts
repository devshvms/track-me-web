export const MAX_PATH_POINTS = 300;
export const MIN_POINT_DISTANCE_METERS = 15;
export const STALE_VIEWER_WINDOW_MS = 40_000;
export const MAX_PLAUSIBLE_SPEED_MPS = 250; // 250 m/s ~ 900 km/h (airline cruising speed)
export const MAX_PLAUSIBLE_JUMP_METERS = 50_000; // 50 km single-hop clamp for ground tracking

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

/** Parses numeric or string coordinate safely into a finite float or null. */
export function parseCoordinate(val: unknown): number | null {
  if (typeof val === 'number') {
    return Number.isFinite(val) ? val : null;
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!trimmed) return null;
    const num = Number(trimmed);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

/** Checks whether a coordinate is located at or near Null Island (0, 0). */
export function isNullIsland(lat: number, lng: number): boolean {
  return Math.abs(lat) < 1e-4 && Math.abs(lng) < 1e-4;
}

/**
 * Validates whether a new coordinate update is plausible relative to the last recorded point.
 * Detects and rejects:
 * 1. Jumps to Null Island (0, 0) when prior points were recorded elsewhere (> 50 km away).
 * 2. Supersonic jumps (> 250 m/s or > 50 km single hop) caused by cellular tower triangulation glitches.
 */
export function isImplausibleJump(
  lastPoint: LatLngTuple,
  newPoint: LatLngTuple,
  lastTimestamp?: unknown,
  newTimestamp?: unknown,
  maxSpeedMps: number = MAX_PLAUSIBLE_SPEED_MPS,
): boolean {
  const dist = haversineMeters(lastPoint, newPoint);

  // If new point is Null Island and prior point was far away, it's an uninitialized hardware reading
  if (isNullIsland(newPoint[0], newPoint[1]) && dist > 50_000) {
    return true;
  }

  // Normal displacement within 100 meters is always plausible
  if (dist < 100) {
    return false;
  }

  // Check implied speed if timestamps are available
  let deltaSec: number | null = null;
  if (lastTimestamp && newTimestamp) {
    const t1 = new Date(String(lastTimestamp)).getTime();
    const t2 = new Date(String(newTimestamp)).getTime();
    if (Number.isFinite(t1) && Number.isFinite(t2) && t2 >= t1) {
      deltaSec = Math.max(1, (t2 - t1) / 1000);
    }
  }

  if (deltaSec !== null) {
    const impliedSpeed = dist / deltaSec;
    if (impliedSpeed > maxSpeedMps) {
      return true;
    }
  } else if (dist > MAX_PLAUSIBLE_JUMP_METERS) {
    return true;
  }

  return false;
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
 * from the last stored trail point, filters out implausible GPS glitch jumps,
 * and computes a fallback bearing when GPS heading is absent/invalid during movement.
 */
export function appendPathPoint(
  existingPath: unknown,
  lat: number,
  lng: number,
  rawHeading?: unknown,
  lastTimestamp?: unknown,
  newTimestamp?: unknown,
): { path: LatLngTuple[]; heading: number | null; isJumpFiltered: boolean } {
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

  let isJumpFiltered = false;

  if (path.length === 0) {
    if (!isNullIsland(pt[0], pt[1])) {
      path.push(pt);
    }
  } else {
    const last = path[path.length - 1];
    if (isImplausibleJump(last, pt, lastTimestamp, newTimestamp)) {
      isJumpFiltered = true;
    } else if (haversineMeters(last, pt) >= MIN_POINT_DISTANCE_METERS) {
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
    isJumpFiltered,
  };
}

/**
 * Computes accumulated geodesic distance in meters across an array of breadcrumb coordinates.
 * Handles both [lat, lng] tuples and { lat, lng } objects.
 * Filters out sub-meter jitter (< 2 m) and supersonic single-hop glitches (> 50 km).
 */
export function computePathDistanceMeters(rawPath: unknown): number {
  if (!Array.isArray(rawPath) || rawPath.length < 2) {
    return 0;
  }

  let totalMeters = 0;
  let prevPt: LatLngTuple | null = null;

  for (const entry of rawPath) {
    let lat: number | null = null;
    let lng: number | null = null;

    if (Array.isArray(entry) && entry.length >= 2) {
      lat = parseCoordinate(entry[0]);
      lng = parseCoordinate(entry[1]);
    } else if (entry && typeof entry === 'object') {
      lat = parseCoordinate((entry as any).lat ?? (entry as any).latitude);
      lng = parseCoordinate((entry as any).lng ?? (entry as any).longitude);
    }

    if (lat === null || lng === null || !isValidLatLng(lat, lng) || isNullIsland(lat, lng)) {
      continue;
    }

    const currentPt: LatLngTuple = [lat, lng];
    if (prevPt !== null) {
      const dist = haversineMeters(prevPt, currentPt);
      // Discard small jitter (< 2 m) and implausible supersonic jumps (> 50 km)
      if (dist >= 2 && dist <= MAX_PLAUSIBLE_JUMP_METERS) {
        totalMeters += dist;
        prevPt = currentPt;
      }
    } else {
      prevPt = currentPt;
    }
  }

  return Math.round(totalMeters);
}

/** Formats meters into human-readable distance ("14.2 km" or "8.8 mi"). */
export function formatViewerDistance(meters: number, useMiles = false): string {
  if (!Number.isFinite(meters) || meters <= 0) {
    return useMiles ? '0.0 mi' : '0.0 km';
  }
  if (useMiles) {
    const miles = meters / 1609.344;
    return `${miles.toFixed(1)} mi`;
  }
  const km = meters / 1000;
  return `${km.toFixed(1)} km`;
}

