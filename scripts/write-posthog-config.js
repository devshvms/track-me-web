// Writes public/posthog-config.js from the POSTHOG_DASHBOARD_URL env var.
// POSTHOG_DASHBOARD_URL must be the public shared PostHog dashboard URL.
// Runs as part of the Vercel build command; locally the dashboard is optional.
const fs = require("fs");
const path = require("path");

const target = path.join(__dirname, "..", "public", "posthog-config.js");
const raw = process.env.POSTHOG_DASHBOARD_URL;

if (!raw) {
  if (process.env.VERCEL) {
    console.error("POSTHOG_DASHBOARD_URL env var is not set; cannot generate public/posthog-config.js");
    process.exit(1);
  }
  if (fs.existsSync(target)) {
    console.log("POSTHOG_DASHBOARD_URL not set; keeping existing public/posthog-config.js");
    process.exit(0);
  }

  const contents =
    "// Generated at build time from POSTHOG_DASHBOARD_URL. Do not edit or commit.\n" +
    "window.__POSTHOG_DASHBOARD_URL__ = null;\n";

  fs.writeFileSync(target, contents);
  console.log("Wrote " + path.relative(process.cwd(), target));
  process.exit(0);
}

const contents =
  "// Generated at build time from POSTHOG_DASHBOARD_URL. Do not edit or commit.\n" +
  "window.__POSTHOG_DASHBOARD_URL__ = " + JSON.stringify(raw) + ";\n";

fs.writeFileSync(target, contents);
console.log("Wrote " + path.relative(process.cwd(), target));
