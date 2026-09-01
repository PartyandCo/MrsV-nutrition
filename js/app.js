/* ============================================================
   Διατροφικό Ημερολόγιο — αποθήκευση αποκλειστικά σε localStorage
   ============================================================ */

// Αν όρισες APP_SHARED_SECRET ως environment variable στο Netlify (βλ.
// README.md), βάλε εδώ την ΙΔΙΑ τιμή ώστε το frontend να τη στέλνει στη
// συνάρτηση AI. Σημείωση: επειδή αυτό είναι static site, οποιοσδήποτε
// ανοίξει τα devtools μπορεί να τη δει — είναι απλώς ένα φίλτρο ενάντια σε
// τυχαία bots, όχι πραγματική ασφάλεια.
const APP_SHARED_SECRET = '';

const STORAGE_KEYS = {
  goals: 'nutri.goals',
  foods: 'nutri.foods',
  entries: 'nutri.entries', // { 'YYYY-MM-DD': [ {id, name, cal, pro, carb, fat, fib} ] }
  supplements: 'nutri.supplements', // [ {id, name, notes} ]
  supplementLog: 'nutri.supplementLog', // { 'YYYY-MM-DD': [ name, name, ... ] }
  cloudPin: 'nutri.cloudPin', // plain string, not JSON — device-local, not synced
  cloudLastSync: 'nutri.cloudLastSync', // ISO timestamp string
};

const DEFAULT_GOALS = { cal: 2000, pro: 120, carb: 220, fat: 65, fib: 25 };

let state = {
  // { ...DEFAULT_GOALS, ...saved } so an older saved goals object (from
  // before the Fiber goal existed) still gets a sensible fib default
  // instead of ending up undefined.
  goals: { ...DEFAULT_GOALS, ...loadJSON(STORAGE_KEYS.goals, DEFAULT_GOALS) },
  foods: loadJSON(STORAGE_KEYS.foods, []),
  entries: loadJSON(STORAGE_KEYS.entries, {}),
  supplements: loadJSON(STORAGE_KEYS.supplements, []),
  supplementLog: loadJSON(STORAGE_KEYS.supplementLog, {}),
  currentDate: todayStr(),
};

let historyChart = null;

/* ---------------- helpers ---------------- */

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch (e) {
    console.warn('Could not parse', key, e);
    return fallback;
  }
}

function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.error('Could not save', key, e);
    showToast('Σφάλμα αποθήκευσης — ελέγξτε τον χώρο αποθήκευσης του browser.');
  }
  scheduleCloudBackup();
}

function todayStr() {
  const d = new Date();
  return dateToStr(d);
}

function dateToStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(dateStr, delta) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + delta);
  return dateToStr(d);
}

function fmtDateLabel(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('el-GR', { weekday: 'short', day: 'numeric', month: 'short' });
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

/* ---------------- cloud backup (Netlify Blobs) ---------------- */

const CLOUD_SYNC_ENDPOINT = '/api/sync-data';
const CLOUD_SYNC_DEBOUNCE_MS = 3000;
let cloudSyncTimer = null;
let cloudSyncInFlight = false;

function getCloudPin() {
  return localStorage.getItem(STORAGE_KEYS.cloudPin) || '';
}

function setCloudPin(pin) {
  if (pin) {
    localStorage.setItem(STORAGE_KEYS.cloudPin, pin);
  } else {
    localStorage.removeItem(STORAGE_KEYS.cloudPin);
  }
}

function currentBackupPayload() {
  return {
    goals: state.goals,
    foods: state.foods,
    entries: state.entries,
    supplements: state.supplements,
    supplementLog: state.supplementLog,
  };
}

function fmtSyncTime(iso) {
  try {
    return new Date(iso).toLocaleString('el-GR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

function renderCloudStatus(message) {
  const el = document.getElementById('cloudSyncStatus');
  if (!el) return;
  if (message) {
    el.textContent = message;
    return;
  }
  const pin = getCloudPin();
  if (!pin) {
    el.textContent = 'Δεν έχει οριστεί PIN ακόμα.';
    return;
  }
  const lastSync = localStorage.getItem(STORAGE_KEYS.cloudLastSync);
  el.textContent = lastSync
    ? `Ενεργό — τελευταία αποθήκευση στο cloud: ${fmtSyncTime(lastSync)}`
    : 'Ενεργό — δεν έχει γίνει ακόμα αποθήκευση στο cloud.';
}

function scheduleCloudBackup() {
  if (!getCloudPin()) return;
  clearTimeout(cloudSyncTimer);
  cloudSyncTimer = setTimeout(() => { performCloudBackup(); }, CLOUD_SYNC_DEBOUNCE_MS);
}

async function performCloudBackup() {
  const pin = getCloudPin();
  if (!pin || cloudSyncInFlight) return;
  cloudSyncInFlight = true;
  try {
    const res = await fetch(CLOUD_SYNC_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin, payload: currentBackupPayload() }),
    });
    let data;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok || !data || !data.ok) {
      renderCloudStatus('Δεν ήταν δυνατή η αποθήκευση στο cloud (θα ξαναδοκιμάσει στην επόμενη αλλαγή).');
      return;
    }
    localStorage.setItem(STORAGE_KEYS.cloudLastSync, data.savedAt);
    renderCloudStatus();
  } catch (err) {
    renderCloudStatus('Δεν ήταν δυνατή η σύνδεση με το cloud (θα ξαναδοκιμάσει στην επόμενη αλλαγή).');
  } finally {
    cloudSyncInFlight = false;
  }
}

