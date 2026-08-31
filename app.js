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
  entries: 'nutri.entries', // { 'YYYY-MM-DD': [ {id, name, cal, pro, carb, fat} ] }
  supplements: 'nutri.supplements', // [ {id, name, notes} ]
  supplementLog: 'nutri.supplementLog', // { 'YYYY-MM-DD': [ name, name, ... ] }
  cloudPin: 'nutri.cloudPin', // plain string, not JSON — device-local, not synced
  cloudLastSync: 'nutri.cloudLastSync', // ISO timestamp string
};

const DEFAULT_GOALS = { cal: 2000, pro: 120, carb: 220, fat: 65 };

let state = {
  goals: loadJSON(STORAGE_KEYS.goals, DEFAULT_GOALS),
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
    return acc;
  }, { cal: 0, pro: 0, carb: 0, fat: 0 });
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
    state.supplements.push({ id: uid(), name, time, notes });
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
    if (!name) return;
    addEntry(state.currentDate, { name, cal, pro, carb, fat });
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

/* ---------------- AI FREE-TEXT ENTRY ---------------- */

const AI_ENDPOINT = '/api/estimate-nutrition';

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

function showAIResult(data) {
  const total = data.total || {};
  document.getElementById('aiResultName').value = data.summary_name || 'Γεύμα';
  document.getElementById('aiResultCal').value = Math.round(total.calories || 0);
  document.getElementById('aiResultPro').value = round1(total.protein_g || 0);
  document.getElementById('aiResultCarb').value = round1(total.carbs_g || 0);
  document.getElementById('aiResultFat').value = round1(total.fat_g || 0);

  const noteEl = document.getElementById('aiResultNote');
  if (data.confidence_note) {
    noteEl.textContent = 'Σημείωση AI: ' + data.confidence_note;
    noteEl.hidden = false;
  } else {
    noteEl.hidden = true;
  }

  document.getElementById('aiResult').hidden = false;
}

function hideAIResult() {
  document.getElementById('aiResult').hidden = true;
}

function initAIView() {
  document.getElementById('aiForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const description = document.getElementById('aiDescription').value.trim();
    if (!description) return;

    hideAIError();
    hideAIResult();
    setAILoading(true);

    try {
      const headers = { 'Content-Type': 'application/json' };
      if (APP_SHARED_SECRET) headers['x-app-secret'] = APP_SHARED_SECRET;

      const res = await fetch(AI_ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify({ description }),
      });

      const NO_BACKEND_MESSAGE = 'Αυτή η λειτουργία χρειάζεται το πραγματικό site σου στο Netlify (με ρυθμισμένο API key) — δεν είναι διαθέσιμη σε αυτή την προεπισκόπηση. Δοκίμασέ το μετά το deploy.';

      if (res.status === 404 || res.status === 501) {
        // No backend at this address — normal when running this page as a
        // plain static preview instead of the deployed Netlify site with the
        // serverless function + API key configured.
        showAIError(NO_BACKEND_MESSAGE);
        return;
      }

      let payload;
      try {
        payload = await res.json();
      } catch {
        // A non-JSON response body (an HTML error page, etc.) almost always
        // means there's no real function at this address rather than a
        // malformed reply from a genuine backend.
        showAIError(NO_BACKEND_MESSAGE);
        return;
      }

      if (!res.ok || payload.error) {
        showAIError(payload.error || `Σφάλμα (${res.status}).`);
        return;
      }

      showAIResult(payload.result);
    } catch (err) {
      showAIError('Αποτυχία σύνδεσης. Αν βλέπεις αυτή τη σελίδα ως προεπισκόπηση (όχι στο πραγματικό Netlify site), αυτό είναι αναμενόμενο — δοκίμασέ το μετά το deploy.');
    } finally {
      setAILoading(false);
    }
  });

  document.getElementById('aiConfirmBtn').addEventListener('click', () => {
    const name = document.getElementById('aiResultName').value.trim() || 'Γεύμα';
    const cal = parseFloat(document.getElementById('aiResultCal').value) || 0;
    const pro = parseFloat(document.getElementById('aiResultPro').value) || 0;
    const carb = parseFloat(document.getElementById('aiResultCarb').value) || 0;
    const fat = parseFloat(document.getElementById('aiResultFat').value) || 0;

    addEntry(state.currentDate, { name, cal, pro, carb, fat });
    hideAIResult();
    document.getElementById('aiForm').reset();
    renderDay();
    showToast('Προστέθηκε στο ημερολόγιο.');
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

  setBar('calBar', totals.cal, goals.cal);
  setBar('proBar', totals.pro, goals.pro);
  setBar('carbBar', totals.carb, goals.carb);
  setBar('fatBar', totals.fat, goals.fat);

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
          <span class="entry-macros">P ${round1(e.pro)}g · C ${round1(e.carb)}g · F ${round1(e.fat)}g</span>
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
  document.getElementById('foodForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = document.getElementById('foodName').value.trim();
    const serving = document.getElementById('foodServing').value.trim();
    const cal = parseFloat(document.getElementById('foodCal').value) || 0;
    const pro = parseFloat(document.getElementById('foodPro').value) || 0;
    const carb = parseFloat(document.getElementById('foodCarb').value) || 0;
    const fat = parseFloat(document.getElementById('foodFat').value) || 0;
    if (!name) return;
    state.foods.push({ id: uid(), name, serving, cal, pro, carb, fat });
    saveJSON(STORAGE_KEYS.foods, state.foods);
    e.target.reset();
    renderFoods();
    renderQuickAddOptions();
    showToast('Το τρόφιμο αποθηκεύτηκε.');
  });

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

function renderHistory() {
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
}

/* ---------------- GOALS VIEW ---------------- */

function initGoalsView() {
  document.getElementById('goalCal').value = state.goals.cal;
  document.getElementById('goalPro').value = state.goals.pro;
  document.getElementById('goalCarb').value = state.goals.carb;
  document.getElementById('goalFat').value = state.goals.fat;

  document.getElementById('goalsForm').addEventListener('submit', (e) => {
    e.preventDefault();
    state.goals = {
      cal: parseFloat(document.getElementById('goalCal').value) || 0,
      pro: parseFloat(document.getElementById('goalPro').value) || 0,
      carb: parseFloat(document.getElementById('goalCarb').value) || 0,
      fat: parseFloat(document.getElementById('goalFat').value) || 0,
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
  renderDay();
  renderFoods();
  renderSupplementManageList();
}

document.addEventListener('DOMContentLoaded', init);
