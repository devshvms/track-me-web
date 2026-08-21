/**
 * Structure guard for `public/group.html`, in the spirit of `check-landing-structure.js`.
 *
 * The invite page is the first thing a non-user ever sees of TrackMe (§2.4 — the join link *is*
 * the install event), and it carries privacy properties that are invisible when they break: a
 * missing `noindex` publishes invites to search engines, a missing `no-referrer` leaks the
 * fragment token to whatever the user clicks next, and a destination rendered here would put
 * someone's home address in front of anyone the invite was forwarded to (§2.9).
 *
 * None of those show up as a broken-looking page, which is exactly why they need a guard.
 */

const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'public', 'group.html');
const html = fs.readFileSync(file, 'utf8');

/**
 * Comments stripped before any "this must NOT appear" check.
 *
 * The comments in this page explain *why* things are absent — the §2.9 note says the word
 * "destination" out loud — so matching against them makes a correct page fail. Same trap the Lua
 * script guard hit: prose is not code.
 */
const body = html.replace(/<!--[\s\S]*?-->/g, '');

let failures = 0;

function require_(name, pattern) {
  const ok = pattern instanceof RegExp ? pattern.test(html) : html.includes(pattern);
  process.stdout.write(`  ${ok ? '✓' : '✗'} ${name}\n`);
  if (!ok) failures++;
}

function forbid(name, pattern) {
  const hit = pattern instanceof RegExp ? pattern.test(body) : body.includes(pattern);
  process.stdout.write(`  ${hit ? '✗' : '✓'} ${name}\n`);
  if (hit) failures++;
}

process.stdout.write('group.html structure\n');

// --- Privacy properties, none of which are visible when broken ---
require_('noindex — invites must never be indexed', /<meta\s+name="robots"\s+content="noindex/i);
require_('no-referrer — the fragment token must not leak onward', /<meta\s+name="referrer"\s+content="no-referrer"/i);
require_('the token is read from the fragment, never the query string', 'tokenFromFragment(location.hash)');
require_('resolve is called with the token HASH, not the token', /resolve\?t=\$\{encodeURIComponent\(hash\)\}/);
forbid('the raw token is never put in a URL', /resolve\?t=\$\{encodeURIComponent\(token\)/);

// §2.9: a destination is a strong personal signal and is suppressed here entirely.
forbid('no destination is rendered', /destination|\bdestName\b|arrivalAt/i);

// --- The page has to actually do its job ---
require_('leads with the group name, not the app', /id="headline"/);
require_('shows how many people are in it', /id="liveText"/);
require_('shows the join code — the only way in without App Links', /id="joinCode"/);
require_('has a Play Store handoff', /play\.google\.com\/store\/apps\/details\?id=in\.shvms\.trackme/);
require_('has an App Store handoff', /apps\.apple\.com\/app\/id6800161248/);
require_('opens installed iOS app with the invite token', /trackme:\/\/group\?\$\{params\.toString\(\)\}/);
require_('tells the user where to enter the code', /Join with a code/);
require_('states the privacy promise in plain language', /You can leave at any time and nobody is\s+told/);

// --- Self-contained and cheap (§4.8: Lighthouse 95+, <500 KB, zero framework) ---
forbid('no third-party script or stylesheet', /(src|href)="https?:\/\/(?!play\.google|apps\.apple)/);
require_('loads only the local crypto module', /from '\/js\/group-crypto\.mjs'/);

const bytes = Buffer.byteLength(html, 'utf8');
const ok = bytes < 24 * 1024;
process.stdout.write(`  ${ok ? '✓' : '✗'} page is ${(bytes / 1024).toFixed(1)} KB (budget 24 KB)\n`);
if (!ok) failures++;

// --- The rewrite has to exist or the link 404s ---
const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
const rewrites = vercel.rewrites || [];
// `/g/` is the path the browser actually requests for the canonical `/g/#<token>` share link —
// a fragment is never sent. `/g/:token` does not match it and `/g` does not either, so the
// trailing-slash form needs `:path*` or the entire growth loop 404s. Found in production.
for (const source of ['/g', '/g/', '/g/:path*']) {
  const found = rewrites.some((r) => r.source === source && r.destination === '/group.html');
  process.stdout.write(`  ${found ? '✓' : '✗'} vercel.json rewrites ${source} → /group.html\n`);
  if (!found) failures++;
}

if (failures > 0) {
  process.stderr.write(`\ngroup.html: ${failures} check(s) failed\n`);
  process.exit(1);
}
process.stdout.write('\ngroup.html: all checks passed\n');