async function restoreFromCloud() {
  const pin = getCloudPin();
  if (!pin) {
    showToast('Όρισε πρώτα ένα PIN.');
    return;
  }
  renderCloudStatus('Έλεγχος για αντίγραφο στο cloud...');
  try {
    const res = await fetch(`${CLOUD_SYNC_ENDPOINT}?pin=${encodeURIComponent(pin)}`);
    let data;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok || !data) {
      renderCloudStatus('Σφάλμα κατά τον έλεγχο του cloud.');
      return;
    }
    if (!data.found) {
      showToast('Δεν βρέθηκε αντίγραφο για αυτό το PIN.');
      renderCloudStatus();
      return;
    }
    if (!confirm(`Βρέθηκε αντίγραφο στο cloud από ${fmtSyncTime(data.savedAt)}. Η επαναφορά θα αντικαταστήσει τα δεδομένα ΑΥΤΗΣ της συσκευής. Συνέχεια;`)) {
      renderCloudStatus();
      return;
    }
    const payload = data.data || {};
    if (payload.goals) { state.goals = payload.goals; saveJSON(STORAGE_KEYS.goals, state.goals); }
    if (payload.foods) { state.foods = payload.foods; saveJSON(STORAGE_KEYS.foods, state.foods); }
    if (payload.entries) { state.entries = payload.entries; saveJSON(STORAGE_KEYS.entries, state.entries); }
    if (payload.supplements) { state.supplements = payload.supplements; saveJSON(STORAGE_KEYS.supplements, state.supplements); }
    if (payload.supplementLog) { state.supplementLog = payload.supplementLog; saveJSON(STORAGE_KEYS.supplementLog, state.supplementLog); }
    initGoalsView();
    renderDay();
    renderFoods();
    renderSupplementManageList();
    localStorage.setItem(STORAGE_KEYS.cloudLastSync, data.savedAt);
    renderCloudStatus();
    showToast('Τα δεδομένα επαναφέρθηκαν από το cloud.');
  } catch (err) {
    renderCloudStatus('Δεν ήταν δυνατή η σύνδεση με το cloud.');
  }
}

function initCloudSyncView() {
  const pinInput = document.getElementById('cloudPin');
  if (pinInput) pinInput.value = getCloudPin();
  renderCloudStatus();

  document.getElementById('cloudPinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const pin = document.getElementById('cloudPin').value.trim();
    if (pin && pin.length < 4) {
      showToast('Το PIN πρέπει να έχει τουλάχιστον 4 χαρακτήρες.');
      return;
    }
    setCloudPin(pin);
    if (pin) {
      showToast('Το PIN αποθηκεύτηκε. Γίνεται αρχική αποθήκευση στο cloud...');
      performCloudBackup();
    } else {
      showToast('Το αυτόματο αντίγραφο cloud απενεργοποιήθηκε σε αυτή τη συσκευή.');
    }
    renderCloudStatus();
  });

  document.getElementById('cloudBackupNowBtn').addEventListener('click', () => {
    if (!getCloudPin()) {
      showToast('Όρισε πρώτα και αποθήκευσε ένα PIN.');
      return;
    }
    renderCloudStatus('Αποθήκευση στο cloud...');
    performCloudBackup();
  });

  document.getElementById('cloudRestoreBtn').addEventListener('click', () => {
    restoreFromCloud();
  });
}

/* ---------------- entries for a date ---------------- */

function getEntriesFor(dateStr) {
  return state.entries[dateStr] || [];
}

function addEntry(dateStr, entry) {
  if (!state.entries[dateStr]) state.entries[dateStr] = [];
  state.entries[dateStr].push({ id: uid(), ...entry });
  saveJSON(STORAGE_KEYS.entries, state.entries);
}

function deleteEntry(dateStr, id) {
  if (!state.entries[dateStr]) return;
  state.entries[dateStr] = state.entries[dateStr].filter(e => e.id !== id);
  if (state.entries[dateStr].length === 0) delete state.entries[dateStr];
  saveJSON(STORAGE_KEYS.entries, state.entries);
}

function sumEntries(list) {
  return list.reduce((acc, e) => {
    acc.cal += Number(e.cal) || 0;
    acc.pro += Number(e.pro) || 0;
    acc.carb += Number(e.carb) || 0;
    acc.fat += Number(e.fat) || 0;
    acc.fib += Number(e.fib) || 0;
    return acc;
  }, { cal: 0, pro: 0, carb: 0, fat: 0, fib: 0 });
}

/* ---------------- supplements ---------------- */

function getSupplementLogFor(dateStr) {
  return state.supplementLog[dateStr] || [];
}

function toggleSupplementTaken(dateStr, name) {
  const list = state.supplementLog[dateStr] ? [...state.supplementLog[dateStr]] : [];
  const idx = list.indexOf(name);
  if (idx >= 0) {
    list.splice(idx, 1);
  } else {
    list.push(name);
  }
  if (list.length === 0) {
    delete state.supplementLog[dateStr];
  } else {
    state.supplementLog[dateStr] = list;
  }
  saveJSON(STORAGE_KEYS.supplementLog, state.supplementLog);
}

function sortedSupplements() {
  return [...state.supplements].sort((a, b) => {
    if (!a.time && !b.time) return 0;
    if (!a.time) return 1;
    if (!b.time) return -1;
    return a.time.localeCompare(b.time);
  });
}

function initSupplementsView() {
  document.getElementById('supplementForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = document.getElementById('supplementName').value.trim();
    const time = document.getElementById('supplementTime').value;
    const notes = document.getElementById('supplementNotes').value.trim();
    if (!name) return;
    if (state.supplements.some(s => s.name.toLowerCase() === name.toLowerCase())) {
      showToast('Υπάρχει ήδη συμπλήρωμα με αυτό το όνομα.');
      return;
    }
    state.supplements.push({ id: uid(), name, time, notes, createdAt: todayStr() });
    saveJSON(STORAGE_KEYS.supplements, state.supplements);
    e.target.reset();
    renderSupplements();
    renderSupplementManageList();
    showToast('Το συμπλήρωμα προστέθηκε.');
  });

  document.getElementById('supplementsList').addEventListener('click', (e) => {
    const btn = e.target.closest('.supplement-btn');
    if (!btn) return;
    toggleSupplementTaken(state.currentDate, btn.dataset.name);
    renderSupplements();
  });

  document.getElementById('supplementManageList').addEventListener('click', (e) => {
    const btn = e.target.closest('.delete-btn');
    if (!btn) return;
    if (!confirm('Διαγραφή αυτού του συμπληρώματος από τη λίστα;')) return;
    state.supplements = state.supplements.filter(s => s.id !== btn.dataset.id);
    saveJSON(STORAGE_KEYS.supplements, state.supplements);
    renderSupplements();
    renderSupplementManageList();
  });
}

