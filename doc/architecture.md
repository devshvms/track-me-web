# System Architecture

## High-Level Overview
The system is built on a serverless architecture designed to run on Vercel. It leverages ephemeral compute functions backed by a high-performance Redis cache for state management and Firebase for administrative persistent storage.

## Technology Stack
- **Compute**: Vercel Serverless Functions (Node.js/TypeScript)
- **Primary Data Store**: Redis (Upstash or standard Redis instance). Includes a local in-memory fallback for development.
- **Analytics Engine**: PostHog Node SDK.
- **Archive Processing**: `archiver` streams ZIP output directly to the Vercel response to avoid buffering the archive in memory. Mid-stream failure handling uses an `EXPORT_FAILED.txt` marker and remains a runtime review gate.
- **Persistent Storage / Auth**: Firebase Admin SDK (Firestore, Auth).

## Component Architecture

### 1. API Layer (`/api`)
The entry point consists of RESTful endpoints organized by domain:
- `/api/track`: Handles real-time live-share session initialization and management.
- `/api/export`: Creates export metadata and serves a generated archive on demand.
- `/api/telemetry`: Proxies tracking events to PostHog and computes real-time aggregates.
- `/api/admin`: Administrative endpoints for metrics and user lookup.

### 2. Data Store Layer (Redis)
Redis is strictly used as a fast, TTL-based KV store for:
- **Sessions**: Stored as `session:{sessionId}` with a TTL mapping to the duration requested by the user.
- **Export Queue**: Sorted sets (`export:queue`) and KV pairs (`export:request:{id}`, `export:user:{id}`) handle the export state machine.
- **Analytics Aggregates**: Counters (`stats:total_shares`) and rolling windows using Sorted Sets (`stats:shares_24h` where score is timestamp).

### 3. Export Lifecycle
1. **Request (`/api/export/request`)**: Client authenticates with a Firebase ID token. Redis stores a completed export record and a random download capability token. The operation is intentionally synchronous at the metadata level.
2. **Status (`/api/export/status`)**: Client may retrieve the completed record with a Firebase ID token. Repeated requests are idempotent for the same user while the record is retained.
3. **Download (`/api/export/download`)**: Client uses the exact tokenized `downloadUrl` returned by request/status. The server reads the requesting user’s Firestore profile and emergency configuration before sending headers, then streams ride documents and GPX entries through `archiver`. If ride iteration fails after headers, it appends `EXPORT_FAILED.txt`, skips the six-hour retention marker, and finalizes the response; clients must reject that incomplete result. This behavior requires runtime validation before production approval.

## Security & Privacy Considerations
- **No Long-Term Session State**: All live-share sessions auto-expire via Redis TTLs, preventing "zombie" share links.
- **Idempotency**: Export request endpoints prevent abuse by checking existing active requests per user.
- **Data Retention**: Downloadable zip files auto-destruct to ensure minimal footprint.
- **Proxy Telemetry**: Telemetry routes through the Vercel edge to prevent client-side ad blockers from breaking core tracking and to keep PostHog API keys completely server-side.
