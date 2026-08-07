import assert from 'node:assert';
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
      maxIndex(script.body, 'KEYS'),
      script.keys,
      'declared keys and the body disagree — one of them was edited without the other',
    );
  });

  test(`${script.name}: declared arg count matches the highest ARGV[n] used`, () => {
    assert.strictEqual(
      maxIndex(script.body, 'ARGV'),
      script.args,
      'declared args and the body disagree — this is the silent-nil bug',
    );
  });

  test(`${script.name}: no declared key or arg is left unread`, () => {
    // A gap means either a caller is passing something nothing reads, or an index was skipped
    // when renumbering — and the second one shifts every argument after it.
    for (const token of ['KEYS', 'ARGV'] as const) {
      const used = referencedIndexes(script.body, token);
      const count = token === 'KEYS' ? script.keys : script.args;
      for (let i = 1; i <= count; i++) {
        assert.ok(used.has(i), `${token}[${i}] is declared but never read`);
      }
    }
  });

  test(`${script.name}: uses no zero index`, () => {
    // Lua is 1-indexed. KEYS[0]/ARGV[0] is always nil and never an error.
    assert.ok(!/KEYS\[0\]|ARGV\[0\]/.test(script.body), 'zero index in a 1-indexed language');
  });

  test(`${script.name}: if/end are balanced`, () => {
    const opens = (script.body.match(/\bif\b/g) || []).length
      + (script.body.match(/\bfor\b/g) || []).length;
    const ends = (script.body.match(/\bend\b/g) || []).length;
    assert.strictEqual(ends, opens, `${opens} if/for vs ${ends} end`);
  });

  test(`${script.name}: every redis.call names a known command`, () => {
    // Catches a typo'd command name, which Redis only reports at execution time.
    const known = new Set([
      'GET', 'SET', 'DEL', 'EXISTS', 'INCR',
      'HGET', 'HSET', 'HDEL', 'HLEN', 'HEXISTS', 'HGETALL',
      'EXPIRE', 'PEXPIRE', 'PEXPIREAT', 'PTTL', 'TTL',
    ]);
    for (const m of script.body.matchAll(/redis\.call\('([A-Z]+)'/g)) {
      assert.ok(known.has(m[1]), `unknown command "${m[1]}"`);
    }
  });

  test(`${script.name}: every key it touches is one the caller passed`, () => {
    // A key built inside Lua would be invisible to Redis Cluster's slot routing and, more
    // immediately here, would escape `allGroupKeys` — so it would survive the DEL at group end
    // and break §10's "no key matching group:* remains".
    assert.ok(
      !/redis\.call\('[A-Z]+',\s*['"]group:/.test(script.body),
      'script builds a key literal instead of taking it in KEYS',
    );
  });
}

test('sync writes a position only when one was supplied', () => {
  // §8: when location permission is revoked mid-session the member stays in the group as a
  // viewer. The script must treat an empty position as "nothing to write", not as a write of
  // an empty value, which would show every other member a marker that decrypts to nothing.
  const sync = ALL_GROUP_SCRIPTS.find((s) => s.name === 'group:sync')!;
  assert.match(sync.body, /if ARGV\[2\] ~= ''/, 'sync unconditionally writes the position field');
});

test('sync checks membership before it reads anything', () => {
  // §5.2, "departed member keeps polling": authorisation is the enforcement point, and it has
  // to run before the group's positions are read, not after.
  const sync = ALL_GROUP_SCRIPTS.find((s) => s.name === 'group:sync')!;
  const authAt = sync.body.indexOf('HEXISTS');
  const readAt = sync.body.indexOf('HGETALL');
  assert.ok(authAt > 0 && readAt > authAt, 'positions are read before membership is verified');
});

test('join checks capacity before it writes', () => {
  const join = ALL_GROUP_SCRIPTS.find((s) => s.name === 'group:join')!;
  const capacityAt = join.body.indexOf('HLEN');
  const writeAt = join.body.indexOf("HSET");
  assert.ok(capacityAt > 0 && writeAt > capacityAt, 'member is written before capacity is checked');
});

test('create refuses to overwrite an existing token or code key', () => {
  // Without both EXISTS guards, a colliding create would silently repoint someone else's invite
  // at a new group.
  const create = ALL_GROUP_SCRIPTS.find((s) => s.name === 'group:create')!;
  assert.match(create.body, /EXISTS', KEYS\[4\]/, 'no guard on the token key');
  assert.match(create.body, /EXISTS', KEYS\[5\]/, 'no guard on the code key');
});

test('every key a script writes gets an expiry in the same script', () => {
  // §5.1.5, nothing outlives the session. A key written without an expiry is a group that never
  // ends, which is the one failure this feature cannot have.
  for (const script of ALL_GROUP_SCRIPTS) {
    const written = new Set<number>();
    for (const m of script.body.matchAll(/redis\.call\('(SET|HSET|INCR)',\s*KEYS\[(\d+)\]/g)) {
      written.add(Number(m[2]));
    }
    const expired = new Set<number>();
    for (const m of script.body.matchAll(/redis\.call\('(PEXPIREAT|PEXPIRE|EXPIRE)',\s*KEYS\[(\d+)\]/g)) {
      expired.add(Number(m[2]));
    }
    for (const k of written) {
      assert.ok(expired.has(k), `${script.name}: KEYS[${k}] is written but never given an expiry`);
    }
  }
});

// --- The runtime guard itself ---

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
