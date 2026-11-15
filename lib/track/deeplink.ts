/**
 * Cross-platform live session ID validation, deep link path extraction,
 * and Smart App Banner deep link resolution for mobile clients (CIE-033).
 * 
 * Invariants:
 * - Session ID length: 4 to 128 characters.
 * - Allowed characters: A-Z, a-z, 0-9, underscore (_), hyphen (-).
 * - 'watcher' is a reserved routing keyword for trusted watcher invite redemption.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const TrackCore = require('../../public/js/tracker-core.js');

export const VALID_SESSION_ID_REGEX: RegExp = TrackCore.VALID_SESSION_ID_REGEX;

export interface ParsedLivePath {
    raw: string;
    sessionId: string;
    isWatcherInvite: boolean;
    isValid: boolean;
}

export function parseLiveSessionPath(pathname: string): ParsedLivePath {
    return TrackCore.parseLiveSessionPath(pathname);
}

export function isValidSessionId(sessionId: string): boolean {
    return TrackCore.isValidSessionId(sessionId);
}

export function detectPlatform(userAgent: string): 'ios' | 'android' | 'desktop' {
    return TrackCore.detectPlatform(userAgent);
}

export const MIN_WATCHER_INVITE_APP_VERSION: string = TrackCore.MIN_WATCHER_INVITE_APP_VERSION;

export function buildNativeDeepLink(sessionId: string, riderName?: string | null, watcherCode?: string | null): string {
    return TrackCore.buildNativeDeepLink(sessionId, riderName, watcherCode);
}

export function buildAndroidIntentUrl(
    sessionId: string,
    riderName?: string | null,
    fallbackUrl: string = TrackCore.STORE_URLS.android,
    watcherCode?: string | null
): string {
    return TrackCore.buildAndroidIntentUrl(sessionId, riderName, fallbackUrl, watcherCode);
}

export interface WatcherVersionNotice {
    minVersion: string;
    badgeText: string;
    message: string;
    getAppCopy: string;
}

export function buildWatcherVersionNotice(inviterName?: string | null): WatcherVersionNotice {
    return TrackCore.buildWatcherVersionNotice(inviterName);
}

export const STORE_URLS = TrackCore.STORE_URLS;

export function buildStoreUrl(platform: 'ios' | 'android' | 'desktop'): string {
    return TrackCore.buildStoreUrl(platform);
}

export const SMART_BANNER_DISMISS_TTL_MS: number = TrackCore.SMART_BANNER_DISMISS_TTL_MS;

export function isBannerDismissed(
    dismissedTimestamp: number | null | undefined,
    nowEpochMs: number = Date.now(),
    ttlMs: number = SMART_BANNER_DISMISS_TTL_MS
): boolean {
    return TrackCore.isBannerDismissed(dismissedTimestamp, nowEpochMs, ttlMs);
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
    watcherCode?: string | null;
    dismissedTimestamp?: number | null;
    nowEpochMs?: number;
}): SmartBannerData {
    return TrackCore.resolveSmartBannerData(options);
}

