import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut, onAuthStateChanged, deleteUser } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getFirestore, collection, getDocs, deleteDoc, addDoc, query, where, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// Firebase config is provided by /firebase-config.js (loaded via a script tag
// before this module). See public/firebase-config.example.js.
const firebaseConfig = window.__FIREBASE_CONFIG__;
if (!firebaseConfig) {
  throw new Error("Missing Firebase config: include firebase-config.js before app.js");
}

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();

// UI Elements
const authButton = document.getElementById("auth-button");
const accountSection = document.getElementById("account");
const accountLink = document.getElementById("account-link");
const userNameSpan = document.getElementById("user-name");
const userEmailSpan = document.getElementById("user-email");
const confirmInput = document.getElementById("confirm-delete");
const deleteBtn = document.getElementById("delete-account-btn");
const feedbackInput = document.getElementById("feedback");
const messageEl = document.getElementById("delete-message");
const accountSignedOut = document.getElementById("account-signed-out");
const accountSignedIn = document.getElementById("account-signed-in");
const accountSignInButton = document.getElementById("account-sign-in");
const isV2Landing = document.body.dataset.landingVariant === "v2";

let currentUser = null;

onAuthStateChanged(auth, (user) => {
    if (user) {
        currentUser = user;
        authButton.textContent = "Sign Out";
        if (isV2Landing) {
            accountSection.dataset.authState = "signed-in";
            accountSignedOut.hidden = true;
            accountSignedIn.hidden = false;
        } else {
            accountSection.classList.remove("hidden");
            accountLink.style.display = "inline-block";
        }
        userNameSpan.textContent = user.displayName || "Explorer";
        userEmailSpan.textContent = user.email;
        checkExportStatus(user.uid);
    } else {
        currentUser = null;
        authButton.textContent = "Sign In";
        if (isV2Landing) {
            accountSection.dataset.authState = "signed-out";
            accountSignedOut.hidden = false;
            accountSignedIn.hidden = true;
        } else {
            accountSection.classList.add("hidden");
            accountLink.style.display = "none";
        }
        confirmInput.value = "";
        deleteBtn.disabled = true;
        messageEl.textContent = "";
        messageEl.style.color = "";
    }
});

function handleAuthAction() {
    if (currentUser) {
        signOut(auth);
    } else {
        signInWithPopup(auth, provider).catch(error => {
            console.error("Auth error:", error);
            alert("Sign in failed: " + error.message);
        });
    }
}

authButton.addEventListener("click", handleAuthAction);
if (accountSignInButton) accountSignInButton.addEventListener("click", handleAuthAction);
window.__TRACKME_AUTH_READY__ = true;

confirmInput.addEventListener("input", (e) => {
    if (e.target.value === "DELETE") {
        deleteBtn.disabled = false;
    } else {
        deleteBtn.disabled = true;
    }
});

deleteBtn.addEventListener("click", async () => {
    if (!currentUser || confirmInput.value !== "DELETE") return;

    const confirmWipe = confirm("Are you absolutely sure? This will delete all your GPS rides and your account. This cannot be undone.");
    if (!confirmWipe) return;

    deleteBtn.disabled = true;
    messageEl.textContent = "Deleting data... please wait.";
    messageEl.style.color = "#1976d2";

    try {
        const uid = currentUser.uid;

        // 1. Submit feedback
        const feedback = feedbackInput.value.trim();
        if (feedback) {
            await addDoc(collection(db, "feedbacks"), {
                text: feedback,
                type: "account_deletion_web",
                timestamp: serverTimestamp(),
                uid: uid
            });
        }

        // 2. Delete all rides and their points
        const ridesRef = collection(db, "users", uid, "rides");
        const ridesSnapshot = await getDocs(ridesRef);

        for (const rideDoc of ridesSnapshot.docs) {
            const pointsRef = collection(rideDoc.ref, "points");
            const pointsSnapshot = await getDocs(pointsRef);
            for (const pointDoc of pointsSnapshot.docs) {
                await deleteDoc(pointDoc.ref);
            }
            await deleteDoc(rideDoc.ref);
        }

        // 3. Delete emergency configuration, emergency delivery logs, and authored feedback.
        for (const collectionName of ["emergency_config", "emergency_logs"]) {
            const records = await getDocs(collection(db, "users", uid, collectionName));
            for (const record of records.docs) {
                await deleteDoc(record.ref);
            }
        }

        const feedbackRecords = await getDocs(
            query(collection(db, "feedbacks"), where("uid", "==", uid))
        );
        for (const feedbackRecord of feedbackRecords.docs) {
            await deleteDoc(feedbackRecord.ref);
        }

        // 4. Delete auth user
        await deleteUser(currentUser);
        
        messageEl.textContent = "Account successfully deleted.";
        messageEl.style.color = "green";
    } catch (error) {
        console.error("Delete failed:", error);
        if (error.code === 'auth/requires-recent-login') {
            messageEl.textContent = "Error: Please sign out and sign back in to verify your identity before deleting your account.";
        } else {
            messageEl.textContent = "Error: " + error.message;
        }
        messageEl.style.color = "red";
        deleteBtn.disabled = false;
    }
});

