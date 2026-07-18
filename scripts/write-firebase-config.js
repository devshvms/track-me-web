// Writes public/firebase-config.js from the FIREBASE_WEB_CONFIG env var.
// FIREBASE_WEB_CONFIG must be the JSON of the Firebase web config object, e.g.
// {"projectId":"...","appId":"...","storageBucket":"...","apiKey":"...","authDomain":"...","messagingSenderId":"...","projectNumber":"..."}
// Runs as the Vercel build command; locally you can copy
// public/firebase-config.example.js instead.
const fs = require("fs");
const path = require("path");

const target = path.join(__dirname, "..", "public", "firebase-config.js");
const raw = process.env.FIREBASE_WEB_CONFIG;

if (!raw) {
  if (process.env.VERCEL) {
    console.error("FIREBASE_WEB_CONFIG env var is not set; cannot generate public/firebase-config.js");
    process.exit(1);
  }
  if (fs.existsSync(target)) {
    console.log("FIREBASE_WEB_CONFIG not set; keeping existing public/firebase-config.js");
    process.exit(0);
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

const contents =
  "// Generated at build time from FIREBASE_WEB_CONFIG. Do not edit or commit.\n" +
  "window.__FIREBASE_CONFIG__ = " + JSON.stringify(config, null, 2) + ";\n";

fs.writeFileSync(target, contents);
console.log("Wrote " + path.relative(process.cwd(), target));