function renderSupplements() {
  const listEl = document.getElementById('supplementsList');
  const countEl = document.getElementById('supplementsCount');
  const takenList = getSupplementLogFor(state.currentDate);

  if (state.supplements.length === 0) {
    listEl.innerHTML = '<p class="empty-hint">Δεν έχεις προσθέσει ακόμα συμπληρώματα.</p>';
    countEl.textContent = '0/0';
    return;
  }

  const sorted = sortedSupplements();
  const takenCount = sorted.filter(s => takenList.includes(s.name)).length;
  countEl.textContent = `${takenCount}/${sorted.length}`;

  listEl.innerHTML = sorted.map(s => {
    const taken = takenList.includes(s.name);
    return `
      <button type="button" class="supplement-btn" data-name="${escapeHtml(s.name)}" aria-pressed="${taken ? 'true' : 'false'}">
        <span class="supplement-btn-name">${escapeHtml(s.name)}</span>
        ${s.time ? `<span class="supplement-btn-time">${escapeHtml(s.time)}</span>` : ''}
      </button>
    `;
  }).join('');
}

function renderSupplementManageList() {
  const listEl = document.getElementById('supplementManageList');
  if (!listEl) return;

  if (state.supplements.length === 0) {
    listEl.innerHTML = '<li class="empty-hint">Δεν έχεις προσθέσει ακόμα συμπληρώματα.</li>';
    return;
  }

  const sorted = sortedSupplements();
  listEl.innerHTML = sorted.map(s => {
    const details = [s.time, s.notes].filter(Boolean).map(v => escapeHtml(v)).join(' · ');
    return `
      <li>
        <div class="entry-main">
          <span class="entry-name">${escapeHtml(s.name)}</span>
          ${details ? `<span class="entry-macros">${details}</span>` : ''}
        </div>
        <div class="entry-actions">
          <button class="delete-btn" data-id="${s.id}" title="Διαγραφή">✕</button>
        </div>
      </li>
    `;
  }).join('');
}

/* ---------------- TABS ---------------- */

function initTabs() {
  const buttons = document.querySelectorAll('.tab-btn');
  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      buttons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      document.getElementById('view-' + btn.dataset.tab).classList.add('active');
      if (btn.dataset.tab === 'history') renderHistory();
    });
  });
}

/* ---------------- DAY VIEW ---------------- */

function initDayView() {
  const datePicker = document.getElementById('datePicker');
  datePicker.value = state.currentDate;

  datePicker.addEventListener('change', () => {
    state.currentDate = datePicker.value || todayStr();
    renderDay();
  });

  document.getElementById('prevDay').addEventListener('click', () => {
    state.currentDate = addDays(state.currentDate, -1);
    datePicker.value = state.currentDate;
    renderDay();
  });

  document.getElementById('nextDay').addEventListener('click', () => {
    state.currentDate = addDays(state.currentDate, 1);
    datePicker.value = state.currentDate;
    renderDay();
  });

  document.getElementById('todayBtn').addEventListener('click', () => {
    state.currentDate = todayStr();
    datePicker.value = state.currentDate;
    renderDay();
  });

  document.getElementById('quickAddBtn').addEventListener('click', () => {
    const select = document.getElementById('quickAddSelect');
    const qtyInput = document.getElementById('quickAddQty');
    const foodId = select.value;
    const qty = parseFloat(qtyInput.value) || 1;
    if (!foodId) {
      showToast('Επίλεξε πρώτα ένα τρόφιμο.');
      return;
    }
    const food = state.foods.find(f => f.id === foodId);
    if (!food) return;
    addEntry(state.currentDate, {
      name: qty === 1 ? food.name : `${food.name} (x${qty})`,
      cal: round1(food.cal * qty),
      pro: round1(food.pro * qty),
      carb: round1(food.carb * qty),
      fat: round1(food.fat * qty),
      fib: round1((food.fib || 0) * qty),
    });
    qtyInput.value = 1;
    select.value = '';
    renderDay();
    showToast('Προστέθηκε στο ημερολόγιο.');
  });

  document.getElementById('manualForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = document.getElementById('manualName').value.trim();
    const cal = parseFloat(document.getElementById('manualCal').value) || 0;
    const pro = parseFloat(document.getElementById('manualPro').value) || 0;
    const carb = parseFloat(document.getElementById('manualCarb').value) || 0;
    const fat = parseFloat(document.getElementById('manualFat').value) || 0;
    const fib = parseFloat(document.getElementById('manualFib').value) || 0;
    if (!name) return;
    addEntry(state.currentDate, { name, cal, pro, carb, fat, fib });
    e.target.reset();
    renderDay();
    showToast('Προστέθηκε στο ημερολόγιο.');
  });

  document.getElementById('entryList').addEventListener('click', (e) => {
    const btn = e.target.closest('.delete-btn');
    if (!btn) return;
    deleteEntry(state.currentDate, btn.dataset.id);
    renderDay();
  });
}

/* ---------------- AI ENTRY: TEXT, PHOTO LABEL/BARCODE, OR TYPED BARCODE ----------------
   One shared card/result panel handles all three ways of logging a meal:
   free-text description, a photo of a nutrition label or barcode, or a
   typed barcode number. The photo/barcode paths land on an intermediate
   "πόσα γραμμάρια έφαγες" step (since they give per-100g values, not a
   ready total); free text goes straight to the shared result fields. */

const AI_ENDPOINT = '/api/estimate-nutrition';
const NO_BACKEND_MESSAGE = 'Αυτή η λειτουργία χρειάζεται το πραγματικό site σου στο Netlify (με ρυθμισμένο API key) — δεν είναι διαθέσιμη σε αυτή την προεπισκόπηση. Δοκίμασέ το μετά το deploy.';

