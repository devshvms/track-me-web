# TrackMe Web & API 🌐 (v1.7.0)

`track-me-web` is the Vercel-hosted web platform, serverless backend, live-share viewer, data export service, and zero-knowledge Group Ride relay for TrackMe.

## 🌟 Core Features

- **End-to-End Encrypted (E2EE) Group Ride Relay (v1.7.0):** Stateless, zero-knowledge relay for group ride location sync and presence (`/api/group/*`). Payloads are encrypted client-side using AES-GCM-256 with 128-bit fragment keys (`#k=...`).
- **Live Share Web Viewer:** Polling and rendering live ride progress (`/live/:sessionId` -> `public/tracker.html`).
- **Archive Export Service:** Tokenized zip export (`/api/export/*`) streaming user ride data and GPX traces.
- **Privacy & Transparency Surface:** Comprehensive privacy documentation (`public/privacy.html`), group ride landing pages (`public/group.html`), and telemetry proxy (`/api/telemetry/*`).

## 🛠️ Stack & Infrastructure

- **Framework:** Node.js, TypeScript, Vercel Serverless Functions
- **Data & Caching:** Redis (session TTLs, roster state, presence counters), Firebase Admin SDK (auth, Firestore read/write)
- **Testing:** Comprehensive unit and integration test suite (`npm test`)

## 🚀 Development & Testing

```bash
npm install
npm test
```
