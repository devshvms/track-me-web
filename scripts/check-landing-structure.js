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
requireText("Android 1.8.1 release state", landing, /Google Play Store \(v1\.8\.1\)/);
requireText("Google Play store icon", landing, /assets\/store\/google-play-48\.png/);
requireText("App Store icon", landing, /assets\/store\/app-store-48\.png/);
requireText("clickable App Store handoff", landing, /<a[^>]*href="https:\/\/apps\.apple\.com\/app\/id6800161248"[^>]*data-download-platform="ios"/);
requireText("iOS 1.8.0 release state", landing, /Apple App Store \(v1\.8\.0\)/);
requireText("pinned Android 1.8.1 release", app, /tag_name: 'v1\.8\.1'/);
requireText("pinned iOS 1.8.0 release", app, /'track-me-ios': \[\{[\s\S]*tag_name: 'v1\.8\.0'/);
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
