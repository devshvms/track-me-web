const fs = require("node:fs");
const path = require("node:path");

const publicDir = path.join(__dirname, "..", "public");
const landing = fs.readFileSync(path.join(publicDir, "index_v2.html"), "utf8");
const privacy = fs.readFileSync(path.join(publicDir, "privacy.html"), "utf8");

function requireText(name, document, pattern) {
  if (!pattern.test(document)) throw new Error(`Missing ${name}`);
  process.stdout.write(`${name}: present\n`);
}

requireText("dependency-free landing controls", landing, /landing_v2\.js/);
requireText("Android release panel", landing, /id="android-releases"[^>]*role="tabpanel"/);
requireText("iOS release panel", landing, /id="ios-releases"[^>]*role="tabpanel"/);
requireText("iOS default release state", landing, /No public iOS release yet/);
requireText("scrollable release archive", landing, /class="release-history"[^>]*tabindex="0"/);
requireText("auth availability status", landing, /id="site-status"[^>]*aria-live="polite"/);
requireText("privacy data inventory", privacy, /id="data-we-handle"/);
requireText("privacy service providers", privacy, /Firebase[\s\S]*PostHog/);
requireText("privacy retention and deletion", privacy, /id="retention-deletion"/);
