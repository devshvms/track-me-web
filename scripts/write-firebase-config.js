// Writes public/firebase-config.js from the FIREBASE_WEB_CONFIG env var.
// FIREBASE_WEB_CONFIG must be the JSON of the Firebase web config object, e.g.
// {"projectId":"...","appId":"...","storageBucket":"...","apiKey":"...","authDomain":"...","messagingSenderId":"...","projectNumber":"..."}
// Runs as the Vercel build command; locally it loads .env files when present.
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

const projectRoot = path.join(__dirname, "..");
const target = path.join(__dirname, "..", "public", "firebase-config.js");
const runningOnVercel = Boolean(process.env.VERCEL);
for (const envFile of [".env.local", ".env", path.join(".vercel", ".env.production.local")]) {
  const envPath = path.join(projectRoot, envFile);
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: false, quiet: true });
  }
}

const raw = process.env.FIREBASE_WEB_CONFIG;

function validateFirebaseConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return ["config object"];
  }

  const requiredFields = [
    "projectId",
    "appId",
    "storageBucket",
    "apiKey",
    "authDomain",
    "messagingSenderId",
  ];
  const placeholderPattern = /^(dummy|YOUR_|CHANGE_ME|TODO|PLACEHOLDER)/i;
  return requiredFields.filter((field) => {
    const value = config[field];
    return typeof value !== "string" || !value.trim() || placeholderPattern.test(value.trim());
  });
}

function readExistingConfig() {
  const existing = fs.readFileSync(target, "utf8");
  const match = existing.match(/window\.__FIREBASE_CONFIG__\s*=\s*({[\s\S]*?});?\s*$/);
  if (!match) {
    throw new Error("could not parse public/firebase-config.js");
  }
  return Function("\"use strict\"; return (" + match[1] + ");")();
}

if (!raw) {
  if (runningOnVercel) {
    console.error("FIREBASE_WEB_CONFIG env var is not set; cannot generate public/firebase-config.js");
    process.exit(1);
  }

  if (fs.existsSync(target)) {
    try {
      const invalidFields = validateFirebaseConfig(readExistingConfig());
      if (invalidFields.length === 0) {
        console.log("FIREBASE_WEB_CONFIG not set; keeping valid existing public/firebase-config.js");
        process.exit(0);
      }
      console.warn("FIREBASE_WEB_CONFIG not set; keeping local placeholder public/firebase-config.js with invalid fields: " + invalidFields.join(", "));
      process.exit(0);
    } catch (err) {
      console.warn("FIREBASE_WEB_CONFIG not set; keeping local public/firebase-config.js without validation:", err.message);
      process.exit(0);
    }
  }
  console.error("FIREBASE_WEB_CONFIG not set and public/firebase-config.js is missing. Copy public/firebase-config.example.js to public/firebase-config.js.");
  process.exit(1);
}

let config;
try {
  config = JSON.parse(raw);
} catch (err) {
  console.error("FIREBASE_WEB_CONFIG is not valid JSON:", err.message);
  process.exit(1);
}

const invalidFields = validateFirebaseConfig(config);
if (invalidFields.length > 0) {
  console.error("FIREBASE_WEB_CONFIG has missing or placeholder values for: " + invalidFields.join(", "));
  process.exit(1);
}

const contents =
  "// Generated at build time from FIREBASE_WEB_CONFIG. Do not edit or commit.\n" +
  "window.__FIREBASE_CONFIG__ = " + JSON.stringify(config, null, 2) + ";\n";

fs.writeFileSync(target, contents);
console.log("Wrote " + path.relative(process.cwd(), target));
