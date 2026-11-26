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

export function buildViewerGetAppCopy(
  riderName?: string | null,
  isStopped: boolean = false
): string {
  return TrackCore.buildViewerGetAppCopy(riderName, isStopped);
}

export type ConcludedStopKind = 'rider_confirmed' | 'auto_dwell_ended' | 'expired';

export interface ConcludedSessionState {
  stopKind: ConcludedStopKind;
  statusBadgeLabel: string;
  stopSummary: string;
  metaRightLabel: string;
}

export interface ViewerForwardSharePayload {
  title: string;
  text: string;
  url: string;
  copyToast: string;
  buttonLabel: string;
}

export function normalizeStopKind(
  rawStopKind?: unknown,
  rawStopReason?: unknown
): ConcludedStopKind {
  return TrackCore.normalizeStopKind(rawStopKind, rawStopReason);
}

export function resolveConcludedSessionState(data?: {
  stopKind?: string | null;
  stopReason?: string | null;
  endReason?: string | null;
} | null): ConcludedSessionState {
  return TrackCore.resolveConcludedSessionState(data);
}

export function buildViewerForwardSharePayload(options: {
  riderName?: string | null;
  url: string;
  isStopped?: boolean;
  stopKind?: string | null;
  stopReason?: string | null;
  distanceStr?: string | null;
  durationStr?: string | null;
}): ViewerForwardSharePayload {
  return TrackCore.buildViewerForwardSharePayload(options);
}


