/**
 * TASK-366 / SCOPE_1.9.3 / CIE-032: Battery & Frame Rate Throttling Utilities.
 * Pure helpers for camera and heading deadband thresholds to prevent GPU/CPU animation
 * thrashing while stationary or experiencing GPS/compass jitter.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const TrackCore = require('../../public/js/tracker-core.js');

export const CAMERA_DEADBAND_METERS: number = TrackCore.CAMERA_DEADBAND_METERS;
export const COMPASS_BEARING_DEADBAND_DEGREES: number = TrackCore.COMPASS_BEARING_DEADBAND_DEGREES;

export function computeHaversineDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  return TrackCore.computeHaversineDistanceMeters(lat1, lon1, lat2, lon2);
}

export function shouldPanCamera(
  lastPos: [number, number] | null | undefined,
  newPos: [number, number],
  thresholdMeters: number = CAMERA_DEADBAND_METERS
): boolean {
  return TrackCore.shouldPanCamera(lastPos, newPos, thresholdMeters);
}

export function shouldUpdateContinuousHeading(
  currentHeading: number | null | undefined,
  targetHeading: number | null | undefined,
  isStationary: boolean,
  thresholdDegrees: number = COMPASS_BEARING_DEADBAND_DEGREES
): boolean {
  return TrackCore.shouldUpdateContinuousHeading(currentHeading, targetHeading, isStationary, thresholdDegrees);
}

