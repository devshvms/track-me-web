/**
 * TASK-366 / SCOPE_1.9.3 / CIE-031: Live Share Social Previews & Metadata Helpers.
 * Pure helpers for building enriched live share URLs and resolving dynamic metadata
 * (OpenGraph & Twitter Card attributes) for high-converting social link unfurling.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const TrackCore = require('../../public/js/tracker-core.js');

export interface LiveShareMetadata {
  title: string;
  description: string;
  ogImage: string;
  canonicalUrl: string;
}

export function sanitizeRiderName(rawName?: string | null): string | null {
  return TrackCore.sanitizeRiderName(rawName);
}

export function buildLiveShareUrl(
  baseUrl: string,
  sessionId: string,
  riderName?: string | null
): string {
  return TrackCore.buildLiveShareUrl(baseUrl, sessionId, riderName);
}

export function resolveLiveShareMetadata(options: {
  riderName?: string | null;
  sessionId?: string | null;
  baseUrl?: string | null;
  isStopped?: boolean;
}): LiveShareMetadata {
  return TrackCore.resolveLiveShareMetadata(options);
}

