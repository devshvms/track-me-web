const fs = require("node:fs");
const path = require("node:path");

const publicDir = path.join(__dirname, "..", "public");
const landing = fs.readFileSync(path.join(publicDir, "index.html"), "utf8");
const app = fs.readFileSync(path.join(publicDir, "app.js"), "utf8");
const style = fs.readFileSync(path.join(publicDir, "style.css"), "utf8");
const privacy = fs.readFileSync(path.join(publicDir, "privacy.html"), "utf8");

function requireText(name, document, pattern) {
  if (!pattern.test(document)) throw new Error(`Missing ${name}`);
  process.stdout.write(`${name}: present\n`);
}

function forbidText(name, document, pattern) {
  if (pattern.test(document)) throw new Error(`Unexpected ${name}`);
  process.stdout.write(`${name}: absent\n`);
}

requireText("dependency-free landing controls", landing, /app\.js/);
requireText("Android release panel", landing, /id="android-releases"[^>]*role="tabpanel"/);
requireText("iOS release panel", landing, /id="ios-releases"[^>]*role="tabpanel"/);
// TASK-293. These two lines used to REQUIRE the internal-testing copy, which is how a claim that
// was false for over a month survived a green test suite: the guard pinned the defect instead of
// the invariant. Both apps are in production on both stores, so the assertion is now inverted.
forbidText("internal-testing claim", landing, /internal test/i);
forbidText("not-yet-available release badge", landing, /status-label status-coming/);
// Sliced, not spanned. A lazy [\s\S]*? from id="android-releases" runs straight through the
// Android block into the iOS panel's identical badge, so the assertion passed even with the
// Android badge deleted — the same "guard pins the wrong thing" failure this file just had.
const androidPanel = landing.slice(
  landing.indexOf('id="android-releases"'),
  landing.indexOf('id="ios-releases"'),
);
if (androidPanel.length < 100) throw new Error("Could not isolate the Android release panel");
requireText("Android live-in-production badge", androidPanel, /<span class="status-label status-live">Live in Production<\/span>/);
requireText("Google Play store icon", landing, /assets\/store\/google-play-48\.png/);
requireText("App Store icon", landing, /assets\/store\/app-store-48\.png/);
requireText("clickable App Store handoff", landing, /<a[^>]*href="https:\/\/apps\.apple\.com\/app\/id6800161248"[^>]*data-download-platform="ios"/);
// Version numbers in the release panels are what went stale. The panels now carry no version at
// all — the history under each tab is generated from the published releases — so the page cannot
// outrun the store by construction rather than by anyone remembering to edit a string.
forbidText("hardcoded store version in a release panel", landing, /<h3>(?:Google Play|Apple App Store)[^<]*\(v\d/);
requireText("pinned Android 1.8.6 release", app, /tag_name: 'v1\.8\.6'/);
requireText("pinned iOS 1.8.6 release", app, /'track-me-ios': \[[\s\S]*tag_name: 'v1\.8\.6'/);
// The page has claimed an unreleased build as live before, and copy that outruns the store is the
// exact failure this check exists to catch. Kept as a version-agnostic shape check so it cannot
// itself go stale.
forbidText("unsubmitted iOS availability claim in fallback", app, /'track-me-ios': \[[\s\S]*tag_name: 'v1\.8\.7'/);
forbidText("version-pinned availability claim in prose", landing, /(?:version|v)\s*\d+\.\d+\.\d+[^<]{0,40}(?:available|live|in TestFlight)/i);
// TASK-293. SOS was retired in 1.6.4/1.6.5 and SosRemovalNoticePolicy.kt exists solely to explain
// its disappearance. Marketing a deleted feature is how an install becomes a disappointed uninstall.
forbidText("retired SOS marketing", landing, /\bSOS\b|emergency|rescue/i);
forbidText("legacy showcase JPEGs", landing, /assets\/showcase\/(live-share|post-ride-reveal|weekly-recap)\.jpg/i);
// Pinning two filenames here made a rename look like a regression while a genuinely broken
// <img> would still have passed. The invariant is: the page shows several 1.8.7 showcase
// images, and every one it references actually exists. Same lesson as the two comments above.
const showcaseRefs = [...new Set(
  [...landing.matchAll(/assets\/showcase\/([a-z0-9-]+\.(?:png|webp))/g)].map((m) => m[1]),
)];
if (showcaseRefs.length < 4) {
  throw new Error(`Expected at least 4 showcase assets, found ${showcaseRefs.length}`);
}
for (const name of showcaseRefs) {
  const asset = path.join(publicDir, "assets", "showcase", name);
  if (!fs.existsSync(asset)) {
    throw new Error(`Showcase asset referenced but missing on disk: ${name}`);
  }
}
process.stdout.write(`1.8.7 showcase assets: ${showcaseRefs.length} referenced, all on disk\n`);
requireText("share/export showcase", landing, /assets\/showcase\/share-[a-z]+\.(?:png|webp)/);
forbidText("CSS merge-conflict markers", style, /^(<<<<<<<|=======|>>>>>>>)/m);
requireText("pinned release de-duplication", app, /normalizeReleaseTag/);
requireText("accessible release tab switching", app, /setupReleaseTabs[\s\S]*ArrowLeft[\s\S]*ArrowRight/);
requireText("scrollable release archive", landing, /class="release-history"/);
// The pinned fallback used to be prepended unconditionally, so a stale constant put an OLD release
// at index 0 — the row that renders expanded. Sorting by date means a stale pin can only ever be
// missing, never misleading, and this pins that behaviour so it cannot regress.
requireText("releases ordered by date, not by source", app, /sort\(\(a, b\) => new Date\(b\.published_at\) - new Date\(a\.published_at\)\)/);
requireText("privacy data inventory", privacy, /id="data-we-handle"/);
requireText("privacy service providers", privacy, /Firebase[\s\S]*PostHog/);
requireText("privacy retention and deletion", privacy, /id="retention-deletion"/);
requireText("privacy covers Android and iOS apps", privacy, /Android application[\s\S]*iOS application/);
requireText("retired SOS disclosure", privacy, /Emergency information \(retired\)/);
requireText("no Android SMS permission claim", privacy, /does not request the Android SMS permission/);
forbidText(
  "active SOS or safety-session privacy claim",
  privacy,
  /If you configure SOS|Send SOS messages|location-based SOS|ride or safety session|safety results/i,
);
