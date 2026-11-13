/**
 * Live Share Trip Duration and Signal Freshness utilities (CIE-011)
 *
 * Provides pure, deterministic helpers for:
 * 1. Deriving human-readable elapsed duration (e.g. "< 1m", "42m", "1h 15m")
 * 2. Evaluating stale signal conditions (e.g. > 3 minutes without location update during active ride)
 */

export const STALE_SIGNAL_THRESHOLD_MS = 180_000; // 3 minutes

export function parseTimestampMs(value?: number | string | null): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const num = Number(trimmed);
    if (Number.isFinite(num) && num > 0) return num;
    const parsed = new Date(trimmed).getTime();
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

/**
 * Formats the elapsed or total trip duration into a concise string.
 * Examples:
 * - < 1 min: "< 1m"
 * - 45 min: "45m"
 * - 1 hour 15 min: "1h 15m"
 * - 2 hours exactly: "2h"
 */
export function formatElapsedDuration(
  startedAt?: number | string | null,
  endedAt?: number | string | null,
  referenceNowMs?: number,
): string | null {
  const startMs = parseTimestampMs(startedAt);
  if (!startMs) return null;

  const endMs = parseTimestampMs(endedAt);
  const nowMs = typeof referenceNowMs === 'number' && Number.isFinite(referenceNowMs)
    ? referenceNowMs
    : Date.now();

  const effectiveEndMs = endMs !== null ? endMs : nowMs;
  const durationMs = Math.max(0, effectiveEndMs - startMs);
  const totalMinutes = Math.floor(durationMs / 60_000);

  if (totalMinutes < 1) {
    return '< 1m';
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) {
    return `${minutes}m`;
  }

  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/**
 * Checks if a live location signal is stale (> 3 minutes without an update on an active ride).
 */
export function isSignalStale(
  lastLocationTimestamp?: number | string | null,
  referenceNowMs?: number,
  thresholdMs: number = STALE_SIGNAL_THRESHOLD_MS,
): boolean {
  const lastMs = parseTimestampMs(lastLocationTimestamp);
  if (!lastMs) return false;

  const nowMs = typeof referenceNowMs === 'number' && Number.isFinite(referenceNowMs)
    ? referenceNowMs
    : Date.now();

  return (nowMs - lastMs) >= thresholdMs;
}

export interface DeadlineStatus {
  isOverdue: boolean;
  deadlineMs: number;
  timeString: string;
  overdueMinutes: number;
  displayText: string;
}

/**
 * Evaluates a scheduled trip deadline or ETA (CIE-025).
 * Formats user-facing status e.g. "Expected by 6:30 PM" or "Overdue · Expected by 6:30 PM".
 */
export function evaluateDeadlineStatus(
  deadlineRaw?: number | string | null,
  referenceNowMs?: number,
  timeFormatter?: (ms: number) => string,
): DeadlineStatus | null {
  const deadlineMs = parseTimestampMs(deadlineRaw);
  if (!deadlineMs) return null;

  const nowMs = typeof referenceNowMs === 'number' && Number.isFinite(referenceNowMs)
    ? referenceNowMs
    : Date.now();

  const isOverdue = nowMs > deadlineMs;
  const overdueMinutes = isOverdue ? Math.floor((nowMs - deadlineMs) / 60_000) : 0;

  const timeString = typeof timeFormatter === 'function'
    ? timeFormatter(deadlineMs)
    : new Date(deadlineMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  const displayText = isOverdue
    ? `Overdue · Expected by ${timeString}`
    : `Expected by ${timeString}`;

  return {
    isOverdue,
    deadlineMs,
    timeString,
    overdueMinutes,
    displayText,
  };
}

export const STATIONARY_SPEED_THRESHOLD_KMH = 3.0; // ~0.83 m/s

export interface SpeedOrStoppedStatus {
  isStationary: boolean;
  isStoppedTimerActive: boolean;
  stoppedDurationMinutes: number;
  displayText: string;
  a11yText: string;
}

/**
 * Evaluates live rider speed vs stationary state and stopped duration (CIE-029).
 * When speed < 3.0 km/h and stationary for >= 60 seconds, displays "Stopped · Xm"
 * instead of a static "0 km/h" to reassure viewers that the ride is active and paused.
 */
export function evaluateSpeedOrStopped(
  speedKmh?: number | null,
  stoppedSinceMs?: number | null,
  referenceNowMs?: number,
  useMiles: boolean = false,
  isDelayed: boolean = false,
): SpeedOrStoppedStatus {
  const isSpeedValid = typeof speedKmh === 'number' && Number.isFinite(speedKmh);
  const effectiveSpeed = isSpeedValid ? Math.max(0, speedKmh) : null;
  const isStationary = effectiveSpeed === null || effectiveSpeed < STATIONARY_SPEED_THRESHOLD_KMH;
  const unit = useMiles ? 'mph' : 'km/h';

  if (!isStationary) {
    const rawVal = useMiles ? (effectiveSpeed! * 0.621371) : effectiveSpeed!;
    const roundedSpeed = Math.round(rawVal);
    const displayText = isDelayed ? `~${roundedSpeed} ${unit} ⚠️ (delayed)` : `${roundedSpeed} ${unit}`;
    const a11yText = `Rider speed: ${roundedSpeed} ${unit}`;
    return {
      isStationary: false,
      isStoppedTimerActive: false,
      stoppedDurationMinutes: 0,
      displayText,
      a11yText,
    };
  }

  const nowMs = typeof referenceNowMs === 'number' && Number.isFinite(referenceNowMs)
    ? referenceNowMs
    : Date.now();

  const stoppedStartMs = parseTimestampMs(stoppedSinceMs);
  if (stoppedStartMs && nowMs >= stoppedStartMs) {
    const stoppedDurationMs = Math.max(0, nowMs - stoppedStartMs);
    const stoppedMinutes = Math.floor(stoppedDurationMs / 60_000);

    if (stoppedMinutes >= 1) {
      const durationStr = formatElapsedDuration(stoppedStartMs, nowMs, nowMs) || `${stoppedMinutes}m`;
      return {
        isStationary: true,
        isStoppedTimerActive: true,
        stoppedDurationMinutes: stoppedMinutes,
        displayText: `Stopped · ${durationStr}`,
        a11yText: `Rider stopped for ${durationStr}`,
      };
    }
  }

  return {
    isStationary: true,
    isStoppedTimerActive: false,
    stoppedDurationMinutes: 0,
    displayText: `0 ${unit}`,
    a11yText: 'Rider stationary',
  };
}
