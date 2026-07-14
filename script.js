/* ==========================================================
   VisionShelf Dashboard — script.js
   Reads shelf scans + expected order from Firebase, compares
   them position-by-position, and flags misplaced books.
   ========================================================== */

// ----------------------------------------------------------
// 1. FIREBASE CONFIGURATION
// ----------------------------------------------------------
// IMPORTANT: use the SAME config as the VisionShelf scanner app
// so both read/write to the same Realtime Database.
const firebaseConfig = {
  apiKey: "AIzaSyBMCOmo7m6F5GKInNuDrLtaBnKdtL1f3Ec",
  authDomain: "trackmybook.firebaseapp.com",
  databaseURL: "https://trackmybook-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "trackmybook",
  storageBucket: "trackmybook.firebasestorage.app",
  messagingSenderId: "561847963917",
  appId: "1:561847963917:web:add60ae662cc995da32044",
  measurementId: "G-1RDVB9HLF4"


firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// ----------------------------------------------------------
// 2. DOM REFERENCES
// ----------------------------------------------------------
const shelfSelect = document.getElementById("shelfSelect");
const expectedOrderInput = document.getElementById("expectedOrderInput");
const saveExpectedBtn = document.getElementById("saveExpectedBtn");
const saveStatus = document.getElementById("saveStatus");

const lastScanTime = document.getElementById("lastScanTime");
const summaryBox = document.getElementById("summaryBox");
const comparisonTable = document.getElementById("comparisonTable");
const comparisonBody = document.getElementById("comparisonBody");
const noDataMsg = document.getElementById("noDataMsg");

// Keeps track of the currently selected shelf and its live data
let currentShelf = null;
let currentExpectedOrder = [];
let currentScanTitles = [];
let scanListenerRef = null;
let expectedListenerRef = null;

// ----------------------------------------------------------
// 3. LOAD THE LIST OF KNOWN SHELVES (populates the dropdown)
// ----------------------------------------------------------
db.ref("shelves").on("value", (snapshot) => {
  const shelvesData = snapshot.val() || {};
  const shelfNames = Object.keys(shelvesData);

  // Preserve current selection if possible while refreshing options
  const previouslySelected = shelfSelect.value;
  shelfSelect.innerHTML = '<option value="">-- Select a shelf --</option>';

  shelfNames.forEach((name) => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    shelfSelect.appendChild(opt);
  });

  if (shelfNames.includes(previouslySelected)) {
    shelfSelect.value = previouslySelected;
  }
});

// ----------------------------------------------------------
// 4. HANDLE SHELF SELECTION
// ----------------------------------------------------------
shelfSelect.addEventListener("change", () => {
  currentShelf = shelfSelect.value;

  // Detach old listeners before attaching new ones (avoid leaks / stale data)
  if (expectedListenerRef) expectedListenerRef.off();
  if (scanListenerRef) scanListenerRef.off();

  if (!currentShelf) {
    resetView();
    return;
  }

  listenForExpectedOrder(currentShelf);
  listenForLatestScan(currentShelf);
});

// ----------------------------------------------------------
// 5. EXPECTED ORDER: LIVE LISTENER + SAVE
// ----------------------------------------------------------
function listenForExpectedOrder(shelfName) {
  expectedListenerRef = db.ref(`shelves/${shelfName}/expectedOrder`);
  expectedListenerRef.on("value", (snapshot) => {
    const data = snapshot.val() || [];
    currentExpectedOrder = Array.isArray(data) ? data : Object.values(data);
    expectedOrderInput.value = currentExpectedOrder.join("\n");
    runComparison();
  });
}

saveExpectedBtn.addEventListener("click", async () => {
  if (!currentShelf) {
    saveStatus.textContent = "Select a shelf first.";
    saveStatus.className = "status-msg error";
    return;
  }

  // Clean up the textarea input into a plain array, same rules as OCR cleanup:
  // trim whitespace, collapse inner spaces, drop empty lines.
  const cleanedList = expectedOrderInput.value
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter((line) => line.length > 0);

  try {
    await db.ref(`shelves/${currentShelf}/expectedOrder`).set(cleanedList);
    saveStatus.textContent = `Saved ${cleanedList.length} titles as the expected order ✅`;
    saveStatus.className = "status-msg success";
  } catch (err) {
    console.error("Failed to save expected order:", err);
    saveStatus.textContent = "Failed to save. Check your Firebase connection.";
    saveStatus.className = "status-msg error";
  }
});

// ----------------------------------------------------------
// 6. LATEST SCAN: LIVE LISTENER
// ----------------------------------------------------------
function listenForLatestScan(shelfName) {
  // Only need the single most recent scan, ordered by Firebase's push timestamp
  scanListenerRef = db
    .ref(`shelves/${shelfName}/scans`)
    .orderByChild("timestamp")
    .limitToLast(1);

  scanListenerRef.on("value", (snapshot) => {
    const scans = snapshot.val();

    if (!scans) {
      currentScanTitles = [];
      lastScanTime.textContent = "No scans uploaded yet for this shelf.";
      runComparison();
      return;
    }

    // limitToLast(1) still returns an object keyed by push-id; grab the single entry
    const latestScan = Object.values(scans)[0];
    currentScanTitles = latestScan.titles || [];

    const scanDate = new Date(latestScan.timestamp);
    lastScanTime.textContent = `Last scanned: ${scanDate.toLocaleString()} (${currentScanTitles.length} titles detected)`;

    runComparison();
  });
}

