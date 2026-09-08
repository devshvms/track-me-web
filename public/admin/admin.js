import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut, signInWithPopup, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getFirestore, collection, getCountFromServer } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { resolvePosthogDashboard } from "/admin/posthog-state.mjs";

// Firebase config is provided by /firebase-config.js (loaded via a script tag
// before this module). See public/firebase-config.example.js.
const firebaseConfig = window.__FIREBASE_CONFIG__;
if (!firebaseConfig) {
  throw new Error("Missing Firebase config: include firebase-config.js before admin.js");
}

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();
const db = getFirestore(app);

// DOM Elements
const authOverlay = document.getElementById('auth-overlay');
const dashboardLayout = document.getElementById('admin-dashboard');
const authError = document.getElementById('auth-error');
const adminLoginBtn = document.getElementById('admin-login-btn');
const returnHomeBtn = document.getElementById('return-home-btn');
const adminEmailSpan = document.getElementById('admin-email');
const signOutBtn = document.getElementById('sign-out-btn');

// Config Elements
const cfgMaintenance = document.getElementById('cfg-maintenance');
const cfgLiveShare = document.getElementById('cfg-live-share');
const cfgExports = document.getElementById('cfg-exports');
const cfgAnnouncement = document.getElementById('cfg-announcement');
const cfgMinAndroid = document.getElementById('cfg-min-android');
const saveConfigBtn = document.getElementById('save-config-btn');
const configStatus = document.getElementById('config-status');

// Metrics Elements
const metricUsers = document.getElementById('metric-users');
const metricLive = document.getElementById('metric-live');
const metricExportQueued = document.getElementById('metric-export-queued');
const metricExportProcessing = document.getElementById('metric-export-processing');
const metricExportCompleted = document.getElementById('metric-export-completed');
const refreshMetricsBtn = document.getElementById('refresh-metrics-btn');
const processExportQueueBtn = document.getElementById('process-export-queue-btn');


// User Support Elements
const searchUserInput = document.getElementById('search-user-input');
const searchUserBtn = document.getElementById('search-user-btn');
const userResult = document.getElementById('user-result');

// Admin Auth State
let currentAdmin = null;
let saveConfigResetTimer = null;

async function authFetch(url, options = {}) {
    if (!auth.currentUser) {
        throw new Error('Admin is not signed in.');
    }

    const idToken = await auth.currentUser.getIdToken(true);
    return fetch(url, {
        ...options,
        headers: {
            ...(options.headers || {}),
            'Authorization': `Bearer ${idToken}`
        }
    });
}

async function responseError(response, fallbackMessage) {
    const data = await response.json().catch(() => ({}));
    return new Error(data.error || `${fallbackMessage} (HTTP ${response.status})`);
}

onAuthStateChanged(auth, async (user) => {
    if (user) {
        try {
            const adminResponse = await authFetch('/api/admin/me');
            const isAllowed = adminResponse.ok;
            
            if (isAllowed) {
                currentAdmin = user;
                adminEmailSpan.textContent = user.email;
                authOverlay.classList.add('hidden');
                dashboardLayout.classList.remove('hidden');

                loadConfig();
                loadMetrics();
                loadTelemetry();
                initPosthogEmbed();
            } else {
                const errorData = await adminResponse.json().catch(() => ({}));
                throw new Error(errorData.error || 'Access Denied. You do not have administrator privileges.');
            }
        } catch (err) {
            console.error("Auth Error:", err);
            currentAdmin = null;
            authError.textContent = err.message || "Authentication failed.";
            authError.classList.remove('hidden');
            adminLoginBtn.classList.remove('hidden');
            adminLoginBtn.disabled = false;
            adminLoginBtn.textContent = "Switch Account / Sign In with Google";
            returnHomeBtn.classList.remove('hidden');
            document.querySelector('.spinner').classList.add('hidden');
        }
    } else {
        currentAdmin = null;
        // Don't show an error if they just landed on the page for the first time
        if (adminLoginBtn.textContent === 'Signing in...') {
            authError.textContent = "Access Denied. You do not have administrator privileges.";
            authError.classList.remove('hidden');
        }
        adminLoginBtn.classList.remove('hidden');
        adminLoginBtn.disabled = false;
        adminLoginBtn.textContent = "Sign in with Google";
        returnHomeBtn.classList.remove('hidden');
        document.querySelector('.spinner').classList.add('hidden');
    }
});