// Set only when the current result came from a photo/barcode scan — holds
// the raw per-100g values + name so "Υπολόγισε ποσότητα" can scale them by
// grams, and "Πρόσθεσε στα αγαπημένα" can save the un-scaled per-100g
// reference rather than whatever ends up in the (possibly edited) result
// fields. null while showing a free-text AI result, or when nothing's shown.
let currentScanResult = null;

function aiHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (APP_SHARED_SECRET) headers['x-app-secret'] = APP_SHARED_SECRET;
  return headers;
}

function setAILoading(isLoading) {
  document.getElementById('aiLoading').hidden = !isLoading;
  document.getElementById('aiEstimateBtn').disabled = isLoading;
}

function showAIError(message) {
  const el = document.getElementById('aiError');
  el.textContent = message;
  el.hidden = false;
}

function hideAIError() {
  document.getElementById('aiError').hidden = true;
}

function hideGramsStep() {
  document.getElementById('scanGramsStep').hidden = true;
}

function hideAIResult() {
  document.getElementById('aiResult').hidden = true;
  hideGramsStep();
  currentScanResult = null;
}

// Shows the "πόσα γραμμάρια έφαγες" step for a photo/barcode scan result
// (per-100g values), before it becomes an editable total.
function showGramsStep(result) {
  document.getElementById('aiResult').hidden = true;
  currentScanResult = {
    per_100g: result.per_100g || { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 },
    product_name_guess: result.product_name_guess || 'Προϊόν',
  };
  const p = currentScanResult.per_100g;

  document.getElementById('scanPer100Note').textContent =
    `${currentScanResult.product_name_guess} — ανά 100γρ: ${Math.round(p.calories || 0)} kcal · P ${round1(p.protein_g || 0)}g · C ${round1(p.carbs_g || 0)}g · F ${round1(p.fat_g || 0)}g · Ίνες ${round1(p.fiber_g || 0)}g`;

  const ingredientsEl = document.getElementById('scanIngredientsNote');
  if (result.ingredients_summary) {
    ingredientsEl.textContent = 'Συστατικά: ' + result.ingredients_summary;
    ingredientsEl.hidden = false;
  } else {
    ingredientsEl.hidden = true;
  }

  document.getElementById('scanGrams').value = '';
  document.getElementById('scanGramsStep').hidden = false;
}

// Populates the one shared, editable result panel (used by all three entry
// paths) and labels the "add to favorites" button appropriately — a scan
// result is a reusable per-100g item, while a free-text AI estimate is
// saved as-is (the amounts shown, for whatever quantity was described).
function showAIResult({ name, cal, pro, carb, fat, fib, note }) {
  document.getElementById('aiResultName').value = name || 'Γεύμα';
  document.getElementById('aiResultCal').value = Math.round(cal || 0);
  document.getElementById('aiResultPro').value = round1(pro || 0);
  document.getElementById('aiResultCarb').value = round1(carb || 0);
  document.getElementById('aiResultFat').value = round1(fat || 0);
  document.getElementById('aiResultFib').value = round1(fib || 0);

  const noteEl = document.getElementById('aiResultNote');
  if (note) {
    noteEl.textContent = note;
    noteEl.hidden = false;
  } else {
    noteEl.hidden = true;
  }

  const favBtn = document.getElementById('aiFavoriteBtn');
  favBtn.hidden = false;
  favBtn.textContent = currentScanResult
    ? 'Πρόσθεσε στα αγαπημένα (ανά 100γρ)'
    : 'Πρόσθεσε στα αγαπημένα';
  hideGramsStep();
  document.getElementById('aiResult').hidden = false;
}

function hasUsableNutrition(per100) {
  if (!per100) return false;
  return !!(per100.calories || per100.protein_g || per100.carbs_g || per100.fat_g);
}

// Resizes an image file client-side (long side capped at maxDim) before it
// gets base64-encoded and sent to the server — phone photos are often
// several MB, and this keeps the upload small and fast.
function resizeImageToBase64(file, maxDim = 1024, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        resolve({ base64: dataUrl.split(',')[1], mediaType: 'image/jpeg' });
      };
      img.onerror = () => reject(new Error('Δεν ήταν δυνατή η ανάγνωση της εικόνας.'));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error('Δεν ήταν δυνατή η ανάγνωση του αρχείου.'));
    reader.readAsDataURL(file);
  });
}

async function postToAI(body) {
  const res = await fetch(AI_ENDPOINT, { method: 'POST', headers: aiHeaders(), body: JSON.stringify(body) });
  if (res.status === 404 || res.status === 501) {
    // No backend at this address — normal when running this page as a plain
    // static preview instead of the deployed Netlify site with the
    // serverless function + API key configured.
    return { error: NO_BACKEND_MESSAGE };
  }
  let payload;
  try {
    payload = await res.json();
  } catch {
    // A non-JSON response body (an HTML error page, etc.) almost always
    // means there's no real function at this address.
    return { error: NO_BACKEND_MESSAGE };
  }
  if (!res.ok || payload.error) {
    return { error: payload.error || `Σφάλμα (${res.status}).` };
  }
  return { result: payload.result };
}

async function runAIText(description) {
  hideAIError();
  hideAIResult();
  setAILoading(true);
  try {
    const { result, error } = await postToAI({ description });
    if (error) { showAIError(error); return; }
    const total = result.total || {};
    showAIResult({
      name: result.summary_name,
      cal: total.calories, pro: total.protein_g, carb: total.carbs_g, fat: total.fat_g, fib: total.fiber_g,
      note: result.confidence_note ? 'Σημείωση AI: ' + result.confidence_note : null,
    });
  } catch (err) {
    showAIError('Αποτυχία σύνδεσης. Αν βλέπεις αυτή τη σελίδα ως προεπισκόπηση (όχι στο πραγματικό Netlify site), αυτό είναι αναμενόμενο — δοκίμασέ το μετά το deploy.');
  } finally {
    setAILoading(false);
  }
}

