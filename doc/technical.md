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

### Track API
- **`POST /api/track/start`**
  - **Body**: `{ "durationMinutes": number, "username": string }`
  - **Description**: Initializes a new live share session.
  - **Returns**: `{ "sessionId": string, "shareLink": string, "expiresAt": string }`

### Export API
- **`POST /api/export/request`**
  - **Body**: `{ "userId": string, "userEmail": string, "clientOS": string }`
  - **Description**: Idempotent endpoint to queue an archive export.
- **`GET /api/export/status`**
  - **Query**: `?requestId=abc`
  - **Description**: Poll the status of an export.
- **`POST /api/export/process`**
  - **Description**: Triggers processing of the queued export requests.
- **`GET /api/export/download`**
  - **Query**: `?requestId=abc`
  - **Description**: Download the completed ZIP archive.

### Telemetry API
- **`POST /api/telemetry/event`**
  - **Body**: `{ "event": string, "distinctId": string, "properties": object }`
  - **Description**: Proxy for tracking custom events securely.

### Admin API
- **`GET /api/admin/export-metrics`**
  - **Description**: Returns aggregate metrics about the export queue.
- **`GET /api/admin/user-search`**
  - **Description**: Look up users using Firebase Auth and Firestore.
