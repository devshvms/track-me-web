import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { ALL_GROUP_SCRIPTS, assertScriptArity } from '../lib/group/store';

/**
 * Static analysis of the Lua in `lib/group/store.ts`.
 *
 * That file is the one part of Group Ride with no runtime coverage here — the scripts need a
 * live Redis and this environment has none. These are the properties that *can* be checked
 * without one, and they are checked because the Lua failure modes are silent: an out-of-range
 * `ARGV[n]` reads as `nil`, so `tonumber(nil) < x` simply never fires rather than raising
 * anything. A renumbering slip produces a capacity check that always passes, or a rate limit
 * that never triggers, with no error and no log.
 *
 * This does **not** replace the §12 Phase 1 integration pass. It replaces a class of typo.
 */

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (err) {
    failures.push(`${name}: ${(err as Error).message}`);
    process.stdout.write(`  ✗ ${name}\n`);
  }
}

/**
 * Lua line comments, removed before any structural check.
 *
 * Without this, prose counts as code: a comment containing the word "if" broke the balance
 * check, and a comment mentioning a key name would break the key-literal check. Comments in
 * these scripts carry the reasoning, so they are long and they will keep tripping naive
 * pattern matching.
 */
function code(body: string): string {
  return body.replace(/--.*$/gm, '');
}

function maxIndex(body: string, token: 'KEYS' | 'ARGV'): number {
  const matches = [...body.matchAll(new RegExp(`${token}\\[(\\d+)\\]`, 'g'))];
  return matches.reduce((max, m) => Math.max(max, Number(m[1])), 0);
}

function referencedIndexes(body: string, token: 'KEYS' | 'ARGV'): Set<number> {
  return new Set([...body.matchAll(new RegExp(`${token}\\[(\\d+)\\]`, 'g'))].map((m) => Number(m[1])));
}

test('every script declares an arity', () => {
  assert.ok(ALL_GROUP_SCRIPTS.length >= 3, 'expected create, join and sync');
  for (const s of ALL_GROUP_SCRIPTS) {
    assert.ok(s.name.startsWith('group:'), `${s.name} is not namespaced`);
    assert.ok(s.body.trim().length > 0, `${s.name} has an empty body`);
    assert.ok(s.keys > 0 && s.args > 0, `${s.name} declares a zero arity`);
  }
});