async function runScanPhoto(file) {
  hideAIError();
  hideAIResult();
  setAILoading(true);
  try {
    const { base64, mediaType } = await resizeImageToBase64(file);
    const { result, error } = await postToAI({ mode: 'photo', image: base64, mediaType });
    if (error) { showAIError(error); return; }

    let scanResult = result;

    if (!hasUsableNutrition(scanResult.per_100g) && scanResult.barcode_digits) {
      const bc = await postToAI({ mode: 'barcode', code: scanResult.barcode_digits });
      if (bc.result && bc.result.found) {
        scanResult = {
          ...scanResult,
          per_100g: bc.result.per_100g,
          product_name_guess: scanResult.product_name_guess || bc.result.product_name_guess,
          ingredients_summary: scanResult.ingredients_summary || bc.result.ingredients_summary,
        };
      } else {
        showAIError('Διάβασα τον barcode, αλλά δεν βρήκα το προϊόν στη βάση δεδομένων. Δοκίμασε φωτογραφία της ετικέτας διατροφικών στοιχείων, ή περιέγραψέ το με λόγια στο πάνω πεδίο.');
        return;
      }
    }

    if (!hasUsableNutrition(scanResult.per_100g)) {
      showAIError('Δεν κατάφερα να διαβάσω διατροφικά στοιχεία από τη φωτογραφία. Δοκίμασε πιο καθαρή/κοντινή φωτογραφία της ετικέτας.');
      return;
    }

    showGramsStep(scanResult);
  } catch (err) {
    showAIError('Αποτυχία σύνδεσης. Αν βλέπεις αυτή τη σελίδα ως προεπισκόπηση (όχι στο πραγματικό Netlify site), αυτό είναι αναμενόμενο — δοκίμασέ το μετά το deploy.');
  } finally {
    setAILoading(false);
  }
}

async function runScanBarcode(code) {
  hideAIError();
  hideAIResult();
  setAILoading(true);
  try {
    const { result, error } = await postToAI({ mode: 'barcode', code });
    if (error) { showAIError(error); return; }
    if (!result || !result.found) {
      showAIError('Δεν βρέθηκε προϊόν με αυτόν τον κωδικό barcode. Δοκίμασε φωτογραφία της ετικέτας διατροφικών στοιχείων αντ\' αυτού.');
      return;
    }
    showGramsStep(result);
  } catch (err) {
    showAIError('Αποτυχία σύνδεσης. Αν βλέπεις αυτή τη σελίδα ως προεπισκόπηση (όχι στο πραγματικό Netlify site), αυτό είναι αναμενόμενο — δοκίμασέ το μετά το deploy.');
  } finally {
    setAILoading(false);
  }
}

function initAIView() {
  document.getElementById('aiForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const description = document.getElementById('aiDescription').value.trim();
    if (!description) return;
    runAIText(description);
  });

  const photoInput = document.getElementById('scanPhotoInput');
  photoInput.addEventListener('change', () => {
    const file = photoInput.files[0];
    photoInput.value = '';
    if (!file) return;
    runScanPhoto(file);
  });

  document.getElementById('scanBarcodeForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = document.getElementById('scanBarcodeInput').value.trim();
    if (!code) return;
    runScanBarcode(code);
  });

  document.getElementById('scanCalcBtn').addEventListener('click', () => {
    if (!currentScanResult) return;
    const grams = parseFloat(document.getElementById('scanGrams').value) || 0;
    const factor = grams / 100;
    const p = currentScanResult.per_100g;
    showAIResult({
      name: currentScanResult.product_name_guess,
      cal: (p.calories || 0) * factor,
      pro: (p.protein_g || 0) * factor,
      carb: (p.carbs_g || 0) * factor,
      fat: (p.fat_g || 0) * factor,
      fib: (p.fiber_g || 0) * factor,
    });
  });

  document.getElementById('aiConfirmBtn').addEventListener('click', () => {
    const name = document.getElementById('aiResultName').value.trim() || 'Γεύμα';
    const cal = parseFloat(document.getElementById('aiResultCal').value) || 0;
    const pro = parseFloat(document.getElementById('aiResultPro').value) || 0;
    const carb = parseFloat(document.getElementById('aiResultCarb').value) || 0;
    const fat = parseFloat(document.getElementById('aiResultFat').value) || 0;
    const fib = parseFloat(document.getElementById('aiResultFib').value) || 0;

    addEntry(state.currentDate, { name, cal, pro, carb, fat, fib });
    hideAIResult();
    document.getElementById('aiForm').reset();
    document.getElementById('scanBarcodeForm').reset();
    renderDay();
    showToast('Προστέθηκε στο ημερολόγιο.');
  });

  document.getElementById('aiFavoriteBtn').addEventListener('click', () => {
    const name = document.getElementById('aiResultName').value.trim() || 'Αγαπημένο τρόφιμο';
    if (currentScanResult) {
      // Scan result: naturally a per-100g item, so save it that way — the
      // "μερίδες" multiplier in quick-add then scales it up.
      const p = currentScanResult.per_100g;
      state.foods.push({
        id: uid(),
        name,
        serving: '100g',
        cal: round1(p.calories || 0),
        pro: round1(p.protein_g || 0),
        carb: round1(p.carbs_g || 0),
        fat: round1(p.fat_g || 0),
        fib: round1(p.fiber_g || 0),
      });
      saveJSON(STORAGE_KEYS.foods, state.foods);
      renderFoods();
      renderQuickAddOptions();
      showToast('Προστέθηκε στα αγαπημένα (τιμές ανά 100γρ) — χρησιμοποίησε τις «μερίδες» στη γρήγορη προσθήκη για να πολλαπλασιάσεις.');
    } else {
      // Free-text AI estimate: no natural per-100g basis, so save exactly
      // the amounts currently shown (for whatever quantity was described).
      const cal = parseFloat(document.getElementById('aiResultCal').value) || 0;
      const pro = parseFloat(document.getElementById('aiResultPro').value) || 0;
      const carb = parseFloat(document.getElementById('aiResultCarb').value) || 0;
      const fat = parseFloat(document.getElementById('aiResultFat').value) || 0;
      const fib = parseFloat(document.getElementById('aiResultFib').value) || 0;
      state.foods.push({
        id: uid(),
        name,
        serving: '',
        cal: round1(cal), pro: round1(pro), carb: round1(carb), fat: round1(fat), fib: round1(fib),
      });
      saveJSON(STORAGE_KEYS.foods, state.foods);
      renderFoods();
      renderQuickAddOptions();
      showToast('Προστέθηκε στα αγαπημένα.');
    }
  });

  document.getElementById('aiDiscardBtn').addEventListener('click', () => {
    hideAIResult();
  });
}

