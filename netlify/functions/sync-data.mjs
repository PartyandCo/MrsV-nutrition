// Netlify serverless function (v2 API — Request/Response, ESM).
// Automatic cloud backup/sync for the nutrition tracker's data, using
// Netlify Blobs (persists independently of deploys — it is NOT wiped when
// you push new site updates).
//
// Data is stored under a key derived from a personal PIN you choose once
// in the app (Στόχοι -> Αντίγραφο ασφαλείας στο cloud). Anyone who knows
// your PIN can read/write that backup — this is a light deterrent, not
// strong authentication (a static site can't keep real secrets private).
// Pick a PIN that isn't easily guessable, and don't share it. There is no
// "forgot PIN" recovery — if you lose it, that backup is unreachable
// (your data on THIS device is unaffected either way).

import { getStore } from '@netlify/blobs';

const MIN_PIN_LENGTH = 4;
const MAX_PIN_LENGTH = 32;
const MAX_BODY_SIZE = 2 * 1024 * 1024; // 2MB — generous for personal JSON data

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function normalizePin(pin) {
  return String(pin || '').trim();
}

function isValidPin(pin) {
  return pin.length >= MIN_PIN_LENGTH && pin.length <= MAX_PIN_LENGTH;
}

function blobKeyForPin(pin) {
  return `backup-${pin}`;
}

export default async (req) => {
  const store = getStore('nutrition-backups');

  if (req.method === 'GET') {
    const url = new URL(req.url);
    const pin = normalizePin(url.searchParams.get('pin'));
    if (!isValidPin(pin)) {
      return jsonResponse({ error: 'Μη έγκυρο PIN.' }, 400);
    }
    const record = await store.get(blobKeyForPin(pin), { type: 'json' });
    if (!record) {
      return jsonResponse({ found: false }, 200);
    }
    return jsonResponse({ found: true, data: record.payload, savedAt: record.savedAt }, 200);
  }

  if (req.method === 'POST') {
    let body;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: 'Μη έγκυρο αίτημα (αναμένεται JSON).' }, 400);
    }

    const pin = normalizePin(body.pin);
    if (!isValidPin(pin)) {
      return jsonResponse({ error: `Το PIN πρέπει να έχει ${MIN_PIN_LENGTH}-${MAX_PIN_LENGTH} χαρακτήρες.` }, 400);
    }
    if (!body.payload || typeof body.payload !== 'object') {
      return jsonResponse({ error: 'Λείπουν τα δεδομένα.' }, 400);
    }

    const raw = JSON.stringify(body.payload);
    if (raw.length > MAX_BODY_SIZE) {
      return jsonResponse({ error: 'Τα δεδομένα είναι πολύ μεγάλα.' }, 400);
    }

    const record = { payload: body.payload, savedAt: new Date().toISOString() };
    await store.setJSON(blobKeyForPin(pin), record);
    return jsonResponse({ ok: true, savedAt: record.savedAt }, 200);
  }

  return jsonResponse({ error: 'Επιτρέπονται μόνο GET/POST.' }, 405);
};