adminLoginBtn.addEventListener('click', () => {
    adminLoginBtn.disabled = true;
    adminLoginBtn.textContent = "Signing in...";
    authError.classList.add('hidden');
    
    signInWithPopup(auth, provider).catch((error) => {
        console.error("Login failed:", error);
        authError.textContent = error.message;
        authError.classList.remove('hidden');
        adminLoginBtn.disabled = false;
        adminLoginBtn.textContent = "Sign in with Google";
    });
});

signOutBtn.addEventListener('click', () => {
    signOut(auth).then(() => {
        window.location.href = '/';
    });
});

// --- Tab Navigation ---
const navItems = document.querySelectorAll('.nav-item');
const tabPanes = document.querySelectorAll('.tab-pane');

navItems.forEach(item => {
    item.addEventListener('click', (e) => {
        e.preventDefault();
        navItems.forEach(nav => nav.classList.remove('active'));
        tabPanes.forEach(tab => tab.classList.remove('active'));
        
        item.classList.add('active');
        const targetId = item.getAttribute('data-target');
        document.getElementById(targetId).classList.add('active');
    });
});

// --- Remote Config ---
function setConfigStatus(message, type) {
    if (!configStatus) return;
    configStatus.textContent = message;
    configStatus.className = `status-message ${type}`;
}

function clearConfigStatus() {
    if (!configStatus) return;
    configStatus.textContent = '';
    configStatus.className = 'status-message hidden';
}

async function loadConfig() {
    clearConfigStatus();
    try {
        const response = await authFetch('/api/admin/config');
        if (!response.ok) {
            throw await responseError(response, 'Could not load Remote Config');
        }

        const { config } = await response.json();
        cfgMaintenance.checked = config.maintenance_mode === true;
        cfgLiveShare.checked = config.enable_live_sharing !== false;
        cfgExports.checked = config.enable_archive_export !== false;
        cfgAnnouncement.value = config.system_announcement || '';
        cfgMinAndroid.value = config.force_update_version_android || '';
    } catch (err) {
        console.error("Error loading config:", err);
        setConfigStatus(`Could not load Remote Config: ${err.message || 'Unknown error.'}`, 'error');
    }
}

saveConfigBtn.addEventListener('click', async () => {
    if (!currentAdmin) {
        setConfigStatus('You must be signed in as an admin to save changes.', 'error');
        return;
    }

    clearConfigStatus();
    if (saveConfigResetTimer) {
        clearTimeout(saveConfigResetTimer);
        saveConfigResetTimer = null;
    }
    saveConfigBtn.textContent = 'Saving...';
    saveConfigBtn.disabled = true;
    
    try {
        const response = await authFetch('/api/admin/config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                maintenance_mode: cfgMaintenance.checked,
                enable_live_sharing: cfgLiveShare.checked,
                enable_archive_export: cfgExports.checked,
                system_announcement: cfgAnnouncement.value,
                force_update_version_android: cfgMinAndroid.value
            })
        });

        if (!response.ok) {
            throw await responseError(response, 'Could not save Remote Config');
        }

        saveConfigBtn.textContent = 'Saved!';
        setConfigStatus('Remote Config saved successfully.', 'success');
        saveConfigResetTimer = setTimeout(() => {
            saveConfigBtn.textContent = 'Save Changes';
            saveConfigResetTimer = null;
        }, 2000);
    } catch (err) {
        console.error("Error saving config:", err);
        saveConfigBtn.textContent = 'Save Changes';
        setConfigStatus(`Could not save Remote Config: ${err.message || 'Unknown error.'}`, 'error');
    } finally {
        saveConfigBtn.disabled = false;
    }
});

// --- Operational Metrics ---
async function loadMetrics() {
    refreshMetricsBtn.textContent = 'Refreshing...';
    refreshMetricsBtn.disabled = true;
    
    // 1. Total Users
    try {
        const usersColl = collection(db, 'users');
        const usersSnap = await getCountFromServer(usersColl);
        metricUsers.textContent = usersSnap.data().count;
    } catch (e) {
        console.warn("Could not fetch users count:", e.message || e);
        if ((e.code && e.code.includes('permission')) || (e.message && e.message.includes('permission'))) {
            metricUsers.textContent = "🔒 Protected by Rules";
        } else {
            metricUsers.textContent = "N/A";
        }
    }

    // 2. Active Live Sessions
    try {
        const liveColl = collection(db, 'active_shares');
        const liveSnap = await getCountFromServer(liveColl);
        metricLive.textContent = liveSnap.data().count;
    } catch (e) {
        console.warn("Could not fetch live sessions count:", e.message || e);
        if ((e.code && e.code.includes('permission')) || (e.message && e.message.includes('permission'))) {
            metricLive.textContent = "🔒 Protected by Rules";
        } else {
            metricLive.textContent = "0";
        }
    }

    // 3. Export Jobs
    try {
        const exportsResponse = await authFetch('/api/admin/export-metrics');
        if (exportsResponse.ok) {
            const exportsData = await exportsResponse.json();
            metricExportQueued.textContent = exportsData.queued;
            metricExportProcessing.textContent = exportsData.processing;
            metricExportCompleted.textContent = exportsData.completed;
        } else {
            metricExportQueued.textContent = 'Err';
            metricExportProcessing.textContent = 'Err';
            metricExportCompleted.textContent = 'Err';
        }
    } catch (err) {
        console.error("Error loading export metrics:", err);
        metricExportQueued.textContent = 'Err';
    } finally {
        refreshMetricsBtn.textContent = 'Refresh Data';
        refreshMetricsBtn.disabled = false;
    }
}

