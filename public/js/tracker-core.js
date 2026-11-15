/**
 * Shared Live Tracker Pure Helpers (M-2 Single Source of Truth)
 *
 * Loaded synchronously by `public/tracker.html` via `<script src="/js/tracker-core.js"></script>`
 * and required by `lib/track/*.ts` test-covered TypeScript wrappers so browser runtime logic
 * and Node unit tests never diverge.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.TrackCore = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PREFERRED_UNITS_STORAGE_KEY = 'trackme_preferred_units';
  const VALID_SESSION_ID_REGEX = /^[A-Za-z0-9_-]{4,128}$/;
  const CAMERA_DEADBAND_METERS = 3.0;
  const COMPASS_BEARING_DEADBAND_DEGREES = 3.0;
  const SMART_BANNER_DISMISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const STORE_URLS = {
    ios: 'https://apps.apple.com/app/id6800161248?pt=128001612&ct=live_share_smart_banner&mt=8',
    android: 'https://play.google.com/store/apps/details?id=in.shvms.trackme&referrer=utm_source%3Dlive_share_smart_banner%26utm_medium%3Dweb%26utm_campaign%3Dlive_tracker',
    desktop: 'https://trackme.shvms.in/get?utm_source=live_share_smart_banner',
  };

  function resolveInitialUnits(queryParam, storedPreference, navigatorLanguages) {
    if (queryParam) {
      const q = String(queryParam).trim().toLowerCase();
      if (q === 'imperial' || q === 'mi' || q === 'mph' || q === 'miles') return 'imperial';
      if (q === 'metric' || q === 'km' || q === 'kmh' || q === 'kilometers') return 'metric';
    }
    if (storedPreference) {
      const s = String(storedPreference).trim().toLowerCase();
      if (s === 'imperial') return 'imperial';
      if (s === 'metric') return 'metric';
    }
    if (navigatorLanguages) {
      const langs = Array.isArray(navigatorLanguages) ? navigatorLanguages : [navigatorLanguages];
      for (const lang of langs) {
        if (typeof lang === 'string') {
          const clean = lang.trim();
          if (/(?:-|_)US$/i.test(clean) || /(?:-|_)LR$/i.test(clean) || /(?:-|_)MM$/i.test(clean)) {
            return 'imperial';
          }
        }
      }
    }
    return 'metric';
  }

  function toggleUnitSystem(current) {
    return current === 'imperial' ? 'metric' : 'imperial';
  }

  function formatViewerSpeed(speedKmh, unitOrUseMiles) {
    const isImperial = unitOrUseMiles === 'imperial' || unitOrUseMiles === true;
    const unitLabel = isImperial ? 'mph' : 'km/h';
    if (speedKmh === null || speedKmh === undefined || !Number.isFinite(speedKmh) || speedKmh < 0) {
      return `0 ${unitLabel}`;
    }
    const rawVal = isImperial ? speedKmh * 0.621371 : speedKmh;
    return `${Math.round(rawVal)} ${unitLabel}`;
  }

  function formatViewerDistance(meters, unitOrUseMiles) {
    const isImperial = unitOrUseMiles === 'imperial' || unitOrUseMiles === true;
    if (meters === null || meters === undefined || !Number.isFinite(meters) || meters <= 0) {
      return isImperial ? '0.0 mi' : '0.0 km';
    }
    if (isImperial) {
      return `${(meters / 1609.344).toFixed(1)} mi`;
    }
    return `${(meters / 1000).toFixed(1)} km`;
  }

  function sanitizeRiderName(rawName) {
    if (!rawName || typeof rawName !== 'string') return null;
    const stripped = rawName.replace(/<[^>]*>/g, '').replace(/[\r\n\t]/g, ' ').trim();
    return stripped ? stripped.slice(0, 60) : null;
  }

  function buildLiveShareUrl(baseUrl, sessionId, riderName) {
    const cleanBase = (baseUrl || '').replace(/\/+$/, '');
    const cleanSession = encodeURIComponent((sessionId || '').trim());
    let url = `${cleanBase}/live/${cleanSession}`;
    const cleanName = sanitizeRiderName(riderName);
    if (cleanName) {
      url += `?name=${encodeURIComponent(cleanName)}`;
    }
    return url;
  }

  function resolveLiveShareMetadata(options) {
    const cleanName = sanitizeRiderName(options && options.riderName);
    const base = ((options && options.baseUrl) || 'https://trackme.shvms.in').replace(/\/+$/, '');
    const canonicalUrl = options && options.sessionId
      ? buildLiveShareUrl(base, options.sessionId, cleanName)
      : `${base}/live`;
    const ogImage = `${base}/assets/trackme-social-card.svg`;

    let title;
    let description;
    const isStopped = Boolean(options && options.isStopped);
    if (cleanName) {
      if (isStopped) {
        title = `${cleanName}'s Ride on TrackMe · Trip Completed`;
        description = `View ${cleanName}'s completed route, distance, and duration on TrackMe. Private, free & open-source.`;
      } else {
        title = `${cleanName}'s Live Ride · TrackMe`;
        description = `Follow ${cleanName} live in real time on TrackMe with private GPS breadcrumbs, speed, and ETA. Free & open-source.`;
      }
    } else {
      if (isStopped) {
        title = 'TrackMe Live Ride Tracking · Trip Completed';
        description = 'View this completed route, distance, and duration on TrackMe. Private, free & open-source.';
      } else {
        title = 'TrackMe Live Ride Tracking · Real-Time GPS Sharing';
        description = 'Follow this ride live in real time with private GPS breadcrumbs, speed, and ETA. Free & open-source.';
      }
    }
    return { title, description, ogImage, canonicalUrl };
  }

  const VIEWER_PING_BASE_MS = 15000;
  const VIEWER_PING_THROTTLED_MS = 30000;
  const VIEWER_PING_MAX_BACKOFF_MS = 60000;
  const ZERO_VIEWER_HIBERNATION_THRESHOLD_MS = 600000;
  const ZERO_VIEWER_HIBERNATION_INTERVAL_MS = 30000;

  function computeBackoffDelay(consecutiveFailures, options, randomFn) {
    const opts = options || {};
    const rng = typeof randomFn === 'function' ? randomFn : Math.random;
    const baseMs = Math.max(1000, opts.baseMs !== undefined ? opts.baseMs : 5000);
    const maxMs = Math.max(baseMs, opts.maxMs !== undefined ? opts.maxMs : 15000);
    const jitterMaxMs = Math.max(0, opts.jitterMaxMs !== undefined ? opts.jitterMaxMs : 500);
    if (consecutiveFailures <= 0) return baseMs;

    const increments = [1000, 3000, 6000, 10000];
    const stepIndex = Math.min(consecutiveFailures - 1, increments.length - 1);
    const stepIncrement = increments[stepIndex];
    const jitter = jitterMaxMs > 0 ? Math.floor(rng() * jitterMaxMs) : 0;
    return Math.min(maxMs, baseMs + stepIncrement + jitter);
  }

  function shouldSkipPresencePing(consecutiveFailures, isOnline) {
    if (isOnline === false) return true;
    return consecutiveFailures >= 2;
  }

  function computeViewerPingDelay(consecutivePingFailures, options, randomFn) {
    const opts = options || {};
    const rng = typeof randomFn === 'function' ? randomFn : Math.random;
    const isThrottled = Boolean(opts.isLowDataMode || opts.isBackground || opts.isViewerIdle);
    const baseMs = Math.max(1000, opts.baseMs !== undefined ? opts.baseMs : VIEWER_PING_BASE_MS);
    const throttledMs = Math.max(baseMs, opts.throttledMs !== undefined ? opts.throttledMs : VIEWER_PING_THROTTLED_MS);
    const effectiveBaseMs = isThrottled ? throttledMs : baseMs;
    const maxMs = Math.max(effectiveBaseMs, opts.maxMs !== undefined ? opts.maxMs : VIEWER_PING_MAX_BACKOFF_MS);
    const jitterMaxMs = Math.max(0, opts.jitterMaxMs !== undefined ? opts.jitterMaxMs : 1000);
    if (consecutivePingFailures <= 0) return effectiveBaseMs;

    const increments = [5000, 15000, 30000, 45000];
    const stepIndex = Math.min(consecutivePingFailures - 1, increments.length - 1);
    const stepIncrement = increments[stepIndex];
    const jitter = jitterMaxMs > 0 ? Math.floor(rng() * jitterMaxMs) : 0;
    return Math.min(maxMs, effectiveBaseMs + stepIncrement + jitter);
  }

  function evaluateZeroViewerHibernation(params) {
    const opts = params || {};
    const rawViewers = Number(opts.activeViewers);
    const activeViewers = Number.isFinite(rawViewers) ? Math.max(0, Math.floor(rawViewers)) : 0;
    const nowEpochMs = Number.isFinite(opts.nowEpochMs) ? Number(opts.nowEpochMs) : Date.now();
    const configuredIntervalMs = Math.max(1000, opts.configuredIntervalMs !== undefined ? opts.configuredIntervalMs : 5000);
    const isPowerSaveOrLowBattery = Boolean(opts.isPowerSaveOrLowBattery);
    const thresholdMs = Math.max(1000, opts.thresholdMs !== undefined ? opts.thresholdMs : ZERO_VIEWER_HIBERNATION_THRESHOLD_MS);
    const hibernationIntervalMs = Math.max(1000, opts.hibernationIntervalMs !== undefined ? opts.hibernationIntervalMs : ZERO_VIEWER_HIBERNATION_INTERVAL_MS);
    const normalBaseIntervalMs = isPowerSaveOrLowBattery ? Math.max(configuredIntervalMs, 15000) : configuredIntervalMs;

    if (activeViewers > 0) {
      return {
        isHibernating: false,
        zeroViewersSinceEpochMs: null,
        idleDurationMs: 0,
        effectiveIntervalMs: normalBaseIntervalMs,
      };
    }

    const hasValidStart = opts.zeroViewersSinceEpochMs !== null &&
      opts.zeroViewersSinceEpochMs !== undefined &&
      Number.isFinite(opts.zeroViewersSinceEpochMs);
    const effectiveStartMs = hasValidStart ? Number(opts.zeroViewersSinceEpochMs) : nowEpochMs;
    const idleDurationMs = Math.max(0, nowEpochMs - effectiveStartMs);
    const isHibernating = idleDurationMs >= thresholdMs;
    return {
      isHibernating,
      zeroViewersSinceEpochMs: effectiveStartMs,
      idleDurationMs,
      effectiveIntervalMs: isHibernating ? Math.max(normalBaseIntervalMs, hibernationIntervalMs) : normalBaseIntervalMs,
    };
  }

  function buildZeroViewerHibernationTelemetryPayload(sessionId, isHibernating, idleDurationMs, intervalMs, platform) {
    return {
      session_id: String(sessionId || ''),
      sessionId: String(sessionId || ''),
      is_hibernating: Boolean(isHibernating),
      idle_seconds: Math.max(0, Math.round((Number(idleDurationMs) || 0) / 1000)),
      interval_seconds: Math.max(1, Math.round((Number(intervalMs) || 1000) / 1000)),
      platform: String(platform || 'web'),
    };
  }

  function computeHaversineDistanceMeters(lat1, lon1, lat2, lon2) {
    if (lat1 === lat2 && lon1 === lon2) return 0;
    const R = 6371000;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
    return R * c;
  }

  function shouldPanCamera(lastPos, newPos, thresholdMeters) {
    const threshold = thresholdMeters !== undefined ? thresholdMeters : CAMERA_DEADBAND_METERS;
    if (!lastPos) return true;
    const distance = computeHaversineDistanceMeters(lastPos[0], lastPos[1], newPos[0], newPos[1]);
    return distance >= threshold;
  }

  function shouldUpdateContinuousHeading(currentHeading, targetHeading, isStationary, thresholdDegrees) {
    const threshold = thresholdDegrees !== undefined ? thresholdDegrees : COMPASS_BEARING_DEADBAND_DEGREES;
    if (isStationary) return false;
    if (targetHeading === null || targetHeading === undefined || !Number.isFinite(targetHeading)) return false;
    if (currentHeading === null || currentHeading === undefined || !Number.isFinite(currentHeading)) return true;

    let c = currentHeading % 360;
    if (c < 0) c += 360;
    let t = targetHeading % 360;
    if (t < 0) t += 360;
    const delta = ((t - c + 540) % 360) - 180;
    return Math.abs(delta) >= threshold;
  }

  function parseLiveSessionPath(pathname) {
    const parts = (pathname || '').split('/').filter(Boolean);
    const lastPart = parts[parts.length - 1] || '';
    let clean = '';
    if (lastPart && lastPart.toLowerCase() !== 'live') {
      try {
        clean = decodeURIComponent(lastPart).trim();
      } catch (_) {
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

  function isValidSessionId(sessionId) {
    if (!sessionId || typeof sessionId !== 'string') return false;
    return VALID_SESSION_ID_REGEX.test(sessionId.trim());
  }

  function detectPlatform(userAgent) {
    if (!userAgent || typeof userAgent !== 'string') return 'desktop';
    const ua = userAgent.toLowerCase();
    if (/iphone|ipad|ipod/.test(ua)) return 'ios';
    if (/android/.test(ua)) return 'android';
    return 'desktop';
  }

  function buildNativeDeepLink(sessionId, riderName, watcherCode) {
    const isWatcher = sessionId === 'watcher';
    if (!isWatcher && !isValidSessionId(sessionId)) return '';
    const cleanSession = encodeURIComponent(sessionId.trim());
    if (isWatcher && watcherCode !== undefined && watcherCode !== null) {
      const codeParam = encodeURIComponent(String(watcherCode).trim());
      const inviterName = (riderName || '').trim().slice(0, 60);
      return `trackme://live/watcher?code=${codeParam}&inviterName=${encodeURIComponent(inviterName)}`;
    }
    const cleanName = (riderName || '').trim().slice(0, 60);
    if (cleanName) {
      return `trackme://live/${cleanSession}?name=${encodeURIComponent(cleanName)}`;
    }
    return `trackme://live/${cleanSession}`;
  }

  function buildAndroidIntentUrl(sessionId, riderName, fallbackUrl) {
    const fb = fallbackUrl !== undefined ? fallbackUrl : STORE_URLS.android;
    const isWatcher = sessionId === 'watcher';
    if (!isWatcher && !isValidSessionId(sessionId)) return fb;
    const cleanSession = encodeURIComponent(sessionId.trim());
    const cleanName = (riderName || '').trim().slice(0, 60);
    const query = cleanName ? `?name=${encodeURIComponent(cleanName)}` : '';
    const path = `/live/${cleanSession}${query}`;
    return `intent://trackme.shvms.in${path}#Intent;scheme=https;package=in.shvms.trackme;S.browser_fallback_url=${encodeURIComponent(fb)};end`;
  }

  function buildStoreUrl(platform) {
    return STORE_URLS[platform] || STORE_URLS.desktop;
  }

  function isBannerDismissed(dismissedTimestamp, nowEpochMs, ttlMs) {
    const now = nowEpochMs !== undefined ? nowEpochMs : Date.now();
    const ttl = ttlMs !== undefined ? ttlMs : SMART_BANNER_DISMISS_TTL_MS;
    if (!dismissedTimestamp || typeof dismissedTimestamp !== 'number' || isNaN(dismissedTimestamp)) {
      return false;
    }
    const elapsed = now - dismissedTimestamp;
    return elapsed >= 0 && elapsed < ttl;
  }

  function resolveSmartBannerData(options) {
    const platform = detectPlatform(options.userAgent);
    const dismissed = isBannerDismissed(options.dismissedTimestamp, options.nowEpochMs);
    const isValid = isValidSessionId(options.sessionId) || options.sessionId === 'watcher';
    const deepLinkUrl = platform === 'android'
      ? buildAndroidIntentUrl(options.sessionId, options.riderName)
      : buildNativeDeepLink(options.sessionId, options.riderName);
    const storeUrl = buildStoreUrl(platform);
    const riderClean = (options.riderName || '').trim();
    const title = riderClean ? `Track ${riderClean}'s Ride` : 'TrackMe: Live GPS Rides';
    const subtitle = 'Open in TrackMe app for live turn & arrival alerts';
    const ctaText = 'OPEN';
    const shouldShow = (platform === 'ios' || platform === 'android') && !dismissed && isValid;
    return { shouldShow, platform, deepLinkUrl, storeUrl, title, subtitle, ctaText };
  }

  function clampBatteryLevel(batteryLevel) {
    if (typeof batteryLevel !== 'number' || !Number.isFinite(batteryLevel)) return null;
    if (batteryLevel < 0 || batteryLevel > 100) return null;
    return Math.min(100, Math.max(0, Math.round(batteryLevel)));
  }

  function shouldAnnounceLowBattery(previousBattery, newBattery) {
    const prev = clampBatteryLevel(previousBattery);
    const curr = clampBatteryLevel(newBattery);
    if (curr === null) return false;
    if (curr <= 15 && (prev === null || prev > 15)) return true;
    if (curr <= 5 && prev !== null && prev > 5) return true;
    return false;
  }

  function evaluateSpectatorThrottleState(
    isTripEnded,
    isDocumentHidden = false,
    lastInteractionEpochMs = null,
    nowEpochMs = Date.now(),
    riderPowerSave = false,
    riderBatteryLevel = null,
    basePollDelayMs = 5000,
    inactivityThresholdMs = 300000
  ) {
    if (isTripEnded) {
      return { isInactive: false, isThrottled: false, pollDelayMs: basePollDelayMs, shouldAnimateMap: false, noticeText: null };
    }
    if (isDocumentHidden) {
      return { isInactive: false, isThrottled: true, pollDelayMs: 30000, shouldAnimateMap: false, noticeText: null };
    }
    const elapsed = lastInteractionEpochMs !== null && Number.isFinite(lastInteractionEpochMs)
      ? Math.max(0, nowEpochMs - lastInteractionEpochMs)
      : 0;
    const isInactive = lastInteractionEpochMs !== null && elapsed >= inactivityThresholdMs;
    if (isInactive) {
      return {
        isInactive: true,
        isThrottled: true,
        pollDelayMs: 15000,
        shouldAnimateMap: false,
        noticeText: 'Viewer idle · Updates slowed to save battery',
      };
    }
    const clampedBat = clampBatteryLevel(riderBatteryLevel);
    const isEffectivePowerSave = Boolean(riderPowerSave) || (clampedBat !== null && clampedBat <= 15);
    if (isEffectivePowerSave) {
      return {
        isInactive: false,
        isThrottled: true,
        pollDelayMs: 12000,
        shouldAnimateMap: true,
        noticeText: 'Power save active · Location updates every ~15s',
      };
    }
    return {
      isInactive: false,
      isThrottled: false,
      pollDelayMs: basePollDelayMs,
      shouldAnimateMap: true,
      noticeText: null,
    };
  }

  function computeViewerAdaptivePollMs(isPowerSaveMode, batteryLevel, basePollMs = 5000) {
    const clampedBat = clampBatteryLevel(batteryLevel);
    const isEffectivePowerSave = Boolean(isPowerSaveMode) || (clampedBat !== null && clampedBat <= 15);
    return isEffectivePowerSave ? 12000 : basePollMs;
  }

  function formatPowerSaveCadenceNotice(isPowerSaveMode, batteryLevel) {
    const clampedBat = clampBatteryLevel(batteryLevel);
    const isEffectivePowerSave = Boolean(isPowerSaveMode) || (clampedBat !== null && clampedBat <= 15);
    if (!isEffectivePowerSave) return null;
    return 'Power save active · Location updates every ~15s';
  }

  function computePerpendicularDistanceMeters(p, a, b) {
    const latRad = (a[0] * Math.PI) / 180.0;
    const cosLat = Math.cos(latRad);
    const mPerDegLat = 111320;
    const mPerDegLng = 111320 * cosLat;
    const dxAB = (b[1] - a[1]) * mPerDegLng;
    const dyAB = (b[0] - a[0]) * mPerDegLat;
    const dxAP = (p[1] - a[1]) * mPerDegLng;
    const dyAP = (p[0] - a[0]) * mPerDegLat;
    const segmentLenSq = dxAB * dxAB + dyAB * dyAB;
    if (segmentLenSq === 0) {
      return Math.sqrt(dxAP * dxAP + dyAP * dyAP);
    }
    const crossProduct = Math.abs(dxAB * dyAP - dyAB * dxAP);
    return crossProduct / Math.sqrt(segmentLenSq);
  }

  function decimatePolyline(points, epsilonMeters = 3.5, minPointsThreshold = 200) {
    if (!Array.isArray(points) || points.length <= 2) return points || [];
    if (minPointsThreshold > 0 && points.length <= minPointsThreshold) return points;

    function rdp(pts, startIndex, endIndex, epsilon, keepIndices) {
      let maxDist = 0;
      let maxIndex = startIndex;
      const first = pts[startIndex];
      const last = pts[endIndex];
      for (let i = startIndex + 1; i < endIndex; i++) {
        const dist = computePerpendicularDistanceMeters(pts[i], first, last);
        if (dist > maxDist) {
          maxDist = dist;
          maxIndex = i;
        }
      }
      if (maxDist > epsilon) {
        keepIndices.add(maxIndex);
        rdp(pts, startIndex, maxIndex, epsilon, keepIndices);
        rdp(pts, maxIndex, endIndex, epsilon, keepIndices);
      }
    }

    const keepIndices = new Set();
    keepIndices.add(0);
    keepIndices.add(points.length - 1);
    rdp(points, 0, points.length - 1, epsilonMeters, keepIndices);

    const result = [];
    for (let i = 0; i < points.length; i++) {
      if (keepIndices.has(i)) result.push(points[i]);
    }
    return result;
  }

  function computeAverageSpeed(distanceMeters, durationSeconds, useMiles = false) {
    if (distanceMeters === null || distanceMeters === undefined || !Number.isFinite(distanceMeters) || distanceMeters < 0) return null;
    if (durationSeconds === null || durationSeconds === undefined || !Number.isFinite(durationSeconds) || durationSeconds < 5) return null;
    if (distanceMeters === 0) return 0;
    const speedKmh = (distanceMeters / 1000) / (durationSeconds / 3600);
    if (!Number.isFinite(speedKmh) || speedKmh > 200) return null;
    const speed = useMiles ? speedKmh * 0.621371 : speedKmh;
    return Math.round(speed * 10) / 10;
  }

  function formatAverageSpeed(averageSpeed, useMiles = false) {
    if (averageSpeed === null || averageSpeed === undefined || !Number.isFinite(averageSpeed) || averageSpeed < 0) return null;
    return `${averageSpeed.toFixed(1)} ${useMiles ? 'mph' : 'km/h'}`;
  }

  function computeOffCenterDistanceMeters(lat1, lon1, lat2, lon2) {
    if (!Number.isFinite(lat1) || !Number.isFinite(lon1) || !Number.isFinite(lat2) || !Number.isFinite(lon2)) return 0;
    const R = 6371000;
    const dLat = ((lat2 - lat1) * Math.PI) / 180.0;
    const dLon = ((lon2 - lon1) * Math.PI) / 180.0;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180.0) * Math.cos((lat2 * Math.PI) / 180.0) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  }

  function formatOffCenterDistance(distanceMeters, useMiles = false, thresholdMeters = 250) {
    if (distanceMeters === null || distanceMeters === undefined || !Number.isFinite(distanceMeters) || distanceMeters < thresholdMeters) return null;
    if (useMiles) {
      return `${(distanceMeters / 1609.344).toFixed(1)} mi`;
    }
    return `${(distanceMeters / 1000.0).toFixed(1)} km`;
  }

  function formatRecenterButtonLabel(distanceMeters, useMiles = false, thresholdMeters = 250, baseLabel = 'Recenter') {
    const distStr = formatOffCenterDistance(distanceMeters, useMiles, thresholdMeters);
    return distStr ? `${baseLabel} · ${distStr}` : baseLabel;
  }

  function formatRecenterAccessibilityLabel(distanceMeters, useMiles = false, thresholdMeters = 250, baseLabel = 'Recenter on rider') {
    const distStr = formatOffCenterDistance(distanceMeters, useMiles, thresholdMeters);
    return distStr ? `${baseLabel}, ${distStr} away` : baseLabel;
  }

  function shouldResumeFollowMode(isFollowing, isEnded, lastInteractionEpochMs, nowEpochMs = Date.now(), timeoutMs = 20000) {
    if (isFollowing || isEnded) return false;
    if (!lastInteractionEpochMs || !Number.isFinite(lastInteractionEpochMs) || lastInteractionEpochMs <= 0) return false;
    return (nowEpochMs - lastInteractionEpochMs) >= timeoutMs;
  }

  function formatElapsedDuration(startedAt, endedAt, referenceNowMs) {
    if (!startedAt) return null;
    const startMs = typeof startedAt === 'number' ? startedAt : new Date(startedAt).getTime();
    if (!Number.isFinite(startMs) || startMs <= 0) return null;
    const nowFallback = typeof referenceNowMs === 'number' && Number.isFinite(referenceNowMs) ? referenceNowMs : Date.now();
    const endMs = endedAt ? (typeof endedAt === 'number' ? endedAt : new Date(endedAt).getTime()) : nowFallback;
    const diffMs = Math.max(0, (Number.isFinite(endMs) ? endMs : nowFallback) - startMs);
    const totalMinutes = Math.floor(diffMs / 60000);
    if (totalMinutes < 1) return '< 1m';
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours === 0) return `${minutes}m`;
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  }

  function formatDeadlineStatus(deadlineRaw, isStopped, referenceNowMs) {
    if (isStopped || !deadlineRaw) return null;
    const deadlineMs = typeof deadlineRaw === 'number' ? deadlineRaw : new Date(deadlineRaw).getTime();
    if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) return null;
    const nowMs = typeof referenceNowMs === 'number' && Number.isFinite(referenceNowMs) ? referenceNowMs : Date.now();
    const isOverdue = nowMs > deadlineMs;
    const timeString = new Date(deadlineMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return {
      isOverdue,
      displayText: isOverdue ? `Overdue · Expected by ${timeString}` : `Expected by ${timeString}`,
    };
  }

  function computePathDistanceMeters(rawPath) {
    if (!Array.isArray(rawPath) || rawPath.length < 2) return 0;
    let totalMeters = 0;
    let prev = null;
    const toRad = (deg) => (deg * Math.PI) / 180;
    for (let i = 0; i < rawPath.length; i++) {
      const pt = rawPath[i];
      let lat = null;
      let lng = null;
      if (Array.isArray(pt) && pt.length >= 2) {
        lat = typeof pt[0] === 'number' ? pt[0] : parseFloat(pt[0]);
        lng = typeof pt[1] === 'number' ? pt[1] : parseFloat(pt[1]);
      } else if (pt && typeof pt === 'object') {
        lat = typeof pt.lat === 'number' ? pt.lat : (typeof pt.latitude === 'number' ? pt.latitude : parseFloat(pt.lat || pt.latitude));
        lng = typeof pt.lng === 'number' ? pt.lng : (typeof pt.longitude === 'number' ? pt.longitude : parseFloat(pt.lng || pt.longitude));
      }
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180 || (Math.abs(lat) < 0.0001 && Math.abs(lng) < 0.0001)) {
        continue;
      }
      if (prev) {
        const dLat = toRad(lat - prev.lat);
        const dLng = toRad(lng - prev.lng);
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(toRad(prev.lat)) * Math.cos(toRad(lat)) *
          Math.sin(dLng / 2) * Math.sin(dLng / 2);
        const d = 2 * 6371000 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
        if (d >= 2 && d <= 50000) {
          totalMeters += d;
          prev = { lat, lng };
        }
      } else {
        prev = { lat, lng };
      }
    }
    return Math.round(totalMeters);
  }

  function evaluateLivePauseState(data) {
    if (!data || typeof data !== 'object') {
      return {
        isPaused: false,
        pauseReason: null,
        statusLabel: 'Live',
        speedLabel: '0 km/h',
        metaLabel: 'Live GPS',
        bannerText: '',
        a11ySummary: 'Rider live location',
      };
    }
    const status = typeof data.status === 'string' ? data.status.trim().toLowerCase() : '';
    const isStopped = status === 'stopped' || status === 'ended';
    if (isStopped) {
      return {
        isPaused: false,
        pauseReason: null,
        statusLabel: 'Sharing Stopped',
        speedLabel: 'Stopped',
        metaLabel: 'Final location',
        bannerText: '',
        a11ySummary: 'Live sharing stopped',
      };
    }
    const loc = data.lastLocation && typeof data.lastLocation === 'object' ? data.lastLocation : null;
    const isPaused = Boolean(data.isPaused || (loc && loc.isPaused) || status === 'paused');
    if (!isPaused) {
      return {
        isPaused: false,
        pauseReason: null,
        statusLabel: 'Live',
        speedLabel: '',
        metaLabel: 'Live GPS',
        bannerText: '',
        a11ySummary: 'Rider live location active',
      };
    }
    const rawReason = data.pauseReason !== undefined && data.pauseReason !== null
      ? data.pauseReason
      : (loc ? loc.pauseReason : null);
    const cleanReason = typeof rawReason === 'string' ? rawReason.trim().toLowerCase() : '';
    const pauseReason = cleanReason === 'auto' ? 'auto' : (cleanReason === 'manual' ? 'manual' : null);
    if (pauseReason === 'auto') {
      return {
        isPaused: true,
        pauseReason: 'auto',
        statusLabel: 'Auto-Paused',
        speedLabel: 'Auto-paused',
        metaLabel: 'Auto-paused',
        bannerText: 'Rider is auto-paused while stationary · Live route will resume on movement',
        a11ySummary: 'Rider auto-paused while stationary',
      };
    }
    return {
      isPaused: true,
      pauseReason,
      statusLabel: 'Ride Paused',
      speedLabel: 'Paused',
      metaLabel: 'Tracking paused',
      bannerText: pauseReason === 'manual'
        ? 'Rider paused live tracking'
        : 'Rider tracking is currently paused',
      a11ySummary: 'Rider tracking paused',
    };
  }

  return {
    PREFERRED_UNITS_STORAGE_KEY,
    VALID_SESSION_ID_REGEX,
    CAMERA_DEADBAND_METERS,
    COMPASS_BEARING_DEADBAND_DEGREES,
    SMART_BANNER_DISMISS_TTL_MS,
    STORE_URLS,
    resolveInitialUnits,
    toggleUnitSystem,
    formatViewerSpeed,
    formatViewerDistance,
    sanitizeRiderName,
    buildLiveShareUrl,
    resolveLiveShareMetadata,
    evaluateLivePauseState,
    VIEWER_PING_BASE_MS,
    VIEWER_PING_THROTTLED_MS,
    VIEWER_PING_MAX_BACKOFF_MS,
    ZERO_VIEWER_HIBERNATION_THRESHOLD_MS,
    ZERO_VIEWER_HIBERNATION_INTERVAL_MS,
    computeBackoffDelay,
    shouldSkipPresencePing,
    computeViewerPingDelay,
    evaluateZeroViewerHibernation,
    buildZeroViewerHibernationTelemetryPayload,
    computeHaversineDistanceMeters,
    shouldPanCamera,
    shouldUpdateContinuousHeading,
    parseLiveSessionPath,
    isValidSessionId,
    detectPlatform,
    buildNativeDeepLink,
    buildAndroidIntentUrl,
    buildStoreUrl,
    isBannerDismissed,
    resolveSmartBannerData,
    clampBatteryLevel,
    shouldAnnounceLowBattery,
    evaluateSpectatorThrottleState,
    computeViewerAdaptivePollMs,
    formatPowerSaveCadenceNotice,
    computePerpendicularDistanceMeters,
    decimatePolyline,
    computeAverageSpeed,
    formatAverageSpeed,
    computeOffCenterDistanceMeters,
    formatOffCenterDistance,
    formatRecenterButtonLabel,
    formatRecenterAccessibilityLabel,
    shouldResumeFollowMode,
    formatElapsedDuration,
    formatDeadlineStatus,
    computePathDistanceMeters,
  };
});
