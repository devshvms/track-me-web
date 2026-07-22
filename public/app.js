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

// Tab switching logic
const tabBtns = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');

tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        // Remove active class from all
        tabBtns.forEach(b => {
            b.classList.remove('active');
            b.setAttribute('aria-selected', 'false');
        });
        tabContents.forEach(c => {
            c.classList.remove('active');
            c.hidden = true;
        });
        
        // Add active class to clicked button and target content
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');
        const targetId = btn.getAttribute('data-target');
        const target = document.getElementById(targetId);
        target.classList.add('active');
        target.hidden = false;
    });
});

// Release Cards Accordion Logic
const releaseHeaders = document.querySelectorAll('.release-header');
releaseHeaders.forEach(header => {
    header.addEventListener('click', () => {
        const currentCard = header.closest('.release-card');
        const wasActive = currentCard.classList.contains('active');

        // Collapse all release cards ("expand only 1 at a time")
        document.querySelectorAll('.release-card').forEach(card => {
            card.classList.remove('active');
            const cardHeader = card.querySelector('.release-header');
            if (cardHeader) cardHeader.setAttribute('aria-expanded', 'false');
        });

        // If clicked card wasn't already open, open it now
        if (!wasActive) {
            currentCard.classList.add('active');
            header.setAttribute('aria-expanded', 'true');
        }
    });
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
async function fetchReleases(repoName, containerId, emptyMessage = 'No public releases yet.') {
    const container = document.getElementById(containerId);
    if (!container) return;

    try {
        const res = await fetch(`https://api.github.com/repos/devshvms/${repoName}/releases`);
        if (!res.ok) throw new Error('Failed to fetch releases');
        const releases = await res.json();

        if (releases.length === 0) {
            container.innerHTML = `<p class="release-empty">${emptyMessage}</p>`;
            return;
        }

        let html = '';
        releases.forEach((release, index) => {
            const isActive = index === 0;
            const version = release.tag_name;
            const releaseName = release.name || release.tag_name;
            const date = new Date(release.published_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
            const bodyHtml = release.body
                ? release.body.split('\n\n').map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('')
                : '<p>No release notes provided.</p>';

            html += `
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
        });
        container.innerHTML = html;

        // Re-attach accordion listeners for new elements
        const headers = container.querySelectorAll('.release-header');
        headers.forEach(header => {
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

    } catch (err) {
        console.warn(`Could not fetch releases for ${repoName}:`, err);
        container.innerHTML = '<p class="release-empty">Release history is temporarily unavailable.</p>';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    fetchReleases('track-me-android', 'dynamic-android-releases');
    fetchReleases(
        'track-me-ios',
        'dynamic-ios-releases',
        "iOS isn't on TestFlight yet — releases will show up here once it opens. Join the launch list above to be the first to know."
    );
});