function renderQuickAddOptions() {
  const select = document.getElementById('quickAddSelect');
  const current = select.value;
  select.innerHTML = '<option value="">— Επιλογή από τα τρόφιμά μου —</option>' +
    state.foods.map(f => `<option value="${f.id}">${escapeHtml(f.name)} (${f.cal} kcal)</option>`).join('');
  select.value = current;
}

function renderDay() {
  document.getElementById('datePicker').value = state.currentDate;

  const list = getEntriesFor(state.currentDate);
  const totals = sumEntries(list);
  const goals = state.goals;

  document.getElementById('calSum').textContent = Math.round(totals.cal);
  document.getElementById('calGoal').textContent = goals.cal;
  document.getElementById('proSum').textContent = round1(totals.pro);
  document.getElementById('proGoal').textContent = goals.pro;
  document.getElementById('carbSum').textContent = round1(totals.carb);
  document.getElementById('carbGoal').textContent = goals.carb;
  document.getElementById('fatSum').textContent = round1(totals.fat);
  document.getElementById('fatGoal').textContent = goals.fat;
  document.getElementById('fibSum').textContent = round1(totals.fib);
  document.getElementById('fibGoal').textContent = goals.fib;

  setBar('calBar', totals.cal, goals.cal);
  setBar('proBar', totals.pro, goals.pro);
  setBar('carbBar', totals.carb, goals.carb);
  setBar('fatBar', totals.fat, goals.fat);
  setBar('fibBar', totals.fib, goals.fib);

  const remaining = goals.cal - totals.cal;
  const remainEl = document.getElementById('calRemaining');
  if (remaining >= 0) {
    remainEl.textContent = `Απομένουν ${Math.round(remaining)} kcal`;
  } else {
    remainEl.textContent = `${Math.round(-remaining)} kcal πάνω από τον στόχο`;
  }

  const listEl = document.getElementById('entryList');
  if (list.length === 0) {
    listEl.innerHTML = '<li class="empty-hint">Δεν έχεις καταχωρήσει ακόμα γεύματα για αυτή την ημέρα.</li>';
  } else {
    listEl.innerHTML = list.map(e => `
      <li>
        <div class="entry-main">
          <span class="entry-name">${escapeHtml(e.name)}</span>
          <span class="entry-macros">P ${round1(e.pro)}g · C ${round1(e.carb)}g · F ${round1(e.fat)}g · Ίνες ${round1(e.fib || 0)}g</span>
        </div>
        <div class="entry-actions">
          <span class="entry-cal">${Math.round(e.cal)} kcal</span>
          <button class="delete-btn" data-id="${e.id}" title="Διαγραφή">✕</button>
        </div>
      </li>
    `).join('');
  }

  renderQuickAddOptions();
  renderSupplements();
}

