import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseLiveSessionPath, isValidSessionId } from '../lib/track/deeplink';

describe('Deep Link Path Resolution & Session Validation (CIE-004)', () => {
    it('parses valid session ID from clean path', () => {
        const res = parseLiveSessionPath('/live/abc_12345');
        assert.equal(res.sessionId, 'abc_12345');
        assert.equal(res.isWatcherInvite, false);
        assert.equal(res.isValid, true);
    });

    it('ignores trailing slash gracefully', () => {
        const res = parseLiveSessionPath('/live/abc_12345/');
        assert.equal(res.sessionId, 'abc_12345');
        assert.equal(res.isValid, true);
    });

    it('handles percent-encoded hyphens and underscores', () => {
        const res = parseLiveSessionPath('/live/ride%2D99%5Fxy');
        assert.equal(res.sessionId, 'ride-99_xy');
        assert.equal(res.isValid, true);
    });

    it('identifies reserved watcher invite keyword', () => {
        const res = parseLiveSessionPath('/live/watcher');
        assert.equal(res.sessionId, 'watcher');
        assert.equal(res.isWatcherInvite, true);
        assert.equal(res.isValid, true);
    });

    it('identifies empty or missing session path as invalid', () => {
        const empty = parseLiveSessionPath('/live');
        assert.equal(empty.sessionId, '');
        assert.equal(empty.isValid, false);

        const emptySlash = parseLiveSessionPath('/live/');
        assert.equal(emptySlash.sessionId, '');
        assert.equal(emptySlash.isValid, false);

        const blank = parseLiveSessionPath('');
        assert.equal(blank.sessionId, '');
        assert.equal(blank.isValid, false);
    });

    it('rejects malformed session IDs violating regex length or characters', () => {
        // Too short (< 4 chars)
        assert.equal(parseLiveSessionPath('/live/ab').isValid, false);
        assert.equal(isValidSessionId('ab'), false);

        // Hostile characters
        assert.equal(parseLiveSessionPath('/live/<script>').isValid, false);
        assert.equal(isValidSessionId('<script>'), false);
        assert.equal(isValidSessionId('foo bar'), false);
        assert.equal(isValidSessionId('foo.bar'), false);

        // Valid strings
        assert.equal(isValidSessionId('abc_12345'), true);
        assert.equal(isValidSessionId('sess-9876_alpha'), true);
    });
});
