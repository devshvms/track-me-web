import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut, signInWithPopup, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, collection, getCountFromServer } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

const firebaseConfig = {
  projectId: "trackme-android-1234",
  appId: "1:126912105508:web:980a4522cf6071a2df1cb1",
  storageBucket: "trackme-android-1234.firebasestorage.app",
  apiKey: "REDACTED-FIREBASE-KEY",
  authDomain: "trackme-android-1234.firebaseapp.com",
  messagingSenderId: "126912105508",
  projectNumber: "126912105508"
};

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

async function authFetch(url, options = {}) {
    if (!auth.currentUser) {
        throw new Error('Admin is not signed in.');
    }

    const idToken = await auth.currentUser.getIdToken();
    return fetch(url, {
        ...options,
        headers: {
            ...(options.headers || {}),
            'Authorization': `Bearer ${idToken}`
        }
    });
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
            } else {
                // Not an admin
                throw new Error('Access Denied. You do not have administrator privileges.');
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
async function loadConfig() {
    try {
        const configRef = doc(db, 'app_config', 'global_settings');
        const configSnap = await getDoc(configRef);
        
        if (configSnap.exists()) {
            const data = configSnap.data();
            cfgMaintenance.checked = data.maintenance_mode || false;
            cfgLiveShare.checked = data.enable_live_sharing !== false; // default true
            cfgExports.checked = data.enable_archive_export !== false; // default true
            cfgAnnouncement.value = data.system_announcement || '';
            cfgMinAndroid.value = data.force_update_version_android || '';
        }
    } catch (err) {
        console.error("Error loading config:", err);
    }
}

saveConfigBtn.addEventListener('click', async () => {
    if (!currentAdmin) return;
    saveConfigBtn.textContent = 'Saving...';
    saveConfigBtn.disabled = true;
    
    try {
        const configRef = doc(db, 'app_config', 'global_settings');
        await setDoc(configRef, {
            maintenance_mode: cfgMaintenance.checked,
            enable_live_sharing: cfgLiveShare.checked,
            enable_archive_export: cfgExports.checked,
            system_announcement: cfgAnnouncement.value,
            force_update_version_android: cfgMinAndroid.value,
            updatedAt: new Date(),
            updatedBy: currentAdmin.email
        }, { merge: true });
        
        setTimeout(() => {
            saveConfigBtn.textContent = 'Saved!';
            setTimeout(() => {
                saveConfigBtn.textContent = 'Save Changes';
                saveConfigBtn.disabled = false;
            }, 2000);
        }, 500);
    } catch (err) {
        console.error("Error saving config:", err);
        saveConfigBtn.textContent = 'Error';
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