// ----------------------------------------------------------
// 7. TEXT NORMALIZATION + FUZZY SIMILARITY
// ----------------------------------------------------------
// OCR output is noisy, so we don't require exact string equality.
// Titles are normalized (lowercase, punctuation stripped) and compared
// using a Levenshtein-based similarity ratio.

function normalize(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "") // strip punctuation/symbols
    .replace(/\s+/g, " ")
    .trim();
}

function levenshteinDistance(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix = Array.from({ length: rows }, () => new Array(cols).fill(0));

  for (let i = 0; i < rows; i++) matrix[i][0] = i;
  for (let j = 0; j < cols; j++) matrix[0][j] = j;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,      // deletion
        matrix[i][j - 1] + 1,      // insertion
        matrix[i - 1][j - 1] + cost // substitution
      );
    }
  }
  return matrix[rows - 1][cols - 1];
}

// Returns a similarity score between 0 (completely different) and 1 (identical)
function similarity(strA, strB) {
  const a = normalize(strA);
  const b = normalize(strB);
  if (a.length === 0 && b.length === 0) return 1;

  const distance = levenshteinDistance(a, b);
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 1 : 1 - distance / maxLen;
}

// Titles are considered "the same book" if similarity meets this threshold.
// Tune this if OCR quality is especially poor/good for your camera setup.
const MATCH_THRESHOLD = 0.75;

// ----------------------------------------------------------
// 8. RUN THE POSITION-BY-POSITION COMPARISON
// ----------------------------------------------------------
function runComparison() {
  const hasExpected = currentExpectedOrder.length > 0;
  const hasScan = currentScanTitles.length > 0;

  if (!hasExpected || !hasScan) {
    comparisonTable.hidden = true;
    summaryBox.hidden = true;
    noDataMsg.hidden = false;
    noDataMsg.textContent = !hasExpected
      ? "Add an expected order for this shelf to run a comparison."
      : "No scan data available yet for this shelf.";
    return;
  }

  noDataMsg.hidden = true;
  comparisonTable.hidden = false;
  summaryBox.hidden = false;

  // Compare index-by-index across the longer of the two lists, so extra
  // or missing items at the end still show up as mismatches.
  const rowCount = Math.max(currentExpectedOrder.length, currentScanTitles.length);
  comparisonBody.innerHTML = "";

  let correctCount = 0;
  let mismatchCount = 0;

  for (let i = 0; i < rowCount; i++) {
    const expectedTitle = currentExpectedOrder[i] || "(none — shelf is short)";
    const detectedTitle = currentScanTitles[i] || "(none — missing/misplaced)";

    const isMatch =
      currentExpectedOrder[i] && currentScanTitles[i]
        ? similarity(currentExpectedOrder[i], currentScanTitles[i]) >= MATCH_THRESHOLD
        : false;

    if (isMatch) correctCount++;
    else mismatchCount++;

    const row = document.createElement("tr");
    row.className = isMatch ? "row-ok" : "row-mismatch";
    row.innerHTML = `
      <td>${i + 1}</td>
      <td>${escapeHtml(expectedTitle)}</td>
      <td>${escapeHtml(detectedTitle)}</td>
      <td class="${isMatch ? "status-ok" : "status-mismatch"}">
        ${isMatch ? "✅ Correct" : "❌ Misplaced"}
      </td>
    `;
    comparisonBody.appendChild(row);
  }

  renderSummary(correctCount, mismatchCount);
}

// ----------------------------------------------------------
// 9. SUMMARY BOX
// ----------------------------------------------------------
function renderSummary(correctCount, mismatchCount) {
  summaryBox.innerHTML = `
    <div class="summary-item">
      <span class="count" style="color:#059669">${correctCount}</span>
      <span class="label">In place</span>
    </div>
    <div class="summary-item">
      <span class="count" style="color:#dc2626">${mismatchCount}</span>
      <span class="label">Misplaced</span>
    </div>
  `;
}

// ----------------------------------------------------------
// 10. RESET VIEW (no shelf selected)
// ----------------------------------------------------------
function resetView() {
  currentExpectedOrder = [];
  currentScanTitles = [];
  expectedOrderInput.value = "";
  lastScanTime.textContent = "No scan loaded yet.";
  comparisonTable.hidden = true;
  summaryBox.hidden = true;
  noDataMsg.hidden = false;
  noDataMsg.textContent = "Select a shelf with both an expected order and a scan to see results.";
}

// ----------------------------------------------------------
// 11. UTILITY: ESCAPE HTML TO AVOID INJECTION FROM OCR TEXT
// ----------------------------------------------------------
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