function setBar(id, value, goal) {
  const el = document.getElementById(id);
  const pct = goal > 0 ? Math.min(100, (value / goal) * 100) : 0;
  el.style.width = pct + '%';
  if (goal > 0 && value > goal) {
    el.classList.add('over');
  } else {
    el.classList.remove('over');
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/* ---------------- FOODS LIBRARY VIEW ---------------- */

function initFoodsView() {
  // No add-form here anymore — foods are saved as favorites from the Day
  // view (AI-text or scan results). This view only lists and deletes them.
  document.getElementById('foodsTableBody').addEventListener('click', (e) => {
    const btn = e.target.closest('.delete-btn');
    if (!btn) return;
    state.foods = state.foods.filter(f => f.id !== btn.dataset.id);
    saveJSON(STORAGE_KEYS.foods, state.foods);
    renderFoods();
    renderQuickAddOptions();
  });
}

function renderFoods() {
  const tbody = document.getElementById('foodsTableBody');
  const emptyHint = document.getElementById('foodsEmptyHint');
  if (state.foods.length === 0) {
    tbody.innerHTML = '';
    emptyHint.style.display = 'block';
    return;
  }
  emptyHint.style.display = 'none';
  tbody.innerHTML = state.foods.map(f => `
    <tr>
      <td>${escapeHtml(f.name)}</td>
      <td>${escapeHtml(f.serving || '—')}</td>
      <td>${Math.round(f.cal)}</td>
      <td>${round1(f.pro)}</td>
      <td>${round1(f.carb)}</td>
      <td>${round1(f.fat)}</td>
      <td>${round1(f.fib || 0)}</td>
      <td><button class="delete-btn" data-id="${f.id}" title="Διαγραφή">✕</button></td>
    </tr>
  `).join('');
}

/* ---------------- HISTORY VIEW ---------------- */

function getLastNDays(n) {
  const days = [];
  for (let i = n - 1; i >= 0; i--) {
    days.push(addDays(todayStr(), -i));
  }
  return days;
}

/* ---------------- statistics ---------------- */

let statsPeriodDays = 7;

function computeStats(days) {
  const dayList = getLastNDays(days);
  const perDay = dayList.map(d => {
    const entries = getEntriesFor(d);
    return { date: d, hasEntries: entries.length > 0, totals: sumEntries(entries) };
  });
  const loggedDays = perDay.filter(d => d.hasEntries);
  const n = loggedDays.length;

  const avg = (key) => n > 0 ? loggedDays.reduce((sum, d) => sum + (d.totals[key] || 0), 0) / n : 0;
  const avgCal = avg('cal'), avgPro = avg('pro'), avgCarb = avg('carb'), avgFat = avg('fat'), avgFib = avg('fib');

  const calGoal = state.goals.cal || 0;
  const withinCalGoal = calGoal > 0
    ? loggedDays.filter(d => Math.abs(d.totals.cal - calGoal) <= calGoal * 0.1).length
    : 0;

  // Supplement adherence over the period — counted only from each
  // supplement's own createdAt date onward, so a recently-added supplement
  // doesn't drag the percentage down for days before it existed.
  let taken = 0, possible = 0;
  state.supplements.forEach(s => {
    const relevantDays = s.createdAt ? dayList.filter(d => d >= s.createdAt) : dayList;
    possible += relevantDays.length;
    relevantDays.forEach(d => {
      if (getSupplementLogFor(d).includes(s.name)) taken++;
    });
  });
  const adherencePct = possible > 0 ? Math.round((taken / possible) * 100) : null;

  return { n, avgCal, avgPro, avgCarb, avgFat, avgFib, calGoal, withinCalGoal, adherencePct, taken, possible };
}

function statDeltaNote(value, goal) {
  if (!goal) return '';
  const diff = value - goal;
  const pct = Math.round((diff / goal) * 100);
  if (Math.abs(pct) < 3) return { text: 'στον στόχο', over: false };
  return { text: (diff > 0 ? `+${pct}% πάνω από στόχο` : `${pct}% κάτω από στόχο`), over: diff > 0 };
}

function renderStats(days) {
  const grid = document.getElementById('statsGrid');
  const hint = document.getElementById('statsHint');
  const stats = computeStats(days);

  if (stats.n === 0) {
    grid.innerHTML = '';
    hint.textContent = `Δεν έχεις καταχωρήσει γεύματα τις τελευταίες ${days} ημέρες.`;
    hint.hidden = false;
    return;
  }
  hint.hidden = true;

  const goals = state.goals;
  const macroTiles = [
    { label: 'Μ.Ο. Θερμίδων', value: Math.round(stats.avgCal), goal: Math.round(goals.cal || 0), unit: 'kcal' },
    { label: 'Μ.Ο. Πρωτεΐνης', value: round1(stats.avgPro), goal: round1(goals.pro || 0), unit: 'g' },
    { label: 'Μ.Ο. Υδατανθράκων', value: round1(stats.avgCarb), goal: round1(goals.carb || 0), unit: 'g' },
    { label: 'Μ.Ο. Λίπους', value: round1(stats.avgFat), goal: round1(goals.fat || 0), unit: 'g' },
    { label: 'Μ.Ο. Ινών', value: round1(stats.avgFib), goal: round1(goals.fib || 0), unit: 'g' },
  ];

  let html = macroTiles.map(t => {
    const note = statDeltaNote(t.value, t.goal);
    const noteHtml = note ? `<div class="stat-tile-sub${note.over ? ' over' : ''}">${note.text}</div>` : '';
    return `
      <div class="stat-tile">
        <div class="stat-tile-label">${t.label}</div>
        <div class="stat-tile-value">${t.value}<span>/${t.goal}${t.unit}</span></div>
        ${noteHtml}
      </div>
    `;
  }).join('');

  html += `
    <div class="stat-tile wide">
      <div class="stat-tile-label">Ημέρες εντός θερμιδικού στόχου (±10%)</div>
      <div class="stat-tile-value">${stats.withinCalGoal}<span>/${stats.n} ημέρες με καταχωρήσεις</span></div>
    </div>
  `;

  if (stats.adherencePct !== null) {
    html += `
      <div class="stat-tile wide">
        <div class="stat-tile-label">Προσήλωση συμπληρωμάτων</div>
        <div class="stat-tile-value">${stats.adherencePct}<span>% (${stats.taken}/${stats.possible} λήψεις)</span></div>
      </div>
    `;
  }

  grid.innerHTML = html;
}

function initStatsView() {
  document.getElementById('statsPeriodToggle').addEventListener('click', (e) => {
    const btn = e.target.closest('.period-btn');
    if (!btn) return;
    statsPeriodDays = parseInt(btn.dataset.days, 10) || 7;
    document.querySelectorAll('#statsPeriodToggle .period-btn').forEach(b => b.classList.toggle('active', b === btn));
    renderStats(statsPeriodDays);
  });
}

function renderHistory() {
  renderStats(statsPeriodDays);
  const days = getLastNDays(14);
  const totalsPerDay = days.map(d => sumEntries(getEntriesFor(d)));

  const ctx = document.getElementById('historyChart');
  const labels = days.map(fmtDateLabel);
  const calData = totalsPerDay.map(t => Math.round(t.cal));
  const goalLine = days.map(() => state.goals.cal);

  if (typeof Chart === 'undefined') {
    console.warn('Chart.js δεν φορτώθηκε (πιθανώς αποκλεισμός δικτύου/ad-blocker). Το γράφημα παραλείπεται.');
  } else {
  if (historyChart) historyChart.destroy();
  historyChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Θερμίδες',
          data: calData,
          backgroundColor: calData.map(v => v > state.goals.cal ? '#d15252' : '#3a9d5c'),
          borderRadius: 6,
          order: 2,
        },
        {
          label: 'Στόχος',
          data: goalLine,
          type: 'line',
          borderColor: '#e0932e',
          borderDash: [6, 4],
          pointRadius: 0,
          borderWidth: 2,
          order: 1,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { position: 'bottom' } },
      scales: { y: { beginAtZero: true } },
    },
  });
  }

  const tbody = document.getElementById('historyTableBody');
  tbody.innerHTML = days.slice().reverse().map((d, idx) => {
    const t = totalsPerDay[days.length - 1 - idx];
    return `<tr>
      <td>${fmtDateLabel(d)}</td>
      <td>${Math.round(t.cal)}</td>
      <td>${round1(t.pro)}g</td>
      <td>${round1(t.carb)}g</td>
      <td>${round1(t.fat)}g</td>
      <td>${round1(t.fib || 0)}g</td>
    </tr>`;
  }).join('');

  renderSupplementHistory();
}

