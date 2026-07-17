import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut, onAuthStateChanged, deleteUser } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getFirestore, collection, getDocs, deleteDoc, addDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

// Actual Firebase configuration from Firebase Console
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

let currentUser = null;

onAuthStateChanged(auth, (user) => {
    if (user) {
        currentUser = user;
        authButton.textContent = "Sign Out";
        accountSection.classList.remove("hidden");
        accountLink.style.display = "inline-block";
        userNameSpan.textContent = user.displayName || "Explorer";
        userEmailSpan.textContent = user.email;
        checkExportStatus(user.uid);
    } else {
        currentUser = null;
        authButton.textContent = "Sign In";
        accountSection.classList.add("hidden");
        accountLink.style.display = "none";
        confirmInput.value = "";
        deleteBtn.disabled = true;
        messageEl.textContent = "";
        messageEl.style.color = "";
    }
});

authButton.addEventListener("click", () => {
    if (currentUser) {
        signOut(auth);
    } else {
        signInWithPopup(auth, provider).catch(error => {
            console.error("Auth error:", error);
            alert("Sign in failed: " + error.message);
        });
    }
});

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

        // 3. Delete auth user
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
        tabBtns.forEach(b => b.classList.remove('active'));
        tabContents.forEach(c => c.classList.remove('active'));
        
        // Add active class to clicked button and target content
        btn.classList.add('active');
        const targetId = btn.getAttribute('data-target');
        document.getElementById(targetId).classList.add('active');
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
        });

        // If clicked card wasn't already open, open it now
        if (!wasActive) {
            currentCard.classList.add('active');
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

    if (data.status === 'COMPLETED') {
        if (requestBtn) requestBtn.style.display = 'none'; // Hide duplicate blue button
        iconEl.textContent = '✅';
        titleEl.textContent = 'Archive Ready for Download';
        messageEl.textContent = 'Your historical data archive has been assembled. Please download it below. Note: Completed archives expire 6 hours after retrieval (max 48 hours unaccessed).';
        downloadAction.style.display = 'block';
        downloadLink.href = data.downloadUrl || '#';
    } else {
        if (requestBtn) requestBtn.textContent = 'Data Requested...';
        if (requestBtn) requestBtn.disabled = true;
        iconEl.textContent = '⏳';
        titleEl.textContent = 'Export Request Queued';
        messageEl.textContent = 'We are assembling your historical trace files and profile data into a compressed archive. You can safely close this page. The download will become available here automatically once completed.';
        downloadAction.style.display = 'none';
    }
}

async function checkExportStatus(userId) {
    try {
        const idToken = await currentUser.getIdToken();
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
            const idToken = await currentUser.getIdToken();
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
