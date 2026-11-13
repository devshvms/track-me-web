/**
 * TASK-366 / SCOPE_1.9.3 / CIE-031: Live Share Social Previews & Metadata Helpers.
 * Pure helpers for building enriched live share URLs and resolving dynamic metadata
 * (OpenGraph & Twitter Card attributes) for high-converting social link unfurling.
 */

export interface LiveShareMetadata {
  title: string;
  description: string;
  ogImage: string;
  canonicalUrl: string;
}

/**
 * Strips HTML tags, control characters, trims whitespace, and limits rider name to a safe maximum length.
 * Returns null if name is empty, whitespace-only, or invalid.
 */
export function sanitizeRiderName(rawName?: string | null): string | null {
  if (!rawName || typeof rawName !== 'string') return null;
  // Strip potential HTML tags and control characters
  const stripped = rawName.replace(/<[^>]*>/g, '').replace(/[\r\n\t]/g, ' ').trim();
  if (!stripped) return null;
  // Truncate to maximum 60 characters for crisp social cards
  return stripped.slice(0, 60);
}

/**
 * Builds a standardized live share URL with optional rider attribution query parameter.
 * Safely handles trailing slashes, base URL formatting, and URI component encoding.
 */
export function buildLiveShareUrl(
  baseUrl: string,
  sessionId: string,
  riderName?: string | null
): string {
  const cleanBase = (baseUrl || '').replace(/\/+$/, '');
  const cleanSession = encodeURIComponent((sessionId || '').trim());
  let url = `${cleanBase}/live/${cleanSession}`;
  const cleanName = sanitizeRiderName(riderName);
  if (cleanName) {
    url += `?name=${encodeURIComponent(cleanName)}`;
  }
  return url;
}

/**
 * Resolves social card metadata (OpenGraph & Twitter Cards) based on session state and rider attribution.
 */
export function resolveLiveShareMetadata(options: {
  riderName?: string | null;
  sessionId?: string | null;
  baseUrl?: string | null;
  isStopped?: boolean;
}): LiveShareMetadata {
  const cleanName = sanitizeRiderName(options.riderName);
  const base = (options.baseUrl || 'https://trackme.shvms.in').replace(/\/+$/, '');
  const canonicalUrl = options.sessionId
    ? buildLiveShareUrl(base, options.sessionId, cleanName)
    : `${base}/live`;
  const ogImage = `${base}/assets/trackme-social-card.svg`;

  let title: string;
  let description: string;

  if (cleanName) {
    if (options.isStopped) {
      title = `${cleanName}'s Ride on TrackMe · Trip Completed`;
      description = `View ${cleanName}'s completed route, distance, and duration on TrackMe. Private, free & open-source.`;
    } else {
      title = `${cleanName}'s Live Ride · TrackMe`;
      description = `Follow ${cleanName} live in real time on TrackMe with private GPS breadcrumbs, speed, and ETA. Free & open-source.`;
    }
  } else {
    if (options.isStopped) {
      title = 'TrackMe Live Ride Tracking · Trip Completed';
      description = 'View this completed route, distance, and duration on TrackMe. Private, free & open-source.';
    } else {
      title = 'TrackMe Live Ride Tracking · Real-Time GPS Sharing';
      description = 'Follow this ride live in real time with private GPS breadcrumbs, speed, and ETA. Free & open-source.';
    }
  }

  return {
    title,
    description,
    ogImage,
    canonicalUrl,
  };
}
