/**
 * SCOPE_1.8.7 §6.3 / OPERATOR_BROADCAST.md — the Class D wire contract, server side.
 *
 * The third implementation of the same shape. Android has `OperatorBroadcast.kt`, iOS has
 * `OperatorBroadcast.swift`, and all three are proved against `tests/fixtures/
 * operator-broadcast-v1.json`, which is canonical here.
 *
 * Validating on the endpoint as well as on both clients is not redundancy for its own sake. The
 * clients refuse a malformed broadcast so it cannot reach a HIGH-importance channel; the endpoint
 * refuses it so it never reaches the permanent record either. A broadcast that clients silently
 * drop but Firestore keeps is the worst of both: nobody was told, and the audit trail says somebody
 * was.
 */

export const BROADCAST_TAGS = ['UPDATE', 'MAINTENANCE', 'URGENT'] as const;
export type BroadcastTag = (typeof BROADCAST_TAGS)[number];

/** Longer than the notification shade shows is a title whose end nobody reads. */
export const MAX_TITLE_LENGTH = 80;

/** Long enough for "what is wrong, what to do, when it will be fixed". */
export const MAX_BODY_LENGTH = 480;

export interface OperatorBroadcast {
  id: string;
  tag: BroadcastTag;
  title: string;
  body: string;
  created_at_millis: number;
  applies_to_versions_at_or_below?: number;
  learn_more_url?: string;
}

export class BroadcastValidationError extends Error {}

function fail(message: string): never {
  throw new BroadcastValidationError(message);
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // Deliberately NOT accepting numeric strings here, unlike the clients. The clients have to,
  // because an FCM data payload is all strings; the endpoint receives JSON from our own admin page
  // and has no such excuse. Being lenient where you need not be is how a validator drifts into
  // accepting whatever it is sent.
  return null;
}

/**
 * Validates an operator broadcast. Throws {@link BroadcastValidationError} with a message meant for
 * the operator composing it — this is the one place in the flow where a human is present and can
 * fix the problem, so the errors say what is wrong rather than just refusing.
 */
export function parseOperatorBroadcast(raw: unknown): OperatorBroadcast {
  if (!raw || typeof raw !== 'object') fail('A broadcast body is required.');
  const input = raw as Record<string, unknown>;

  const id = typeof input.id === 'string' ? input.id.trim() : '';
  if (!id) fail('A broadcast needs an id.');

  const tag = input.tag;
  if (typeof tag !== 'string' || !(BROADCAST_TAGS as readonly string[]).includes(tag)) {
    // The closed vocabulary IS the promotional ban (§6.3). There is no OTHER and no free-form
    // category, because a rule that lives only in prose loses to a good idea on a slow month — and
    // losing that argument once makes "notification permission" stop being a sufficient basis for
    // delivering any of this.
    fail(`Tag must be one of ${BROADCAST_TAGS.join(', ')}. Nothing promotional may be sent here.`);
  }

  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title) fail('A broadcast needs a title.');
  if (title.length > MAX_TITLE_LENGTH) {
    fail(`The title is ${title.length} characters; the shade shows about ${MAX_TITLE_LENGTH}.`);
  }

  const body = typeof input.body === 'string' ? input.body.trim() : '';
  if (!body) fail('A broadcast needs a body. Say what is wrong and what the reader should do.');
  if (body.length > MAX_BODY_LENGTH) {
    fail(`The body is ${body.length} characters; the limit is ${MAX_BODY_LENGTH}.`);
  }

  const createdAt = asNumber(input.created_at_millis);
  if (createdAt === null) fail('created_at_millis must be a number.');

  const ceiling = input.applies_to_versions_at_or_below;
  let appliesTo: number | undefined;
  if (ceiling !== undefined && ceiling !== null) {
    const parsed = asNumber(ceiling);
    if (parsed === null || !Number.isInteger(parsed)) {
      fail('applies_to_versions_at_or_below must be a whole version code.');
    }
    // Version filtering exists so an update notice is TRUE for the device that receives it. On any
    // other tag it is a segmentation lever with no operational meaning, so the shape forbids it
    // rather than trusting nobody to reach for it.
    if (tag !== 'UPDATE') {
      fail('Only an UPDATE notice may be limited by version. This is not a targeting mechanism.');
    }
    appliesTo = parsed as number;
  }

  const learnMore = typeof input.learn_more_url === 'string' ? input.learn_more_url.trim() : '';
  if (learnMore && !learnMore.startsWith('https://')) {
    // Refused rather than upgraded. A link arriving over the network and opened from a
    // HIGH-importance notification is not the place to be permissive.
    fail('A learn-more link must be https.');
  }

  return {
    id,
    tag: tag as BroadcastTag,
    title,
    body,
    created_at_millis: createdAt as number,
    ...(appliesTo === undefined ? {} : { applies_to_versions_at_or_below: appliesTo }),
    ...(learnMore ? { learn_more_url: learnMore } : {}),
  };
}

/**
 * The FCM data payload. Every value is a string because FCM data payloads are string-to-string;
 * the clients' parsers accept numeric strings for exactly this reason.
 *
 * Sent as **data-only, with no `notification` block**, deliberately. A `notification` payload is
 * rendered by the system before the app sees it, which would put an unvalidated string from the
 * network straight onto a HIGH-importance channel — the clients' parsers would never run. Data-only
 * means the client validates first and posts second, which is the whole point of having three
 * implementations of the same contract.
 */
export function toFcmData(broadcast: OperatorBroadcast): Record<string, string> {
  const data: Record<string, string> = {
    id: broadcast.id,
    tag: broadcast.tag,
    title: broadcast.title,
    body: broadcast.body,
    created_at_millis: String(broadcast.created_at_millis),
  };
  if (broadcast.applies_to_versions_at_or_below !== undefined) {
    data.applies_to_versions_at_or_below = String(broadcast.applies_to_versions_at_or_below);
  }
  if (broadcast.learn_more_url) data.learn_more_url = broadcast.learn_more_url;
  return data;
}
