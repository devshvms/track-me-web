/**
 * TASK-366 / SCOPE_1.9.3 / CIE-032: Battery & Frame Rate Throttling Utilities.
 * Pure helpers for camera and heading deadband thresholds to prevent GPU/CPU animation
 * thrashing while stationary or experiencing GPS/compass jitter.
 */

export const CAMERA_DEADBAND_METERS = 3.0;
export const COMPASS_BEARING_DEADBAND_DEGREES = 3.0;

/**
 * Calculates Great-Circle distance between two coordinates in meters via Haversine formula.
 */
export function computeHaversineDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  if (lat1 === lat2 && lon1 === lon2) return 0;
  const R = 6371000; // Earth radius in meters
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Determines whether the camera position should pan/animate to a new position.
 * Returns true if initial position, or if displacement exceeds the deadband threshold.
 */
export function shouldPanCamera(
  lastPos: [number, number] | null | undefined,
  newPos: [number, number],
  thresholdMeters: number = CAMERA_DEADBAND_METERS
): boolean {
  if (!lastPos) return true;
  const distance = computeHaversineDistanceMeters(
    lastPos[0],
    lastPos[1],
    newPos[0],
    newPos[1]
  );
  return distance >= thresholdMeters;
}

/**
 * Determines whether continuous heading rotation should update/animate.
 * Returns false when stationary or when heading delta is within compass noise deadband (< 3 degrees).
 */
export function shouldUpdateContinuousHeading(
  currentHeading: number | null | undefined,
  targetHeading: number | null | undefined,
  isStationary: boolean,
  thresholdDegrees: number = COMPASS_BEARING_DEADBAND_DEGREES
): boolean {
  if (isStationary) return false;
  if (targetHeading === null || targetHeading === undefined || !Number.isFinite(targetHeading)) return false;
  if (currentHeading === null || currentHeading === undefined || !Number.isFinite(currentHeading)) return true;

  let c = currentHeading % 360;
  if (c < 0) c += 360;
  let t = targetHeading % 360;
  if (t < 0) t += 360;
  const delta = ((t - c + 540) % 360) - 180;

  return Math.abs(delta) >= thresholdDegrees;
}
