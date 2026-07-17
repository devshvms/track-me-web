# System Architecture

## High-Level Overview
The system is built on a serverless architecture designed to run on Vercel. It leverages ephemeral compute functions backed by a high-performance Redis cache for state management and Firebase for administrative persistent storage.

## Technology Stack
- **Compute**: Vercel Serverless Functions (Node.js/TypeScript)
- **Primary Data Store**: Redis (Upstash or standard Redis instance). Includes a local in-memory fallback for development.
- **Analytics Engine**: PostHog Node SDK.
- **Archive Processing**: `adm-zip` for in-memory zip creation.
- **Persistent Storage / Auth**: Firebase Admin SDK (Firestore, Auth).

## Component Architecture

### 1. API Layer (`/api`)
The entry point consists of RESTful endpoints organized by domain:
- `/api/track`: Handles real-time live-share session initialization and management.
- `/api/export`: Manages the asynchronous lifecycle of data exports.
- `/api/telemetry`: Proxies tracking events to PostHog and computes real-time aggregates.
- `/api/admin`: Administrative endpoints for metrics and user lookup.

### 2. Data Store Layer (Redis)
Redis is strictly used as a fast, TTL-based KV store for:
- **Sessions**: Stored as `session:{sessionId}` with a TTL mapping to the duration requested by the user.
- **Export Queue**: Sorted sets (`export:queue`) and KV pairs (`export:request:{id}`, `export:user:{id}`) handle the export state machine.
- **Analytics Aggregates**: Counters (`stats:total_shares`) and rolling windows using Sorted Sets (`stats:shares_24h` where score is timestamp).

### 3. Export Lifecycle State Machine
1. **Request (`/api/export/request`)**: Client initiates a request. Stored in Redis with status `QUEUED`.
2. **Process (`/api/export/process`)**: A background/cron function scans `QUEUED` requests, generates the `.zip` payload, and transitions them to `COMPLETED`.
3. **Status (`/api/export/status`)**: Client polls to check if the archive is ready.
4. **Download (`/api/export/download`)**: Once `COMPLETED`, the archive is served to the client. Strict TTLs are applied to auto-delete the archive (6 hours after first download, or 48 hours if never downloaded).

## Security & Privacy Considerations
- **No Long-Term Session State**: All live-share sessions auto-expire via Redis TTLs, preventing "zombie" share links.
- **Idempotency**: Export request endpoints prevent abuse by checking existing active requests per user.
- **Data Retention**: Downloadable zip files auto-destruct to ensure minimal footprint.
- **Proxy Telemetry**: Telemetry routes through the Vercel edge to prevent client-side ad blockers from breaking core tracking and to keep PostHog API keys completely server-side.
