/**
 * Adaptive sync cadence — §7.1.
 *
 * The client reports `moving` and `foreground`; **the server decides**. That is the single most
 * important cost control in the design (§4.3, §7.2): cadence becomes a server-side lever with no
 * client release, so we can degrade globally under load instead of failing, and every interval
 * below can be retuned from the priced cost model without shipping anything.
 *
 * Pure and fully unit-tested — no Redis, no request, no clock.
 */

/**
 * §7.2 is explicit that these must be set from real pricing rather than from what feels
 * responsive, and it ranks the levers: raise stationary and background first (cheap, barely
 * noticeable), then foreground to 15s (noticeable but acceptable), then reduce the free cap,
 * and only then reconsider SSE. Each one is separately overridable so those moves are config,
 * not code.
 */
export const FOREGROUND_MOVING_SEC = Number(process.env.GROUP_SYNC_FG_MOVING_SEC || 10);
export const BACKGROUND_MOVING_SEC = Number(process.env.GROUP_SYNC_BG_MOVING_SEC || 20);
export const STATIONARY_SEC = Number(process.env.GROUP_SYNC_STATIONARY_SEC || 60);
export const PREPARING_SEC = Number(process.env.GROUP_SYNC_PREPARING_SEC || 30);

/** Global clamp. The floor is the abuse/cost backstop; the ceiling stops a lever going silly. */
export const MIN_SYNC_SEC = Number(process.env.GROUP_SYNC_FLOOR_SEC || 5);
export const MAX_SYNC_SEC = Number(process.env.GROUP_SYNC_CEILING_SEC || 300);

/**
 * Hard floor on how often a member may *write* a position, enforced inside the sync script.
 * Well under any legitimate cadence, so it only catches a client ignoring `nextSyncInSec` —
 * sync is the dominant line in both the Vercel and Redis bills (§7.2), so an unbounded client
 * is a cost risk, not just a nuisance.
 */
export const MIN_WRITE_INTERVAL_MS = Number(process.env.GROUP_SYNC_MIN_WRITE_MS || 1000);

/**
 * How long a position survives without a refresh. §2.6: after 10 minutes a member drops off the
 * map but **stays in the roster** — "vanished" and "stopped moving" mean very different things
 * to someone waiting at a junction, and the roster is what keeps that distinction visible.
 */
export const GHOST_TTL_MS = Number(process.env.GROUP_GHOST_TTL_MS || 10 * 60 * 1000);

export interface CadenceInput {
  /** `PREPARING` overrides motion entirely — nobody is moving yet. */
  state: 'PREPARING' | 'LIVE' | 'ENDED';
  foreground: boolean;
  moving: boolean;
}

/**
 * §7.1's table, in order of precedence:
 *
 * | Member state                  | Interval |
 * |-------------------------------|----------|
 * | group is `PREPARING`          | 30s — the lobby needs a heartbeat, not a stream |
 * | stationary                    | 60s — reuses the client's own motion sensor |
 * | foreground **and** moving     | 10s — the only time a human is actually looking |
 * | backgrounded, moving          | 20s — riding with the phone pocketed |
 *
 * Stationary is checked before foreground on purpose: a phone sitting on a café table with the
 * map open is not worth 6 writes a minute, and §7.1 lists the motion sensor as the reuse.
 *
 * Group size is **not** an input, though §4.3 lists it. The free cap is 5 (D4), so any size rule
 * would be unexercised code — the exact hazard §2.9 warns about. Add it when the cap moves.
 */
export function nextSyncIntervalSec(input: CadenceInput): number {
  const raw = pick(input);
  return Math.min(MAX_SYNC_SEC, Math.max(MIN_SYNC_SEC, Math.round(raw)));
}

function pick({ state, foreground, moving }: CadenceInput): number {
  if (state === 'PREPARING') return PREPARING_SEC;
  if (!moving) return STATIONARY_SEC;
  return foreground ? FOREGROUND_MOVING_SEC : BACKGROUND_MOVING_SEC;
}

/**
 * Modelled syncs per member-hour for §7.2's blended profile (40% foreground-moving, 40%
 * background-moving, 20% stationary). Exported so the cost model in the docs is computed from
 * the same constants the server actually serves, rather than from a number typed into a table
 * once and never revisited.
 */
export function modelledSyncsPerMemberHour(): number {
  const hour = 3600;
  return (
    0.4 * (hour / FOREGROUND_MOVING_SEC)
    + 0.4 * (hour / BACKGROUND_MOVING_SEC)
    + 0.2 * (hour / STATIONARY_SEC)
  );
}
