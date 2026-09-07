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
  /**
   * The newest *release* the message is true for, as a dotted marketing version ("1.8.7").
   *
   * Was `applies_to_versions_at_or_below`, a bare integer — which Android compared to `versionCode`
   * (29) and iOS to `CFBundleVersion` (7), so one broadcast could not truthfully select the same
   * release on both platforms and the admin page's own placeholder matched neither. A marketing
   * version means the same release everywhere, which is the only thing an operator is actually
   * thinking about when they write "this is fixed in 1.8.8".
   */
  applies_to_releases_at_or_below?: string;
  learn_more_url?: string;
}

/**
 * Compares two dotted release strings component-wise: -1, 0 or 1.
 *
 * Numeric per component, not lexicographic. String comparison puts "1.9.9" above "1.10.0" and would
 * silently exclude every device that most needs an update notice — the failure would look like the
 * broadcast simply reaching nobody.
 *
 * Missing components are zero, so "1.8" and "1.8.0" are the same release.
 */
export function compareReleases(left: string, right: string): number {
  const parse = (value: string) => value.split('.').map((part) => Number.parseInt(part, 10));
  const a = parse(left);
  const b = parse(right);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** A release string is dotted digits and nothing else — see the rejection note in the vectors. */
export function isValidRelease(value: string): boolean {
  return /^\d+(\.\d+)*$/.test(value);
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

  // v1's integer key is refused outright rather than accepted alongside the new one. It meant a
  // different build on each platform, so a stale admin page sending it would silently target
  // nobody — and a validator that quietly accepts a retired field never finds out it is stale.
  if (input.applies_to_versions_at_or_below !== undefined) {
    fail('applies_to_versions_at_or_below was removed. Use applies_to_releases_at_or_below, e.g. "1.8.7".');
  }

  const ceiling = input.applies_to_releases_at_or_below;
  let appliesTo: string | undefined;
  if (ceiling !== undefined && ceiling !== null && ceiling !== '') {
    if (typeof ceiling !== 'string' || !isValidRelease(ceiling)) {
      fail('applies_to_releases_at_or_below must be a dotted release like "1.8.7".');
    }
    // Release filtering exists so an update notice is TRUE for the device that receives it. On any
    // other tag it is a segmentation lever with no operational meaning, so the shape forbids it
    // rather than trusting nobody to reach for it.
    if (tag !== 'UPDATE') {
      fail('Only an UPDATE notice may be limited by release. This is not a targeting mechanism.');
    }
    appliesTo = ceiling as string;
  } else if (ceiling === '') {
    fail('applies_to_releases_at_or_below must be a dotted release like "1.8.7".');
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
    ...(appliesTo === undefined ? {} : { applies_to_releases_at_or_below: appliesTo }),
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
  if (broadcast.applies_to_releases_at_or_below !== undefined) {
    data.applies_to_releases_at_or_below = broadcast.applies_to_releases_at_or_below;
  }
  if (broadcast.learn_more_url) data.learn_more_url = broadcast.learn_more_url;
  return data;
}


/**
 * The exact message handed to FCM.
 *
 * Extracted from the endpoint so a test can assert the **request**, not just the data map. Codex's
 * review found `apns-priority: 10` paired with `apns-push-type: background`, which Apple documents
 * as an error — and no test could have caught it, because the only thing under test was
 * `toFcmData`. A wrong header here means iOS delivery fails silently in production while every
 * local test passes.
 */
export function toFcmMessage(broadcast: OperatorBroadcast, topic: string) {
  return {
    topic,
    data: toFcmData(broadcast),
    android: { priority: 'high' as const },
    apns: {
      // Priority 5 is REQUIRED for a background push. Apple rejects priority 10 with
      // `apns-push-type: background`, and the rejection is not visible from the send call — the
      // send succeeds and the device never receives anything.
      headers: { 'apns-priority': '5', 'apns-push-type': 'background' },
      payload: { aps: { 'content-available': 1 } },
    },
  };
}
