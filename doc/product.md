# Product Documentation: Track Me Web API

## Overview
Track Me Web API is a lightweight, serverless backend designed to power real-time session tracking, data export, and telemetry ingestion. It enables users to securely share live links with expirations, request archives of their historical data, and track engagement stats.

## Core Features

### 1. Live Share Sessions
- **Session Generation**: Create temporary shareable links (`/live/:sessionId`) with configurable durations (up to 24 hours).
- **Auto-Expiration**: Sessions naturally expire based on Redis TTL, preventing indefinite access.
- **Anonymity & Privacy**: Supports anonymous sharing out-of-the-box, assigning temporary UUIDs.

### 2. Historical Data Export
- **Archive Generation**: Users can request a complete `.zip` archive of their historical GPX traces and JSON metadata.
- **Idempotent Requests**: Safeguards against spam by allowing only one active request per user within a specific timeframe.
- **On-demand Archive Export**: The request creates a completed export record immediately. The ZIP is assembled from the user’s Firestore data only when the tokenized download URL is opened, with a 48-hour unaccessed limit or six-hour post-download limit.

### 3. Telemetry & Analytics
- **Event Proxy**: A privacy-friendly proxy for PostHog telemetry to obscure backend API keys and standard tracking domains from ad-blockers.
- **Engagement Stats**: Tracks real-time viewer stats ("Total Shares", "Active Viewers in 24h") using Redis sorted sets for fast reads.

### 4. Admin Tools
- **Metrics Dashboard API**: Endpoints to pull aggregate stats and export queues for system monitoring.
- **User Search**: Ability to look up users and their export statuses.

## Target Audience
- **Developers & Teams**: Wanting a drop-in API for location sharing or temporary data sharing without complex state management.
- **Privacy-Conscious Applications**: Utilizing the robust data export and automated deletion features to comply with data privacy regulations like GDPR.