refreshMetricsBtn.addEventListener('click', loadMetrics);

// --- PostHog Telemetry Stats ---
function initPosthogEmbed() {
    const iframe = document.getElementById('posthog-iframe');
    const fallback = document.getElementById('posthog-fallback');
    const fallbackTitle = document.getElementById('posthog-fallback-title');
    const fallbackMessage = document.getElementById('posthog-fallback-message');
    const description = document.getElementById('posthog-dashboard-description');
    const openLink = document.getElementById('posthog-open-link');
    const dashboardLink = document.getElementById('posthog-dashboard-link');
    const dashboard = resolvePosthogDashboard(window.__POSTHOG_DASHBOARD_URL__);

    if (dashboard.kind === 'invalid' || dashboard.kind === 'missing') {
        if (iframe) {
            iframe.src = 'about:blank';
            iframe.classList.add('hidden');
        }
        if (dashboardLink) dashboardLink.classList.add('hidden');
        if (openLink) openLink.classList.add('hidden');
        if (fallbackTitle) {
            fallbackTitle.textContent = dashboard.kind === 'invalid'
                ? 'PostHog dashboard URL is invalid.'
                : 'PostHog dashboard not configured.';
        }
        if (fallbackMessage) {
            fallbackMessage.textContent = dashboard.kind === 'invalid'
                ? 'Update POSTHOG_DASHBOARD_URL with a valid public shared-dashboard URL.'
                : 'Set POSTHOG_DASHBOARD_URL to a public shared-dashboard URL to enable this panel.';
        }
        if (description) description.textContent = 'Dashboard embedding is unavailable.';
        if (fallback) fallback.classList.remove('hidden');
        return;
    }

    if (dashboard.url) {
        if (openLink) {
            openLink.href = dashboard.url;
            openLink.classList.remove('hidden');
        }
        if (dashboardLink) {
            dashboardLink.href = dashboard.url;
            dashboardLink.classList.remove('hidden');
        }

        if (dashboard.kind === 'embedded') {
            if (iframe) {
                iframe.src = dashboard.url;
                iframe.classList.remove('hidden');
            }
            if (description) description.textContent = 'Live PostHog dashboard, embedded below.';
            if (fallback) fallback.classList.add('hidden');
        } else {
            if (iframe) {
                iframe.src = 'about:blank';
                iframe.classList.add('hidden');
            }
            if (fallbackTitle) fallbackTitle.textContent = 'Authenticated dashboard cannot be embedded.';
            if (fallbackMessage) fallbackMessage.textContent = 'PostHog blocks its signed-in app inside other sites. Open the full dashboard in a new tab instead.';
            if (description) description.textContent = 'This authenticated dashboard is available through the secure PostHog link.';
            if (fallback) fallback.classList.remove('hidden');
        }
    }
}

async function loadTelemetry() {
    const refreshBtn = document.getElementById('refresh-telemetry-btn');
    if (refreshBtn) { refreshBtn.textContent = 'Refreshing...'; refreshBtn.disabled = true; }
    
    try {
        const res = await fetch('/api/telemetry/stats');
        if (res.ok) {
            const data = await res.json();
            const el = (id) => document.getElementById(id);
            if (el('telem-shares-24h')) el('telem-shares-24h').textContent = data.shares24h ?? '--';
            if (el('telem-viewers-24h')) el('telem-viewers-24h').textContent = data.viewers24h ?? '--';
            if (el('telem-total-shares')) el('telem-total-shares').textContent = data.totalShares ?? '--';
            if (el('telem-total-viewers')) el('telem-total-viewers').textContent = data.totalViewers ?? '--';
            if (el('telem-total-hours')) el('telem-total-hours').textContent = data.totalHoursShared ? `${data.totalHoursShared}h` : '0h';
            if (el('telem-updated-at')) el('telem-updated-at').textContent = data.updatedAt ? new Date(data.updatedAt).toLocaleString() : '--';
        } else {
            console.warn('Failed to load telemetry stats:', res.status);
        }
    } catch (err) {
        console.error('Error loading telemetry stats:', err);
    } finally {
        if (refreshBtn) { refreshBtn.textContent = 'Refresh Stats'; refreshBtn.disabled = false; }
    }
}

