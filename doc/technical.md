# Technical Documentation

## Setup & Local Development

### Prerequisites
- Node.js (v18+)
- Vercel CLI (optional, but recommended for local testing)
- Redis instance (optional, system falls back to mock memory store)

### Installation
```bash
npm install
```

### Environment Variables
Create a `.env` file in the root directory:
```env
# Redis. Point this at a real, reachable Redis instance (e.g. Upstash).
# See the warning below before copying any value here.
REDIS_URL=rediss://default:<password>@<host>:<port>

# PostHog Analytics
POSTHOG_API_KEY=your_posthog_api_key
POSTHOG_HOST=https://app.posthog.com

# Firebase Admin (Required for Admin endpoints)
FIREBASE_PROJECT_ID=your_project_id
FIREBASE_CLIENT_EMAIL=your_client_email
FIREBASE_PRIVATE_KEY="your_private_key_with_newlines"
```

> **`REDIS_URL` is load-bearing for live share, and two values silently disable it.**
> `lib/redis.ts` falls back to an in-memory mock when `REDIS_URL` is unset **and** when it is
> exactly `redis://localhost:6379` — the latter is special-cased because a serverless function
> cannot reach localhost. The mock store lives inside a single serverless instance, is not
> shared between instances, disappears on cold start, and has **no TTL**. Live-share sessions
> written to it can vanish or freeze a viewer's map pin.
>
> Every fallback path now logs a one-off `[redis] DEGRADED: ...` warning at startup. If you see
> that line in a deployment's logs, live share is not durable there. Locally the mock is fine —
> just leave `REDIS_URL` unset rather than pointing it at localhost, so the log says why.

### Running Locally
Using Vercel CLI to emulate the serverless environment:
```bash
vercel dev
```

## Directory Structure
```
├── api/                  # Vercel Serverless Functions (Routes)
│   ├── admin/            # Admin endpoints (Metrics, User Search)
│   ├── export/           # Data export pipeline endpoints
│   ├── telemetry/        # PostHog proxy and stats endpoints
│   └── track/            # Session initialization and tracking
├── lib/                  # Shared libraries and utilities
│   ├── firebase.ts       # Firebase Admin initialization
│   ├── posthog.ts        # PostHog SDK wrapper
│   └── redis.ts          # Redis client and in-memory mock fallback
├── doc/                  # Documentation
├── package.json          # Dependencies and scripts
└── vercel.json           # Vercel deployment configuration
```

## API Reference

The complete, client-ready contract is in [API Contract](api.md). It is the source of truth for authentication, request and response JSON, error handling, export lifecycle, and the Android download flow.

The important export rule is that `/api/export/request` and `/api/export/status` require `Authorization: Bearer <Firebase ID token>`. The completed `downloadUrl` includes a short-lived `token` query parameter so Android `DownloadManager` can download the ZIP, because `DownloadManager` cannot add a bearer header. Do not reconstruct or remove that URL parameter.

### Track API

- **`POST /api/track/start`**: Requires a Firebase bearer token. Body: `{ "durationMinutes": number, "username": string }` plus optional trip fields `{ "destination": { "lat": number, "lng": number, "label"?: string }, "etaAt": ISO-8601, "deadlineAt": ISO-8601 }`. Returns `{ "sessionId": string, "shareLink": string, "expiresAt": string, "etaAt": string|null, "deadlineAt": string|null }`.
  - **Expiry is trip-scoped, not capped at 24 h.** With a `deadlineAt` (or an `etaAt`, which defaults the deadline to ETA + 1 h), the session lives until `deadlineAt` + a 2-hour visibility window; an explicit `durationMinutes` acts as a floor if longer. Without trip fields the legacy duration behaviour is unchanged (default 1440 minutes). The only ceiling is a 7-day sanity guard against typo-immortal links. When the rider stops the session, its remaining lifetime is re-scoped to 2 hours after the stop — or through `deadlineAt` + 2 h if that is later, so a guardian checking at the deadline always finds the closure state rather than a 404.
- **`GET /api/track/:sessionId/location?viewerId=...`**: Public viewer heartbeat and current session state. Returns `404` after expiry and `429` when the concurrent viewer limit is reached.
- **`POST /api/track/:sessionId/location`**: Requires the session owner’s Firebase bearer token. Body includes `{ "lat": number, "lon": number, "batteryLevel": number, "speed": number, "heading": number, "timestamp": string }`. Returns `503` when the update could not be stored and `404` if the session expired mid-request. **`200 {success:true}` means the update was persisted — clients may rely on that**; it is never returned for a discarded write.
- **`POST /api/track/:sessionId/stop`**: Requires the session owner’s Firebase bearer token. Optional body: `{ "endReason": "marked_safe" | "ride_ended" | "expired", "stopReason": string }`. `endReason` is what the viewer renders; an absent or unrecognised value is recorded as `ride_ended`, and nothing is ever inferred as `marked_safe`. `stopReason` is the legacy free-form field, retained for telemetry only. Returns `503` if the closure could not be stored.

### Telemetry API
- **`POST /api/telemetry/event`**
  - **Body**: `{ "event": string, "distinctId": string, "properties": object }`
  - **Description**: Proxy for tracking custom events securely.

### Admin API
- **`GET /api/admin/export-metrics`**
  - **Description**: Returns aggregate metrics about the export queue.
- **`GET /api/admin/user-search`**
  - **Description**: Look up users using Firebase Auth and Firestore.
