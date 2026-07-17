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
# Redis (Optional: if omitted, an in-memory mock is used)
REDIS_URL=redis://localhost:6379

# PostHog Analytics
POSTHOG_API_KEY=your_posthog_api_key
POSTHOG_HOST=https://app.posthog.com

# Firebase Admin (Required for Admin endpoints)
FIREBASE_PROJECT_ID=your_project_id
FIREBASE_CLIENT_EMAIL=your_client_email
FIREBASE_PRIVATE_KEY="your_private_key_with_newlines"
```

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

- **`POST /api/track/start`**: Requires a Firebase bearer token. Body: `{ "durationMinutes": number, "username": string }`. Returns `{ "sessionId": string, "shareLink": string, "expiresAt": string }`.
- **`GET /api/track/:sessionId/location?viewerId=...`**: Public viewer heartbeat and current session state. Returns `404` after expiry and `429` when the concurrent viewer limit is reached.
- **`POST /api/track/:sessionId/location`**: Requires the session owner’s Firebase bearer token. Body includes `{ "lat": number, "lon": number, "batteryLevel": number, "speed": number, "heading": number, "timestamp": string }`.
- **`POST /api/track/:sessionId/stop`**: Requires the session owner’s Firebase bearer token. Optional body: `{ "stopReason": string }`.

### Telemetry API
- **`POST /api/telemetry/event`**
  - **Body**: `{ "event": string, "distinctId": string, "properties": object }`
  - **Description**: Proxy for tracking custom events securely.

### Admin API
- **`GET /api/admin/export-metrics`**
  - **Description**: Returns aggregate metrics about the export queue.
- **`GET /api/admin/user-search`**
  - **Description**: Look up users using Firebase Auth and Firestore.