const refreshTelemetryBtn = document.getElementById('refresh-telemetry-btn');
if (refreshTelemetryBtn) {
    refreshTelemetryBtn.addEventListener('click', loadTelemetry);
}

if (processExportQueueBtn) {
    processExportQueueBtn.addEventListener('click', async () => {
        processExportQueueBtn.disabled = true;
        const originalText = processExportQueueBtn.textContent;
        processExportQueueBtn.textContent = 'Processing...';

        try {
            const res = await authFetch('/api/export/process', { method: 'POST' });
            if (res.ok) {
                const data = await res.json();
                alert(`Batch Processor Success: ${data.message}`);
                await loadMetrics();
            } else {
                alert('Failed to run batch processing endpoint.');
            }
        } catch (e) {
            console.error('Error running export batch processing:', e);
            alert('Error running batch processor.');
        } finally {
            processExportQueueBtn.textContent = originalText;
            processExportQueueBtn.disabled = false;
        }
    });
}


// --- User Support Search ---
searchUserBtn.addEventListener('click', async () => {
    const email = searchUserInput.value.trim();
    if (!email) return;
    
    searchUserBtn.textContent = '...';
    searchUserBtn.disabled = true;
    userResult.classList.add('hidden');
    
    try {
        const res = await authFetch(`/api/admin/user-search?email=${encodeURIComponent(email)}`);
        
        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            if (res.status === 404) {
                alert('User not found in the database.');
            } else {
                alert(errData.error || `Error: HTTP ${res.status}`);
            }
            return;
        }
        
        const result = await res.json();
        
        if (result.found) {
            const u = result.user;
            document.getElementById('res-email').textContent = u.email || email;
            document.getElementById('res-uid').textContent = u.uid;
            document.getElementById('res-os').textContent = u.clientOS || 'Unknown';
            document.getElementById('res-version').textContent = u.appVersion || 'Unknown';
            document.getElementById('res-created').textContent = u.createdAt !== 'N/A' ? new Date(u.createdAt).toLocaleString() : 'N/A';
            document.getElementById('res-login').textContent = u.lastLoginAt !== 'N/A' ? new Date(u.lastLoginAt).toLocaleString() : 'N/A';
            userResult.classList.remove('hidden');
        } else {
            alert('User not found in the database.');
        }
    } catch (err) {
        console.error("Error searching user:", err);
        alert('Error searching for user. Check console for details.');
    } finally {
        searchUserBtn.textContent = 'Search';
        searchUserBtn.disabled = false;
    }
});

// ---------------------------------------------------------------------------
// Broadcast — SCOPE_1.8.7 §6.3 / OPERATOR_BROADCAST.md
//
// This is the only control in the app that interrupts every user at once, so the UI's job is
// mostly to slow the operator down: the tag vocabulary is a closed <select> with no free-form
// option, the confirm step states the audience out loud, and the history is on the same screen
// because most bad broadcasts are a duplicate of a good one sent an hour earlier.
//
// Nothing here can express a promotional message. That is deliberate and it is enforced three
// times — here, on the endpoint, and in both clients' parsers — because a rule that lives only in
// a document loses to a good idea on a slow month.
// ---------------------------------------------------------------------------

const broadcastEls = {
    tag: document.getElementById('broadcast-tag'),
    title: document.getElementById('broadcast-title'),
    body: document.getElementById('broadcast-body'),
    link: document.getElementById('broadcast-link'),
    maxVersion: document.getElementById('broadcast-max-version'),
    versionRow: document.getElementById('broadcast-version-row'),
    sendBtn: document.getElementById('send-broadcast-btn'),
    status: document.getElementById('broadcast-status'),
    history: document.getElementById('broadcast-history'),
    titleCount: document.getElementById('broadcast-title-count'),
    bodyCount: document.getElementById('broadcast-body-count'),
};

function broadcastStatus(message, isError) {
    if (!broadcastEls.status) return;
    broadcastEls.status.textContent = message;
    broadcastEls.status.classList.remove('hidden');
    broadcastEls.status.classList.toggle('error-msg', Boolean(isError));
}