for (const script of ALL_GROUP_SCRIPTS) {
  test(`${script.name}: declared key count matches the highest KEYS[n] used`, () => {
    assert.strictEqual(
      maxIndex(code(script.body), 'KEYS'),
      script.keys,
      'declared keys and the body disagree — one of them was edited without the other',
    );
  });

  test(`${script.name}: declared arg count matches the highest ARGV[n] used`, () => {
    assert.strictEqual(
      maxIndex(code(script.body), 'ARGV'),
      script.args,
      'declared args and the body disagree — this is the silent-nil bug',
    );
  });

  test(`${script.name}: no declared key or arg is left unread`, () => {
    // A gap means either a caller is passing something nothing reads, or an index was skipped
    // when renumbering — and the second one shifts every argument after it.
    for (const token of ['KEYS', 'ARGV'] as const) {
      const used = referencedIndexes(code(script.body), token);
      const count = token === 'KEYS' ? script.keys : script.args;
      for (let i = 1; i <= count; i++) {
        assert.ok(used.has(i), `${token}[${i}] is declared but never read`);
      }
    }
  });

  test(`${script.name}: uses no zero index`, () => {
    // Lua is 1-indexed. KEYS[0]/ARGV[0] is always nil and never an error.
    assert.ok(!/KEYS\[0\]|ARGV\[0\]/.test(code(script.body)), 'zero index in a 1-indexed language');
  });

  test(`${script.name}: if/end are balanced`, () => {
    const body = code(script.body);
    const opens = (body.match(/\bif\b/g) || []).length + (body.match(/\bfor\b/g) || []).length;
    const ends = (body.match(/\bend\b/g) || []).length;
    assert.strictEqual(ends, opens, `${opens} if/for vs ${ends} end`);
  });

  test(`${script.name}: every redis.call names a known command`, () => {
    // Catches a typo'd command name, which Redis only reports at execution time.
    const known = new Set([
      'GET', 'SET', 'DEL', 'EXISTS', 'INCR',
      'HGET', 'HSET', 'HDEL', 'HLEN', 'HEXISTS', 'HGETALL',
      'EXPIRE', 'PEXPIRE', 'PEXPIREAT', 'PTTL', 'TTL',
    ]);
    for (const m of code(script.body).matchAll(/redis\.call\('([A-Z]+)'/g)) {
      assert.ok(known.has(m[1]), `unknown command "${m[1]}"`);
    }
  });

  test(`${script.name}: every key it touches is one the caller passed`, () => {
    // A key built inside Lua would be invisible to Redis Cluster's slot routing and, more
    // immediately here, would escape `allGroupKeys` — so it would survive the DEL at group end
    // and break §10's "no key matching group:* remains".
    assert.ok(
      !/redis\.call\('[A-Z]+',\s*['"]group:/.test(code(script.body)),
      'script builds a key literal instead of taking it in KEYS',
    );
  });
}

test('sync writes a position only when one was supplied', () => {
  // §8: when location permission is revoked mid-session the member stays in the group as a
  // viewer. The script must treat an empty position as "nothing to write", not as a write of
  // an empty value, which would show every other member a marker that decrypts to nothing.
  const sync = ALL_GROUP_SCRIPTS.find((s) => s.name === 'group:sync')!;
  assert.match(code(sync.body), /if ARGV\[2\] ~= ''/, 'sync unconditionally writes the position field');
});

test('sync keeps the original timestamp when the envelope is byte-identical', () => {
  // A34, and the fix for the §6.3 defect that predates 1.7.2: the client sets pendingPosition per
  // location callback and never clears it after a send, so a device whose GPS has frozen resends
  // the SAME ciphertext every sync. Re-stamping it made that member look permanently fresh — a
  // bright marker and "8s ago" for a position twenty minutes old.
  //
  // Envelopes are sealed per callback with a random nonce, so identical bytes can only mean no new
  // fix arrived. Keeping prevTs is the honest answer.
  const body = code(ALL_GROUP_SCRIPTS.find((s) => s.name === 'group:sync')!.body);
  assert.ok(
    /previous\s*==\s*incoming/.test(body),
    'sync must compare the stored envelope with the incoming one',
  );
  assert.ok(
    /tostring\(prevTs\)/.test(body),
    'sync must re-write the ORIGINAL timestamp on an identical resend, not now',
  );
});

test('sync returns its own clock so clients never anchor ages to their own', () => {
  // A32. 1.7.0 compared a relay timestamp against the receiver's System.currentTimeMillis(), so a
  // phone five minutes behind showed the whole group as fresher than it was.
  const body = code(ALL_GROUP_SCRIPTS.find((s) => s.name === 'group:sync')!.body);
  assert.ok(/tostring\(now\)/.test(body), 'sync must return its own now');
});

test('sync processes the status slot independently of the position', () => {
  // §4.7, and the reason E6 stopped claiming "no backend changes": a rider whose location
  // permission is revoked is precisely the one most likely to need the alert tier.
  const body = code(ALL_GROUP_SCRIPTS.find((s) => s.name === 'group:sync')!.body);
  const statusBlock = body.slice(body.indexOf('statusOp'));
  assert.ok(statusBlock.length > 0, 'sync must handle statusOp');
  // The status write must not be nested inside the `if ARGV[2] ~= ''` position guard.
  const posGuard = body.indexOf("if ARGV[2] ~= ''");
  const statusGuard = body.indexOf('local statusOp');
  assert.ok(
    statusGuard > posGuard,
    'the status block must be a sibling of the position block, not inside it',
  );
  assert.ok(/HDEL', KEYS\[5\]/.test(body), 'clear must delete from the status key');
});

test('the status key expires with the group, like the position key', () => {
  // §4.7: a status dies with the group exactly like everything else.
  const body = code(ALL_GROUP_SCRIPTS.find((s) => s.name === 'group:sync')!.body);
  assert.ok(/PEXPIRE', KEYS\[5\]/.test(body), 'the status key must be given the group TTL');
});

test('sync checks membership before it reads anything', () => {
  // §5.2, "departed member keeps polling": authorisation is the enforcement point, and it has
  // to run before the group's positions are read, not after.
  const sync = ALL_GROUP_SCRIPTS.find((s) => s.name === 'group:sync')!;
  const authAt = code(sync.body).indexOf('HEXISTS');
  const readAt = code(sync.body).indexOf('HGETALL');
  assert.ok(authAt > 0 && readAt > authAt, 'positions are read before membership is verified');
});

test('join checks capacity before it writes', () => {
  const join = ALL_GROUP_SCRIPTS.find((s) => s.name === 'group:join')!;
  const capacityAt = code(join.body).indexOf('HLEN');
  const writeAt = code(join.body).indexOf('HSET');
  assert.ok(capacityAt > 0 && writeAt > capacityAt, 'member is written before capacity is checked');
});

test('create refuses to overwrite an existing token or code key', () => {
  // Without both EXISTS guards, a colliding create would silently repoint someone else's invite
  // at a new group.
  const create = ALL_GROUP_SCRIPTS.find((s) => s.name === 'group:create')!;
  assert.match(code(create.body), /EXISTS', KEYS\[4\]/, 'no guard on the token key');
  assert.match(code(create.body), /EXISTS', KEYS\[5\]/, 'no guard on the code key');
});

test('every key a script writes gets an expiry in the same script', () => {
  // §5.1.5, nothing outlives the session. A key written without an expiry is a group that never
  // ends, which is the one failure this feature cannot have.
  for (const script of ALL_GROUP_SCRIPTS) {
    const written = new Set<number>();
    for (const m of code(script.body).matchAll(/redis\.call\('(SET|HSET|INCR)',\s*KEYS\[(\d+)\]/g)) {
      written.add(Number(m[2]));
    }
    const expired = new Set<number>();
    for (const m of code(script.body).matchAll(/redis\.call\('(PEXPIREAT|PEXPIRE|EXPIRE)',\s*KEYS\[(\d+)\]/g)) {
      expired.add(Number(m[2]));
    }
    for (const k of written) {
      assert.ok(expired.has(k), `${script.name}: KEYS[${k}] is written but never given an expiry`);
    }
  }
});

// --- The runtime guard itself ---

test('leave deletes every group key when the last member goes', () => {
  // §5.1.5, nothing outlives the session. An empty group is not a group, and waiting for the TTL
  // would leave real session state alive for hours after the last person left.
  const leave = ALL_GROUP_SCRIPTS.find((s) => s.name === 'group:leave')!;
  const del = code(leave.body).match(/redis\.call\('DEL'[^)]*\)/);
  assert.ok(del, 'leave never deletes the group');
  for (let i = 1; i <= leave.keys; i++) {
    assert.ok(del![0].includes(`KEYS[${i}]`), `DEL omits KEYS[${i}] — that key would survive`);
  }
});

test('leave removes the position as well as the membership', () => {
  // Leaving must not leave a marker on everyone else's map. §5.1.3.
  const leave = ALL_GROUP_SCRIPTS.find((s) => s.name === 'group:leave')!;
  const body = code(leave.body);
  assert.match(body, /HDEL', KEYS\[2\]/, 'membership is not removed');
  assert.match(body, /HDEL', KEYS\[4\]/, 'position is not removed');
});

test('the state swap re-applies the TTL it just cleared', () => {
  // Redis SET drops a key's expiry. Without the PTTL/PEXPIRE pair, "Start group" would turn a
  // 4-hour session into a permanent one — §5.1.2 broken invisibly.
  const state = ALL_GROUP_SCRIPTS.find((s) => s.name === 'group:state')!;
  const body = code(state.body);
  const setAt = body.indexOf("call('SET'");
  const ttlAt = body.indexOf("call('PTTL'");
  const expireAt = body.indexOf("call('PEXPIRE'");
  assert.ok(ttlAt > 0 && ttlAt < setAt, 'TTL is read after the SET has already cleared it');
  assert.ok(expireAt > setAt, 'expiry is never re-applied after the SET');
});

test('the state swap is a compare-and-swap, not a blind write', () => {
  const state = ALL_GROUP_SCRIPTS.find((s) => s.name === 'group:state')!;
  assert.match(code(state.body), /if current ~= ARGV\[1\] then/, 'no CAS guard on the record');
});

// --- §5.1.3: the exit is sacred and silent ---

test('the leave route emits nothing to other members', () => {
  // The single most important line in the spec: a person who needs to go dark must be able to,
  // without escalation. §5.1.3 says outright that POST /api/group/leave must never gain a
  // broadcast, and names "engagement reasons" as the argument that will eventually be made for
  // adding one.
  //
  // So this reads the handler source. It is a blunt test, deliberately: a reviewer can miss a
  // push call added to a 400-line route file, and by the time anyone notices, the harm has
  // already reached the person the invariant exists to protect.
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'api', 'group', '[...action].ts'),
    'utf8',
  );
  const start = source.indexOf('async function handleLeave');
  assert.ok(start > 0, 'handleLeave not found — did the route move?');
  const end = source.indexOf('\n// ---', start);
  const handler = source.slice(start, end > start ? end : undefined);

  for (const forbidden of [
    'sendNotification', 'notify', 'fcm', 'FCM', 'push(', 'broadcast',
    'sendEmail', 'webhook', 'messaging',
  ]) {
    assert.ok(
      !handler.includes(forbidden),
      `handleLeave references "${forbidden}" — leaving must notify nobody (§5.1.3)`,
    );
  }

  // The response body must say only what happened to the caller. Returning a roster or a member
  // count would let a departing client hand the group information on its way out.
  const returned = handler.match(/response\.status\(200\)\.json\(\{[^}]*\}/g) || [];
  assert.ok(returned.length > 0, 'no 200 response found in handleLeave');
  for (const body of returned) {
    for (const leak of ['roster', 'positions', 'memberCount', 'members']) {
      assert.ok(!body.includes(leak), `leave response exposes "${leak}"`);
    }
  }
});

test('assertScriptArity rejects a caller passing the wrong number of keys or args', () => {
  const script = ALL_GROUP_SCRIPTS[0];
  const keys = new Array(script.keys).fill('k');
  const args = new Array(script.args).fill('a');
  assert.doesNotThrow(() => assertScriptArity(script, keys, args));
  assert.throws(() => assertScriptArity(script, keys.slice(1), args), /declared/);
  assert.throws(() => assertScriptArity(script, keys, args.slice(1)), /declared/);
  assert.throws(() => assertScriptArity(script, [...keys, 'extra'], args), /declared/);
});

process.stdout.write(`\ngroup-store-scripts: ${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) {
  for (const f of failures) process.stderr.write(`  - ${f}\n`);
  process.exit(1);
}
