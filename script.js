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
  //measurementId: "G-1RDVB9HLF4"
};


firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.database();

auth.signInAnonymously().catch((err) => {
  console.error("Anonymous auth failed:", err);
  setStatus(compareStatus, "Auth failed — check Firebase console has Anonymous sign-in enabled.", true);
});

/* ---------------------------------------------------------------
   ELEMENTS
--------------------------------------------------------------- */
const orderInput    = document.getElementById('orderInput');
const compareBtn    = document.getElementById('compareBtn');
const compareStatus = document.getElementById('compareStatus');
const resultsCard   = document.getElementById('resultsCard');
const results       = document.getElementById('results');
const foundCount    = document.getElementById('foundCount');
const misplacedCount = document.getElementById('misplacedCount');
const missingCount  = document.getElementById('missingCount');

/* ---------------------------------------------------------------
   WORD MATCHING
   Comparison is deliberately loose: if even one meaningful word
   from an expected line (e.g. "Power" from "The Power") shows up
   anywhere in a scanned book's title/author/ISBN/raw OCR text,
   that book counts as found. This tolerates OCR mistakes and
   partial or reordered titles.
--------------------------------------------------------------- */
const STOPWORDS = new Set([
  'the','a','an','of','and','or','to','in','on','for','by','with',
  'is','are','was','were','book','books','novel','vol','volume','part','series'
]);

function extractWords(text) {
  return (String(text || '').toLowerCase().match(/[a-z0-9']+/g)) || [];
}

function significantWords(line) {
  const words = extractWords(line).filter(w => w.length >= 3 && !STOPWORDS.has(w));
  return words.length ? words : extractWords(line); // fall back rather than match nothing
}

/* ---------------------------------------------------------------
   COMPARE
--------------------------------------------------------------- */
compareBtn.addEventListener('click', async () => {
  const lines = orderInput.value.split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) {
    setStatus(compareStatus, "Type at least one book title first.", true);
    return;
  }

  compareBtn.disabled = true;
  setStatus(compareStatus, "Reading the shelf…");
  results.innerHTML = '';
  resultsCard.style.display = 'none';

  let snapshot;
  try {
    snapshot = await db.ref('books').once('value');
  } catch (err) {
    console.error(err);
    setStatus(compareStatus, "Couldn't reach the database — check your Firebase config and rules.", true);
    compareBtn.disabled = false;
    return;
  }

  const raw = snapshot.val() || {};
  // Scan order stands in for physical shelf order — earliest scannedAt is leftmost.
  const shelfBooks = Object.entries(raw)
    .map(([key, record]) => {
      const combined = [record.title, record.author, record.isbn, record.rawText].join(' ');
      return {
        key,
        title: record.title || '(untitled scan)',
        scannedAt: typeof record.scannedAt === 'number' ? record.scannedAt : 0,
        wordSet: new Set(extractWords(combined))
      };
    })
    .sort((a, b) => a.scannedAt - b.scannedAt);

  shelfBooks.forEach((book, idx) => { book.position = idx; }); // 0-based actual position

  if (!shelfBooks.length) {
    setStatus(compareStatus, "The shelf is empty — nothing has been uploaded yet.", true);
    compareBtn.disabled = false;
    return;
  }

  let correct = 0, misplaced = 0, missing = 0;
  results.innerHTML = '';
  const usedKeys = new Set(); // each scanned book can only satisfy one expected line

  lines.forEach((line, expectedIndex) => {
    const words = significantWords(line);
    let match = null;
    let matchedWord = null;

    outer:
    for (const word of words) {
      for (const book of shelfBooks) {
        if (usedKeys.has(book.key)) continue;
        if (book.wordSet.has(word)) {
          match = book;
          matchedWord = word;
          break outer;
        }
      }
    }

    const row = document.createElement('div');

    if (!match) {
      missing++;
      row.className = 'result-row missing';
      row.innerHTML = `
        <div class="result-icon">✕</div>
        <div class="result-body">
          <div class="result-title">${escapeHtml(line)}</div>
          <div class="result-detail miss">Missing — no scanned book matches any word in this title</div>
        </div>`;
      results.appendChild(row);
      return;
    }

    usedKeys.add(match.key);

    if (match.position === expectedIndex) {
      correct++;
      row.className = 'result-row found';
      row.innerHTML = `
        <div class="result-icon">✓</div>
        <div class="result-body">
          <div class="result-title">${escapeHtml(line)}</div>
          <div class="result-detail">In place · matched <b>“${escapeHtml(matchedWord)}”</b> in “${escapeHtml(match.title)}”</div>
        </div>`;
    } else {
      misplaced++;
      row.className = 'result-row misplaced';
      row.innerHTML = `
        <div class="result-icon">↕</div>
        <div class="result-body">
          <div class="result-title">${escapeHtml(line)}</div>
          <div class="result-detail">Misplaced · expected position <b>${expectedIndex + 1}</b>, found at position <b>${match.position + 1}</b> on the shelf (matched “${escapeHtml(matchedWord)}” in “${escapeHtml(match.title)}”)</div>
        </div>`;
    }
    results.appendChild(row);
  });

  foundCount.textContent = correct;
  misplacedCount.textContent = misplaced;
  missingCount.textContent = missing;
  resultsCard.style.display = 'block';
  setStatus(compareStatus, `Checked ${lines.length} book${lines.length > 1 ? 's' : ''} against ${shelfBooks.length} on the shelf.`);
  compareBtn.disabled = false;
});

/* ---------------------------------------------------------------
   HELPERS
--------------------------------------------------------------- */
function setStatus(el, msg, isError = false) {
  el.textContent = msg;
  el.classList.toggle('err', isError);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
