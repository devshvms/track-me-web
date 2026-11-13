/**
 * Cross-platform live session ID validation, deep link path extraction,
 * and Smart App Banner deep link resolution for mobile clients (CIE-033).
 * 
 * Invariants:
 * - Session ID length: 4 to 128 characters.
 * - Allowed characters: A-Z, a-z, 0-9, underscore (_), hyphen (-).
 * - 'watcher' is a reserved routing keyword for trusted watcher invite redemption.
 */

export const VALID_SESSION_ID_REGEX = /^[A-Za-z0-9_-]{4,128}$/;

export interface ParsedLivePath {
    raw: string;
    sessionId: string;
    isWatcherInvite: boolean;
    isValid: boolean;
}

/**
 * Extracts and sanitizes the session ID or watcher indicator from a URL pathname.
 * Handles trailing slashes, percent-encoded tokens, and empty/missing segments.
 *
 * @param pathname e.g. "/live/ride_12345", "/live/ride_12345/", "/live", "/live/watcher"
 */
export function parseLiveSessionPath(pathname: string): ParsedLivePath {
    const parts = (pathname || '').split('/').filter(Boolean);
    const lastPart = parts[parts.length - 1] || '';

    let clean = '';
    if (lastPart && lastPart.toLowerCase() !== 'live') {
        try {
            clean = decodeURIComponent(lastPart).trim();
        } catch {
            clean = lastPart.trim();
        }
    }

    const isWatcherInvite = clean.toLowerCase() === 'watcher';
    const isValid = isWatcherInvite || VALID_SESSION_ID_REGEX.test(clean);

    return {
        raw: lastPart,
        sessionId: clean,
        isWatcherInvite,
        isValid: Boolean(clean && isValid),
    };
}

/**
 * Returns true if a given session identifier conforms to the security specification.
 */
export function isValidSessionId(sessionId: string): boolean {
    if (!sessionId || typeof sessionId !== 'string') return false;
    return VALID_SESSION_ID_REGEX.test(sessionId.trim());
}

/**
 * Detects client mobile platform from navigator.userAgent.
 */
export function detectPlatform(userAgent: string): 'ios' | 'android' | 'desktop' {
    if (!userAgent || typeof userAgent !== 'string') return 'desktop';
    const ua = userAgent.toLowerCase();
    if (/iphone|ipad|ipod/.test(ua)) return 'ios';
    if (/android/.test(ua)) return 'android';
    return 'desktop';
}

/**
 * Builds native custom-scheme deep link URI (trackme://live/...) with query forwarding (CIE-033).
 */
export function buildNativeDeepLink(sessionId: string, riderName?: string | null): string {
    const isWatcher = sessionId === 'watcher';
    if (!isWatcher && !isValidSessionId(sessionId)) return '';
    const cleanSession = encodeURIComponent(sessionId.trim());
    const cleanName = (riderName || '').trim().slice(0, 60);
    if (cleanName) {
        return `trackme://live/${cleanSession}?name=${encodeURIComponent(cleanName)}`;
    }
    return `trackme://live/${cleanSession}`;
}

/**
 * Builds Android Chrome Intent URI with browser fallback to Google Play.
 */
export function buildAndroidIntentUrl(
    sessionId: string,
    riderName?: string | null,
    fallbackUrl: string = 'https://play.google.com/store/apps/details?id=in.shvms.trackme&referrer=utm_source%3Dlive_share_smart_banner%26utm_medium%3Dweb%26utm_campaign%3Dlive_tracker'
): string {
    const isWatcher = sessionId === 'watcher';
    if (!isWatcher && !isValidSessionId(sessionId)) return fallbackUrl;
    const cleanSession = encodeURIComponent(sessionId.trim());
    const cleanName = (riderName || '').trim().slice(0, 60);
    const query = cleanName ? `?name=${encodeURIComponent(cleanName)}` : '';
    const path = `/live/${cleanSession}${query}`;
    return `intent://trackme.shvms.in${path}#Intent;scheme=https;package=in.shvms.trackme;S.browser_fallback_url=${encodeURIComponent(fallbackUrl)};end`;
}

/**
 * Official App Store and Google Play URLs with organic attribution parameters.
 */
export const STORE_URLS = {
    ios: 'https://apps.apple.com/app/id6800161248?pt=128001612&ct=live_share_smart_banner&mt=8',
    android: 'https://play.google.com/store/apps/details?id=in.shvms.trackme&referrer=utm_source%3Dlive_share_smart_banner%26utm_medium%3Dweb%26utm_campaign%3Dlive_tracker',
    desktop: 'https://trackme.shvms.in/get?utm_source=live_share_smart_banner',
};

export function buildStoreUrl(platform: 'ios' | 'android' | 'desktop'): string {
    return STORE_URLS[platform] || STORE_URLS.desktop;
}

/**
 * Checks if the user has dismissed the smart banner within the dismissal window.
 * Default dismissal TTL: 7 days.
 */
export const SMART_BANNER_DISMISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function isBannerDismissed(
    dismissedTimestamp: number | null | undefined,
    nowEpochMs: number = Date.now(),
    ttlMs: number = SMART_BANNER_DISMISS_TTL_MS
): boolean {
    if (!dismissedTimestamp || typeof dismissedTimestamp !== 'number' || isNaN(dismissedTimestamp)) {
        return false;
    }
    const elapsed = nowEpochMs - dismissedTimestamp;
    return elapsed >= 0 && elapsed < ttlMs;
}

export interface SmartBannerData {
    shouldShow: boolean;
    platform: 'ios' | 'android' | 'desktop';
    deepLinkUrl: string;
    storeUrl: string;
    title: string;
    subtitle: string;
    ctaText: string;
}

export function resolveSmartBannerData(options: {
    userAgent: string;
    sessionId: string;
    riderName?: string | null;
    dismissedTimestamp?: number | null;
    nowEpochMs?: number;
}): SmartBannerData {
    const platform = detectPlatform(options.userAgent);
    const isDismissed = isBannerDismissed(options.dismissedTimestamp, options.nowEpochMs);
    const isValid = isValidSessionId(options.sessionId) || options.sessionId === 'watcher';

    const deepLinkUrl = platform === 'android'
        ? buildAndroidIntentUrl(options.sessionId, options.riderName)
        : buildNativeDeepLink(options.sessionId, options.riderName);

    const storeUrl = buildStoreUrl(platform);

    const riderClean = (options.riderName || '').trim();
    const title = riderClean ? `Track ${riderClean}'s Ride` : 'TrackMe: Live GPS Rides';
    const subtitle = 'Open in TrackMe app for live turn & arrival alerts';
    const ctaText = 'OPEN';

    // Banner is tailored for mobile devices (iOS / Android) when not dismissed and valid session
    const shouldShow = (platform === 'ios' || platform === 'android') && !isDismissed && isValid;

    return {
        shouldShow,
        platform,
        deepLinkUrl,
        storeUrl,
        title,
        subtitle,
        ctaText,
    };
}