// --- Data Portability & Archive Export Logic ---
function displayExportStatus(data) {
    const container = document.getElementById('export-status-container');
    const iconEl = document.getElementById('export-status-icon');
    const titleEl = document.getElementById('export-status-title');
    const messageEl = document.getElementById('export-status-message');
    const downloadAction = document.getElementById('export-download-action');
    const downloadLink = document.getElementById('export-download-link');
    const requestBtn = document.getElementById('export-request-btn');

    if (!container) return;
    container.style.display = 'block';
    container.hidden = false;

    if (data.status === 'COMPLETED') {
        if (requestBtn) requestBtn.style.display = 'none'; // Hide duplicate blue button
        if (requestBtn) requestBtn.hidden = true;
        iconEl.textContent = '✅';
        titleEl.textContent = 'Archive Ready for Download';
        messageEl.textContent = 'Your archive is ready. The ZIP is assembled from your own data when you download it and expires after the retention window.';
        downloadAction.style.display = 'block';
        downloadAction.hidden = false;
        downloadLink.href = data.downloadUrl || '#';
    } else {
        if (requestBtn) requestBtn.textContent = 'Data Requested...';
        if (requestBtn) requestBtn.disabled = true;
        if (requestBtn) requestBtn.hidden = false;
        iconEl.textContent = '⏳';
        titleEl.textContent = 'Export request is processing';
        messageEl.textContent = 'The export metadata is being prepared. Refresh this section shortly to get the tokenized download link.';
        downloadAction.style.display = 'none';
        downloadAction.hidden = true;
    }
}

async function checkExportStatus(userId) {
    try {
        const idToken = await currentUser.getIdToken(true);
        const res = await fetch(`/api/export/status?userId=${encodeURIComponent(userId)}`, {
            headers: { 'Authorization': `Bearer ${idToken}` }
        });
        if (res.ok) {
            const data = await res.json();
            displayExportStatus(data);
        }
    } catch (err) {
        console.warn('Could not fetch export status:', err);
    }
}

