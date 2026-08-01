/**
 * TASK-171 / D5. Session lifetime policy for live share.
 *
 * The fixed 1440-minute cap assumed a share is a timer. Under trip planning it
 * is evidence a guardian consults at a deadline, so the session must live
 * through the whole decision window and then die:
 *
 *   expiry = a set window after ride end, or after the guardian deadline,
 *            whichever is later.
 *
 * At start the ride end is unknown, so the session is provisioned to
 * deadline + window. At stop it is re-scoped to now + window, or kept through
 * deadline + window if that is later — a rider who marks themselves safe at
 * 5:42 pm with a 9 pm deadline must still be visibly "safe" to the guardian
 * who checks at 9 pm. Sessions with no trip plan keep the old duration
 * behaviour at start and get the same post-end window at stop, so a stopped
 * share no longer lingers for the rest of a 24-hour duration.
 *
 * The 7-day ceiling is not a product decision about trip length; it is the
 * guard that keeps a typo in a deadline from minting a practically immortal
 * tracking link (D5's other half).
 */

/** How long a session stays viewable after the moment it stops mattering. */
export const POST_END_VISIBILITY_SECONDS = 2 * 60 * 60;

/** Legacy default when the client sends no duration and no trip plan. */
export const DEFAULT_DURATION_MINUTES = 1440;

/** Sanity ceiling replacing the arbitrary 1440-minute cap. */
export const MAX_SESSION_MINUTES = 7 * 24 * 60;

/** "Act if no word by" defaults to one hour past the ETA (mirrors TASK-151). */
export const DEFAULT_DEADLINE_GRACE_SECONDS = 60 * 60;

const MAX_DESTINATION_LABEL_LENGTH = 80;

export interface TripDestination {
  lat: number;
  lng: number;
  label?: string;
}

export interface TripPlan {
  destination: TripDestination | null;
  /** ISO timestamp the rider said they would be back by. */
  etaAt: string | null;
  /** ISO timestamp the guardian should act at if they have heard nothing. */
  deadlineAt: string | null;
}

export type TripPlanParseResult =
  | { ok: true; plan: TripPlan }
  | { ok: false; error: string };

function parseIsoMs(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Validate the optional trip fields of the start payload. Rejects rather than
 * silently repairing: a mangled deadline that got "fixed" server-side would
 * expire the session at a time no human agreed to.
 */
export function parseTripPlan(body: any, nowMs: number): TripPlanParseResult {
  const plan: TripPlan = { destination: null, etaAt: null, deadlineAt: null };
  const { destination, etaAt, deadlineAt } = body || {};

  if (destination !== undefined && destination !== null) {
    const lat = destination?.lat;
    const lng = destination?.lng;
    if (
      typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90 ||
      typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180
    ) {
      return { ok: false, error: 'destination must have numeric lat (-90..90) and lng (-180..180).' };
    }
    const dest: TripDestination = { lat, lng };
    if (destination.label !== undefined && destination.label !== null) {
      if (typeof destination.label !== 'string') {
        return { ok: false, error: 'destination.label must be a string.' };
      }
      const label = destination.label.trim().slice(0, MAX_DESTINATION_LABEL_LENGTH);
      if (label) dest.label = label;
    }
    plan.destination = dest;
  }

  let etaMs: number | null = null;
  if (etaAt !== undefined && etaAt !== null) {
    etaMs = parseIsoMs(etaAt);
    if (etaMs === null) {
      return { ok: false, error: 'etaAt must be an ISO-8601 timestamp.' };
    }
  }

  let deadlineMs: number | null = null;
  if (deadlineAt !== undefined && deadlineAt !== null) {
    deadlineMs = parseIsoMs(deadlineAt);
    if (deadlineMs === null) {
      return { ok: false, error: 'deadlineAt must be an ISO-8601 timestamp.' };
    }
  }

  // An ETA with no explicit deadline gets the default grace period, the same
  // default the mobile planner shows ("act if no word by" = ETA + 1 hr).
  if (etaMs !== null && deadlineMs === null) {
    deadlineMs = etaMs + DEFAULT_DEADLINE_GRACE_SECONDS * 1000;
  }

  if (deadlineMs !== null) {
    if (deadlineMs <= nowMs) {
      return { ok: false, error: 'deadlineAt (or etaAt plus the default grace period) is already in the past.' };
    }
    if (deadlineMs > nowMs + MAX_SESSION_MINUTES * 60 * 1000) {
      return { ok: false, error: `deadlineAt is more than ${MAX_SESSION_MINUTES / (24 * 60)} days away — refusing to create a near-immortal tracking link.` };
    }
    if (etaMs !== null && etaMs > deadlineMs) {
      return { ok: false, error: 'etaAt must not be later than deadlineAt.' };
    }
  }

  plan.etaAt = etaMs !== null ? new Date(etaMs).toISOString() : null;
  plan.deadlineAt = deadlineMs !== null ? new Date(deadlineMs).toISOString() : null;
  return { ok: true, plan };
}

/**
 * TTL provisioned at session start.
 *
 * With a deadline the session is scoped to the trip: alive until
 * deadline + window, so the guardian who checks at the deadline finds either a
 * live feed or an explicit closure — never a 404 caused by an arbitrary cap.
 * An explicit duration acts as a floor when it is longer (the rider asked for
 * at least that much sharing). Without trip fields the legacy duration
 * behaviour is unchanged.
 */
export function computeStartTtlSeconds(
  args: { durationMinutes: number | null; deadlineAtMs: number | null },
  nowMs: number,
): number {
  const durationSeconds =
    args.durationMinutes !== null ? args.durationMinutes * 60 : null;

  if (args.deadlineAtMs !== null) {
    const tripSeconds =
      Math.ceil((args.deadlineAtMs - nowMs) / 1000) + POST_END_VISIBILITY_SECONDS;
    return Math.max(tripSeconds, durationSeconds ?? 0);
  }

  return durationSeconds ?? DEFAULT_DURATION_MINUTES * 60;
}

/**
 * TTL applied when the rider closes the session (stop endpoint).
 *
 * "A set window after ride end, or after the deadline, whichever is later":
 * the closure record must survive past the guardian deadline, because that is
 * exactly when a guardian looks, and finding a 404 where "marked themselves
 * safe at 5:42 pm" should be would resurrect DEFECT-A by another route.
 */
export function computeClosureTtlSeconds(
  deadlineAtMs: number | null,
  nowMs: number,
): number {
  // A malformed stored deadline degrades to the plain post-end window; it must
  // never produce a NaN TTL that makes the closure write fail.
  const untilDeadline =
    deadlineAtMs !== null && Number.isFinite(deadlineAtMs)
      ? Math.max(0, Math.ceil((deadlineAtMs - nowMs) / 1000))
      : 0;
  return untilDeadline + POST_END_VISIBILITY_SECONDS;
}