function syncBroadcastForm() {
    if (!broadcastEls.tag) return;
    // The version ceiling exists so an update notice is TRUE for the device that receives it. It
    // is meaningless on the other two tags, and the endpoint rejects it there, so it is hidden
    // rather than merely ignored — an input that is silently discarded is worse than absent.
    broadcastEls.versionRow.classList.toggle('hidden', broadcastEls.tag.value !== 'UPDATE');
    broadcastEls.titleCount.textContent = String(broadcastEls.title.value.trim().length);
    broadcastEls.bodyCount.textContent = String(broadcastEls.body.value.trim().length);
}

function renderBroadcastHistory(broadcasts) {
    if (!broadcastEls.history) return;
    broadcastEls.history.innerHTML = '';
    if (!broadcasts.length) {
        const empty = document.createElement('li');
        empty.textContent = 'Nothing has been broadcast yet.';
        broadcastEls.history.appendChild(empty);
        return;
    }
    for (const item of broadcasts) {
        const row = document.createElement('li');
        const when = new Date(item.created_at_millis).toLocaleString();
        const tag = document.createElement('strong');
        tag.textContent = `${item.tag} · ${when}`;
        const title = document.createElement('div');
        // textContent throughout: these strings are read back from Firestore and rendered in an
        // authenticated admin page. innerHTML here would make the broadcast body a stored-XSS
        // vector against the one account that can send broadcasts.
        title.textContent = item.title;
        const body = document.createElement('div');
        body.className = 'config-hint';
        body.textContent = item.body;
        row.append(tag, title, body);
        broadcastEls.history.appendChild(row);
    }
}

async function loadBroadcastHistory() {
    try {
        const response = await authFetch('/api/admin/broadcast');
        if (!response.ok) throw await responseError(response, 'Could not load broadcast history');
        const data = await response.json();
        renderBroadcastHistory(data.broadcasts || []);
    } catch (error) {
        broadcastStatus(error.message, true);
    }
}

async function sendBroadcast() {
    const title = broadcastEls.title.value.trim();
    const body = broadcastEls.body.value.trim();
    if (!title || !body) {
        broadcastStatus('A broadcast needs a title and a body.', true);
        return;
    }

    // Stating the audience in the confirm rather than a generic "Are you sure?". The number of
    // people is the whole reason to hesitate, and a dialog that does not say it is just a click.
    const confirmed = window.confirm(
        `Send this to every install with notifications enabled, on both platforms, right now?\n\n` +
        `${broadcastEls.tag.value}\n${title}\n\n${body}\n\n` +
        `There is no undo, and nothing promotional may be sent here.`
    );
    if (!confirmed) return;

    const payload = { tag: broadcastEls.tag.value, title, body };
    const link = broadcastEls.link.value.trim();
    if (link) payload.learn_more_url = link;
    if (broadcastEls.tag.value === 'UPDATE' && broadcastEls.maxVersion.value.trim()) {
        // A dotted release string, not a build number. Android's versionCode and iOS's
        // CFBundleVersion are different integers for the same release, so one number could never
        // mean the same thing on both — the endpoint refuses the old key outright.
        payload.applies_to_releases_at_or_below = broadcastEls.maxVersion.value.trim();
    }

    broadcastEls.sendBtn.disabled = true;
    broadcastStatus('Sending…', false);
    try {
        const response = await authFetch('/api/admin/broadcast', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `Send failed (HTTP ${response.status})`);

        // 202 means recorded but not pushed. Reporting that as success would leave the operator
        // believing people were interrupted when they will only find it on next open — which is
        // the difference between "they know" and "they will, eventually".
        broadcastStatus(
            data.pushed ? 'Sent.' : (data.detail || 'Recorded, but not pushed.'),
            !data.pushed,
        );
        broadcastEls.title.value = '';
        broadcastEls.body.value = '';
        broadcastEls.link.value = '';
        broadcastEls.maxVersion.value = '';
        syncBroadcastForm();
        loadBroadcastHistory();
    } catch (error) {
        broadcastStatus(error.message, true);
    } finally {
        broadcastEls.sendBtn.disabled = false;
    }
}

if (broadcastEls.sendBtn) {
    broadcastEls.sendBtn.addEventListener('click', sendBroadcast);
    broadcastEls.tag.addEventListener('change', syncBroadcastForm);
    broadcastEls.title.addEventListener('input', syncBroadcastForm);
    broadcastEls.body.addEventListener('input', syncBroadcastForm);
    document.querySelector('[data-target="tab-broadcast"]')
        ?.addEventListener('click', loadBroadcastHistory);
    syncBroadcastForm();
}