const exportBtn = document.getElementById('export-request-btn');
if (exportBtn) {
    exportBtn.addEventListener('click', async () => {
        if (!currentUser) return;
        exportBtn.disabled = true;
        exportBtn.textContent = 'Requesting...';

        try {
            const idToken = await currentUser.getIdToken(true);
            const res = await fetch('/api/export/request', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${idToken}`
                },
                body: JSON.stringify({
                    userId: currentUser.uid,
                    userEmail: currentUser.email,
                    clientOS: 'Web'
                })
            });

            const data = await res.json();
            if (res.ok) {
                displayExportStatus(data);
            } else {
                alert('Export request failed: ' + (data.error || 'Unknown error'));
            }
        } catch (err) {
            alert('Network error requesting data export.');
        } finally {
            exportBtn.disabled = false;
            exportBtn.textContent = 'Download My Data (.zip)';
        }
    });
}

// --- GitHub Releases Fetching Logic ---
// A local copy of the newest release, used ONLY when the GitHub API is unreachable or rate-limited
// — an unauthenticated browser gets 60 requests/hour per IP, so this is a real case rather than a
// theoretical one. When the API does answer, its copy wins and this is discarded.
//
// Keep this in step with the newest published release. It is easy to forget, which is exactly why
// the merge below no longer trusts its position.
const pinnedReleases = {
    'track-me-android': [
        {
            tag_name: 'v1.8.4',
            name: 'TrackMe v1.8.4',
            published_at: '2026-08-22T21:40:00Z',
            body: [
                'Floating dashboard — your distance, pace and time stay on screen while you navigate in another app. Tap the home gesture mid-ride and TrackMe shrinks into a corner window instead of disappearing.',
                'Share images now match their preview exactly, and the stats panel is sized to fit its text instead of a fixed band.',
                'Fixes and polish across ride history and group rides.'
            ].join('\n\n')
        },
        {
            tag_name: 'v1.8.3',
            name: 'TrackMe v1.8.3',
            published_at: '2026-08-22T10:16:05Z',
            body: [
                'Fixes a startup crash that stopped the app from opening on fresh installs.',
                'Everything from 1.8.2: try the app during the walkthrough with real controls, a sample ride waiting in History on day one, and rebuilt intro screens.'
            ].join('\n\n')
        }
    ],
    'track-me-ios': [
        {
            tag_name: 'v1.8.4',
            name: 'TrackMe v1.8.4',
            published_at: '2026-08-22T21:41:29Z',
            body: [
                'Live Activity & Dynamic Island — keep your distance, pace, and duration visible on your Lock Screen and Dynamic Island during rides.',
                'Siri ride actions — start, pause, resume, and finish your rides hands-free.',
                'Siri ride queries — ask Siri for your current distance, pace, and ride duration hands-free.',
                'Share images now match their preview with compact duration formatting and refined theme styling.'
            ].join('\n\n')
        },
        {
            tag_name: 'v1.8.3',
            name: 'TrackMe v1.8.3',
            published_at: '2026-08-22T10:16:05Z',
            body: [
                'Version alignment with Android 1.8.3.',
                'Everything from 1.8.2: try the app during the walkthrough with real controls, a sample ride waiting in History on day one, and rebuilt intro screens.'
            ].join('\n\n')
        }
    ]
};

function normalizeReleaseTag(tag) {
    return String(tag || '').trim().replace(/^v/i, '');
}

function mergePinnedReleases(repoName, releases) {
    const pinned = pinnedReleases[repoName] || [];
    const pinnedTags = new Set(pinned.map(release => normalizeReleaseTag(release.tag_name)));
    const merged = [...pinned, ...releases.filter(release => !pinnedTags.has(normalizeReleaseTag(release.tag_name)))];

    // Sort by publish date, newest first — never by source.
    //
    // Pinned entries used to be prepended unconditionally, so the hardcoded fallback always landed
    // at index 0, and index 0 is the row that renders expanded. The moment a newer release shipped
    // without someone remembering to update the constant above, the page showed the OLD version at
    // the top with the OLD notes open — which is exactly what happened before 1.7.3.
    //
    // Ordering by date means a stale constant can now only ever be missing, never misleading.
    return merged.sort((a, b) => new Date(b.published_at) - new Date(a.published_at));
}

function escapeReleaseText(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function setupReleaseTabs() {
    const tabList = document.querySelector('.tabs[role="tablist"]');
    if (!tabList) return;

    const tabs = Array.from(tabList.querySelectorAll('[role="tab"]'));
    const activateTab = (selectedTab, moveFocus = false) => {
        tabs.forEach(tab => {
            const isSelected = tab === selectedTab;
            const panel = document.getElementById(tab.dataset.target);
            tab.classList.toggle('active', isSelected);
            tab.setAttribute('aria-selected', String(isSelected));
            tab.tabIndex = isSelected ? 0 : -1;
            if (panel) panel.hidden = !isSelected;
        });
        if (moveFocus) selectedTab.focus();
    };

    tabs.forEach((tab, index) => {
        tab.addEventListener('click', () => activateTab(tab));
        tab.addEventListener('keydown', event => {
            const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
            if (!keys.includes(event.key)) return;
            event.preventDefault();

            let nextIndex = index;
            if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
            if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
            if (event.key === 'Home') nextIndex = 0;
            if (event.key === 'End') nextIndex = tabs.length - 1;
            activateTab(tabs[nextIndex], true);
        });
    });

    activateTab(tabs.find(tab => tab.getAttribute('aria-selected') === 'true') || tabs[0]);
}

async function fetchReleases(repoName, containerId, emptyMessage = 'No public releases yet.') {
    const container = document.getElementById(containerId);
    if (!container) return;

    let releases = mergePinnedReleases(repoName, []);
    try {
        const res = await fetch(`https://api.github.com/repos/devshvms/${repoName}/releases`);
        if (!res.ok) throw new Error('Failed to fetch releases');
        releases = mergePinnedReleases(repoName, await res.json());
    } catch (err) {
        console.warn(`Could not fetch releases for ${repoName}:`, err);
        if (releases.length === 0) {
            container.innerHTML = '<p class="release-empty">Release history is temporarily unavailable.</p>';
            return;
        }
    }

    if (releases.length === 0) {
        container.innerHTML = `<p class="release-empty">${escapeReleaseText(emptyMessage)}</p>`;
        return;
    }

    container.innerHTML = releases.map((release, index) => {
        const isActive = index === 0;
        const version = escapeReleaseText(release.tag_name);
        const releaseName = escapeReleaseText(release.name || release.tag_name);
        const date = new Date(release.published_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
        const bodyHtml = release.body
            ? escapeReleaseText(release.body).split('\n\n').map(paragraph => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`).join('')
            : '<p>No release notes provided.</p>';

        return `
            <article class="release-card ${isActive ? 'active' : ''}">
                <button class="release-header" type="button" aria-expanded="${isActive ? 'true' : 'false'}">
                    <span><strong>${version}</strong><span>${releaseName}</span><small>${date}</small></span>
                    <span class="release-toggle-icon" aria-hidden="true">&#9662;</span>
                </button>
                <div class="release-body">
                    ${bodyHtml}
                </div>
            </article>
        `;
    }).join('');

    container.querySelectorAll('.release-header').forEach(header => {
        header.addEventListener('click', () => {
            const currentCard = header.closest('.release-card');
            const wasActive = currentCard.classList.contains('active');

            container.querySelectorAll('.release-card').forEach(card => {
                card.classList.remove('active');
                const cardHeader = card.querySelector('.release-header');
                if (cardHeader) cardHeader.setAttribute('aria-expanded', 'false');
            });

            if (!wasActive) {
                currentCard.classList.add('active');
                header.setAttribute('aria-expanded', 'true');
            }
        });
    });
}

function initReleases() {
    setupReleaseTabs();
    fetchReleases('track-me-android', 'dynamic-android-releases');
    fetchReleases(
        'track-me-ios',
        'dynamic-ios-releases',
        'iOS release notes will appear here as they are published. Version 1.8.4 is available on the App Store now.'
    );
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initReleases);
} else {
    initReleases();
}

