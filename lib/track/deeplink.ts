/**
 * Cross-platform live session ID validation and deep link path extraction.
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
