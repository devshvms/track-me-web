const fs = require("node:fs");
const path = require("node:path");

const publicDir = path.join(__dirname, "..", "public");
const landing = fs.readFileSync(path.join(publicDir, "index.html"), "utf8");
const app = fs.readFileSync(path.join(publicDir, "app.js"), "utf8");
const privacy = fs.readFileSync(path.join(publicDir, "privacy.html"), "utf8");

function requireText(name, document, pattern) {
  if (!pattern.test(document)) throw new Error(`Missing ${name}`);
  process.stdout.write(`${name}: present\n`);
}

requireText("dependency-free landing controls", landing, /app\.js/);
requireText("Android release panel", landing, /id="android-releases"[^>]*role="tabpanel"/);
requireText("iOS release panel", landing, /id="ios-releases"[^>]*role="tabpanel"/);
requireText("Android 1.7.2 release state", landing, /Google Play Store \(v1\.7\.2\)/);
requireText("Google Play store icon", landing, /assets\/store\/google-play-48\.png/);
requireText("App Store icon", landing, /assets\/store\/app-store-48\.png/);
requireText("non-clickable App Store state", landing, /class="store-tooltip"[^>]*data-tooltip="Coming soon"[^>]*aria-disabled="true"/);
requireText("iOS default release state", landing, /iOS is coming soon|iOS is in preparation|iOS preparation/);
requireText("pinned Android 1.7.2 release", app, /tag_name: 'v1\.7\.2'/);
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
