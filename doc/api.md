# TrackMe Web API Contract

This is the client implementation contract for the production API at `https://trackme.shvms.in`. The export endpoints use Firebase Authentication for identity and Redis for short-lived export request metadata.

## Authentication

The client signs in with Firebase Authentication and obtains a Firebase ID token. Send it on request and status calls exactly as:

```http
Authorization: Bearer <firebase-id-token>
```

The `userId` in the JSON body or query must equal the authenticated Firebase user UID. The server rejects another user’s UID with `403 Forbidden`.

Firebase ID tokens expire. Before an export request or status call, obtain a current token. Android should use `FirebaseUser.getIdToken(true)` for this flow. A cached/expired token produces `401 Invalid or expired token`.

## Export Flow

The export is synchronous at the request-metadata level and on-demand at the archive level:

1. Call `POST /api/export/request` with a fresh bearer token.
2. Read the returned `downloadUrl` exactly as received.
3. Download that URL. It contains a random `token` query parameter and can be used without a bearer header, which is required for Android `DownloadManager`.
4. Treat a `200` response with `Content-Type: application/zip` as success and save the response bytes.

The server reads the user’s data only when the download URL is opened. It reads:

- `users/{uid}` for the profile, with Firebase Auth metadata as a fallback when the parent profile document does not exist.
- `users/{uid}/emergency_config/*` for emergency configuration.
- `users/{uid}/rides/*` for ride metadata and the embedded `points` array.

Each ride becomes one `traces/ride_{rideId}.gpx` entry. The ZIP also contains `metadata.json` and `rides_history.json`. The server expects synchronized point fields `lat`, `lng`, `altitude`, `accuracy`, `speed`, `timestamp`, and `isPaused`.

**Current streaming failure behavior:** Web HEAD `eda6b1b` streams directly to avoid a temporary-disk ceiling. If Firestore ride iteration fails after response headers, the ZIP contains `EXPORT_FAILED.txt`, the six-hour retention marker is skipped, and the HTTP response remains `200`. Clients must inspect the archive for this marker before treating the export as complete; this behavior remains runtime-gated and is not equivalent to the JSON `502` contract for preflight failures.

### 1. Request an export

```http
POST /api/export/request
Authorization: Bearer <firebase-id-token>
Content-Type: application/json

{
  "userId": "firebase-uid",
  "userEmail": "person@example.com",
  "clientOS": "Android",
  "exportFormats": ["GPX", "JSON_ARCHIVE"],
  "metadata": {
    "appVersion": "1.5.4"
  }
}
```

Required fields:

- `userId`: authenticated Firebase UID.
- `clientOS`: client label, for example `Android` or `iOS`.

`userEmail`, `exportFormats`, and `metadata` are optional. The server uses the authenticated email when `userEmail` is omitted. The endpoint is idempotent for the same user while an export record is retained; repeated calls return the existing request and its current download URL.

Successful response (`200`):

```json
{
  "requestId": "12f206b0-61d1-497b-bd76-635632821d48",
  "userId": "firebase-uid",
  "status": "COMPLETED",
  "requestedAt": "2026-07-17T06:00:00.000Z",
  "completedAt": "2026-07-17T06:00:00.000Z",
  "downloadUrl": "https://trackme.shvms.in/api/export/download?requestId=12f206b0-61d1-497b-bd76-635632821d48&token=<capability-token>",
  "expiresAt": "2026-07-19T06:00:00.000Z",
  "retentionPolicy": "Archive expires 6 hours after retrieval (max 48 hours unaccessed).",
  "message": "Your historical data archive (.zip containing GPX traces and JSON metadata) is ready for download."
}
```

Do not expect or send `archiveSizeBytes`; archive size is not known until the ZIP is generated during download.

### 2. Check export status

Use either the authenticated user UID or, preferably, the returned request ID:

```http
GET /api/export/status?requestId=<request-id>
Authorization: Bearer <firebase-id-token>
```

The response has the same export record shape as the request response. The status is currently `COMPLETED` immediately. Clients should still handle `QUEUED` and `PROCESSING` defensively for records created by older deployments or future implementations. If those states are returned, wait and poll with a fresh bearer token; do not download yet.

### 3. Download the ZIP

Use the exact absolute URL returned by request/status:

```http
GET https://trackme.shvms.in/api/export/download?requestId=<request-id>&token=<capability-token>
```

The capability token is a short-lived, random download credential bound to this export request. It replaces the bearer header for this endpoint so OS download managers can use the URL. Treat the URL like a secret: do not log it, display it in analytics, or reconstruct it manually. An authenticated owner may alternatively call the endpoint with `Authorization: Bearer <firebase-id-token>` and omit `token`.

Success:

- HTTP `200`
- `Content-Type: application/zip`
- `Content-Disposition: attachment; filename="TrackMe_Archive_<uid>.zip"`

The first successful download starts the six-hour retention window. An export that is never downloaded expires after 48 hours. After expiry, request a new export.

## Error Contract

Errors are JSON unless the response is the successful ZIP stream:

```json
{
  "error": "Invalid or expired token."
}
```

Common statuses:

| HTTP | Meaning | Client action |
| --- | --- | --- |
| `400` | Missing/invalid request parameters, or archive is not completed | Fix the request, or wait before retrying |
| `401` | Missing, invalid, or expired Firebase bearer token | Refresh the Firebase ID token and retry once; if it still fails, sign in again |
| `403` | UID does not belong to the authenticated user | Stop; never retry with another user ID |
| `404` | Export request is missing or expired from Redis | Request a new export |
| `410` | Archive retention window has ended | Request a new export |
| `502` | Firestore data could not be read or archive could not be assembled | Show a retryable error and report the request ID |
| `503` | Firebase/Firestore server configuration is unavailable | Retry later; this is a server issue |

## Android Reference

```kotlin
val idToken = firebaseUser.getIdToken(true).await().token
    ?: error("No Firebase ID token")

// POST /api/export/request with Authorization: Bearer idToken.
// Parse downloadUrl from the 2xx JSON response.
val downloadUri = Uri.parse(downloadUrl)
check(!downloadUri.getQueryParameter("token").isNullOrBlank())

// Pass the exact tokenized URI to DownloadManager. Do not add a bearer
// header here; DownloadManager cannot reliably attach one to this request.
downloadManager.enqueue(DownloadManager.Request(downloadUri))
```

## Non-export Endpoints

Other endpoint summaries remain in [technical.md](technical.md). This document intentionally specifies the export contract in detail because it is shared by the Android and iOS clients.