function renderSupplementHistory() {
  const days = getLastNDays(30);
  const tbody = document.getElementById('supplementHistoryBody');

  if (state.supplements.length === 0) {
    tbody.innerHTML = '<tr><td colspan="2" class="empty-hint">Δεν έχεις προσθέσει ακόμα συμπληρώματα.</td></tr>';
    return;
  }

  const sorted = sortedSupplements();
  tbody.innerHTML = days.slice().reverse().map(d => {
    const takenList = getSupplementLogFor(d);
    const takenNames = sorted.filter(s => takenList.includes(s.name)).map(s => s.name);
    const total = sorted.length;
    const namesStr = takenNames.length ? ' — ' + takenNames.map(n => escapeHtml(n)).join(', ') : '';
    return `<tr>
      <td>${fmtDateLabel(d)}</td>
      <td>${takenNames.length}/${total}${namesStr}</td>
    </tr>`;
  }).join('');

  renderSupplementSummary(days);
}

function renderSupplementSummary(days) {
  const tbody = document.getElementById('supplementSummaryBody');
  if (!tbody) return;

  if (state.supplements.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="empty-hint">Δεν έχεις προσθέσει ακόμα συμπληρώματα.</td></tr>';
    return;
  }

  const sorted = sortedSupplements();
  tbody.innerHTML = sorted.map(s => {
    // Only count days from when the supplement was actually added, so a
    // recently-added supplement doesn't look "missed" for days before it existed.
    const relevantDays = s.createdAt ? days.filter(d => d >= s.createdAt) : days;
    const total = relevantDays.length;
    const taken = relevantDays.filter(d => getSupplementLogFor(d).includes(s.name)).length;
    const missed = total - taken;
    return `<tr>
      <td>${escapeHtml(s.name)}</td>
      <td>${taken}/${total}</td>
      <td>${missed}</td>
    </tr>`;
  }).join('');
}

/* ---------------- GOALS VIEW ---------------- */

function initGoalsView() {
  document.getElementById('goalCal').value = state.goals.cal;
  document.getElementById('goalPro').value = state.goals.pro;
  document.getElementById('goalCarb').value = state.goals.carb;
  document.getElementById('goalFat').value = state.goals.fat;
  document.getElementById('goalFib').value = state.goals.fib;

  document.getElementById('goalsForm').addEventListener('submit', (e) => {
    e.preventDefault();
    state.goals = {
      cal: parseFloat(document.getElementById('goalCal').value) || 0,
      pro: parseFloat(document.getElementById('goalPro').value) || 0,
      carb: parseFloat(document.getElementById('goalCarb').value) || 0,
      fat: parseFloat(document.getElementById('goalFat').value) || 0,
      fib: parseFloat(document.getElementById('goalFib').value) || 0,
    };
    saveJSON(STORAGE_KEYS.goals, state.goals);
    renderDay();
    showToast('Οι στόχοι αποθηκεύτηκαν.');
  });

  document.getElementById('calcCaloriesBtn').addEventListener('click', () => {
    const pro = parseFloat(document.getElementById('goalPro').value) || 0;
    const carb = parseFloat(document.getElementById('goalCarb').value) || 0;
    const fat = parseFloat(document.getElementById('goalFat').value) || 0;
    const cal = Math.round(pro * 4 + carb * 4 + fat * 9);
    document.getElementById('goalCal').value = cal;
    showToast(`Υπολογίστηκαν ${cal} kcal από τα μακροθρεπτικά.`);
  });

  document.getElementById('exportBtn').addEventListener('click', () => {
    const data = {
      goals: state.goals,
      foods: state.foods,
      entries: state.entries,
      supplements: state.supplements,
      supplementLog: state.supplementLog,
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nutrition-backup-${todayStr()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  document.getElementById('importInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (data.goals) { state.goals = data.goals; saveJSON(STORAGE_KEYS.goals, state.goals); }
        if (data.foods) { state.foods = data.foods; saveJSON(STORAGE_KEYS.foods, state.foods); }
        if (data.entries) { state.entries = data.entries; saveJSON(STORAGE_KEYS.entries, state.entries); }
        if (data.supplements) { state.supplements = data.supplements; saveJSON(STORAGE_KEYS.supplements, state.supplements); }
        if (data.supplementLog) { state.supplementLog = data.supplementLog; saveJSON(STORAGE_KEYS.supplementLog, state.supplementLog); }
        initGoalsView();
        renderDay();
        renderFoods();
        renderSupplementManageList();
        showToast('Τα δεδομένα εισήχθησαν επιτυχώς.');
      } catch (err) {
        showToast('Το αρχείο δεν είναι έγκυρο.');
      }
      e.target.value = '';
    };
    reader.readAsText(file);
  });

  document.getElementById('resetBtn').addEventListener('click', () => {
    if (!confirm('Σίγουρα θέλεις να διαγράψεις όλα τα δεδομένα; Αυτή η ενέργεια δεν αναιρείται.')) return;
    localStorage.removeItem(STORAGE_KEYS.goals);
    localStorage.removeItem(STORAGE_KEYS.foods);
    localStorage.removeItem(STORAGE_KEYS.entries);
    localStorage.removeItem(STORAGE_KEYS.supplements);
    localStorage.removeItem(STORAGE_KEYS.supplementLog);
    state.goals = { ...DEFAULT_GOALS };
    state.foods = [];
    state.entries = {};
    state.supplements = [];
    state.supplementLog = {};
    initGoalsView();
    renderDay();
    renderFoods();
    renderSupplementManageList();
    showToast('Όλα τα δεδομένα διαγράφηκαν.');
  });
}

/* ---------------- INIT ---------------- */

function init() {
  initTabs();
  initDayView();
  initAIView();
  initSupplementsView();
  initFoodsView();
  initGoalsView();
  initCloudSyncView();
  initStatsView();
  renderDay();
  renderFoods();
  renderSupplementManageList();
}

document.addEventListener('DOMContentLoaded', init);

