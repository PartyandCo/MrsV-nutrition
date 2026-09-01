// Netlify serverless function (v2 API — Request/Response, ESM).
//
// Three modes, selected by body.mode:
//   'text'    (default) — free-text meal description -> estimated nutrition.
//   'photo'   — a photo of a nutrition-facts label and/or a barcode -> the
//               AI reads whatever it can see (per-100g nutrition values,
//               and/or the barcode's printed digit string).
//   'barcode' — a barcode number -> looked up in the free Open Food Facts
//               database (no AI call needed for this one).
//
// Requires the environment variable ANTHROPIC_API_KEY to be set in the
// Netlify site (Site settings -> Environment variables) for the 'text' and
// 'photo' modes. Optionally ANTHROPIC_MODEL to override the default model,
// and APP_SHARED_SECRET to require a matching header from the frontend (a
// light deterrent against random bots hitting this endpoint and spending
// your API credits — not real authentication, since a static site can't
// keep a secret truly private. See README.md for details).

const DEFAULT_MODEL = 'claude-haiku-4-5';
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_IMAGE_BASE64_LENGTH = 6_000_000; // ~4.5MB decoded — generous after client-side resizing
const MAX_BARCODE_LENGTH = 32;

const TEXT_TOOL = {
  name: 'record_nutrition_estimate',
  description: 'Καταγράφει την εκτίμηση θερμίδων και μακροθρεπτικών για ένα γεύμα.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: 'Τα επιμέρους τρόφιμα/συστατικά που αναγνωρίστηκαν στην περιγραφή.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            estimated_serving: { type: 'string', description: 'π.χ. "2 τεμάχια", "150γρ"' },
            calories: { type: 'number' },
            protein_g: { type: 'number' },
            carbs_g: { type: 'number' },
            fat_g: { type: 'number' },
            fiber_g: { type: 'number' },
          },
          required: ['name', 'calories', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g'],
        },
      },
      total: {
        type: 'object',
        description: 'Το άθροισμα όλων των items.',
        properties: {
          calories: { type: 'number' },
          protein_g: { type: 'number' },
          carbs_g: { type: 'number' },
          fat_g: { type: 'number' },
          fiber_g: { type: 'number' },
        },
        required: ['calories', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g'],
      },
      summary_name: {
        type: 'string',
        description: 'Σύντομη περιγραφή του γεύματος στα ελληνικά για εμφάνιση στη λίστα καταχωρήσεων, π.χ. "2 αυγά + φέτα ψωμί".',
      },
      confidence_note: {
        type: 'string',
        description: 'Προαιρετική, πολύ σύντομη σημείωση αν κάποια ποσότητα ήταν ασαφής και υποθέσατε μια συνηθισμένη μερίδα.',
      },
    },
    required: ['items', 'total', 'summary_name'],
  },
};

const PHOTO_TOOL = {
  name: 'record_label_scan',
  description: 'Καταγράφει ό,τι διαβάστηκε από μια φωτογραφία ετικέτας διατροφικών στοιχείων ή/και barcode.',
  input_schema: {
    type: 'object',
    properties: {
      source_type: {
        type: 'string',
        enum: ['nutrition_label', 'barcode', 'both', 'unclear'],
        description: 'Τι φαίνεται στη φωτογραφία.',
      },
      product_name_guess: {
        type: 'string',
        description: 'Το όνομα του προϊόντος, αν φαίνεται στη συσκευασία/ετικέτα.',
      },
      barcode_digits: {
        type: 'string',
        description: 'Η σειρά ψηφίων κάτω από το barcode, ΜΟΝΟ αν φαίνεται καθαρά. Άδειο string αν δεν υπάρχει/δεν διαβάζεται.',
      },
      per_100g: {
        type: 'object',
        description: 'Διατροφικές τιμές ΑΝΑ 100 ΓΡΑΜΜΑΡΙΑ, ακριβώς όπως αναγράφονται στον πίνακα διατροφικών στοιχείων της ετικέτας (όχι ανά μερίδα). Βάλε 0 σε ό,τι δεν φαίνεται.',
        properties: {
          calories: { type: 'number' },
          protein_g: { type: 'number' },
          carbs_g: { type: 'number' },
          fat_g: { type: 'number' },
          fiber_g: { type: 'number' },
        },
        required: ['calories', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g'],
      },
      ingredients_summary: {
        type: 'string',
        description: 'Πολύ σύντομη περίληψη (μία πρόταση) των βασικών συστατικών, αν αναγράφονται στην ετικέτα. Άδειο αν δεν φαίνεται λίστα συστατικών.',
      },
      confidence_note: {
        type: 'string',
        description: 'Προαιρετική, πολύ σύντομη σημείωση αν κάτι ήταν δυσανάγνωστο ή αβέβαιο.',
      },
    },
    required: ['source_type'],
  },
};

export default async (req) => {
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Επιτρέπεται μόνο μέθοδος POST.' }, 405);
  }

  const sharedSecret = Netlify.env.get('APP_SHARED_SECRET');
  if (sharedSecret) {
    const provided = req.headers.get('x-app-secret');
    if (provided !== sharedSecret) {
      return jsonResponse({ error: 'Μη εξουσιοδοτημένο αίτημα.' }, 401);
    }
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Μη έγκυρο αίτημα (αναμένεται JSON).' }, 400);
  }

  const mode = body && body.mode ? String(body.mode) : 'text';

  if (mode === 'barcode') {
    return handleBarcode(body);
  }
  if (mode === 'photo') {
    return handlePhoto(body);
  }
  return handleText(body);
};

async function handleText(body) {
  const description = (body && body.description ? String(body.description) : '').trim();
  if (!description) {
    return jsonResponse({ error: 'Λείπει η περιγραφή του γεύματος.' }, 400);
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return jsonResponse({ error: `Η περιγραφή είναι πολύ μεγάλη (μέγιστο ${MAX_DESCRIPTION_LENGTH} χαρακτήρες).` }, 400);
  }

  return callClaude({
    system:
      'Είσαι βοηθός διατροφολόγος μέσα σε μια εφαρμογή καταγραφής θερμίδων. ' +
      'Ο χρήστης περιγράφει σε ελεύθερο κείμενο τι έφαγε, συχνά χωρίς ακριβείς ποσότητες. ' +
      'Υπόθεσε λογικές, συνηθισμένες μερίδες όταν λείπουν στοιχεία, και υπολόγισε ρεαλιστικές ' +
      'εκτιμήσεις θερμίδων, πρωτεΐνης, υδατανθράκων, λίπους και φυτικών ινών (fiber) βασισμένες σε τυπικές διατροφικές τιμές. ' +
      'Κάλεσε ΠΑΝΤΑ το εργαλείο record_nutrition_estimate με το αποτέλεσμα — μην απαντάς με απλό κείμενο.',
    messages: [{ role: 'user', content: description }],
    tool: TEXT_TOOL,
  });
}

async function handlePhoto(body) {
  const image = body && body.image ? String(body.image) : '';
  const mediaType = body && body.mediaType ? String(body.mediaType) : 'image/jpeg';
  const allowedMediaTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

  if (!image) {
    return jsonResponse({ error: 'Λείπει η φωτογραφία.' }, 400);
  }
  if (image.length > MAX_IMAGE_BASE64_LENGTH) {
    return jsonResponse({ error: 'Η φωτογραφία είναι πολύ μεγάλη.' }, 400);
  }
  if (!allowedMediaTypes.includes(mediaType)) {
    return jsonResponse({ error: 'Μη υποστηριζόμενος τύπος εικόνας.' }, 400);
  }

  return callClaude({
    system:
      'Είσαι βοηθός μέσα σε μια εφαρμογή καταγραφής θερμίδων. Ο χρήστης σου στέλνει μια φωτογραφία ' +
      'μιας συσκευασίας τροφίμου. Μπορεί να δείχνει τον πίνακα διατροφικών στοιχείων (nutrition facts), ' +
      'το barcode του προϊόντος, ή και τα δύο. ' +
      'Αν φαίνεται πίνακας διατροφικών στοιχείων, διάβασε ΠΡΟΣΕΚΤΙΚΑ τις τιμές ΑΝΑ 100 ΓΡΑΜΜΑΡΙΑ (όχι ανά μερίδα — αν η ετικέτα δείχνει μόνο ανά μερίδα, μετέτρεψέ τις σε ανά 100γρ αν είναι δυνατόν). ' +
      'Αν φαίνεται barcode με τυπωμένα ψηφία από κάτω, διάβασε ακριβώς αυτά τα ψηφία. ' +
      'Κάλεσε ΠΑΝΤΑ το εργαλείο record_label_scan με το αποτέλεσμα — μην απαντάς με απλό κείμενο.',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
          { type: 'text', text: 'Διάβασε αυτή τη φωτογραφία συσκευασίας τροφίμου.' },
        ],
      },
    ],
    tool: PHOTO_TOOL,
  });
}

async function handleBarcode(body) {
  const code = (body && body.code ? String(body.code) : '').trim().replace(/[^0-9]/g, '');
  if (!code) {
    return jsonResponse({ error: 'Λείπει ο κωδικός barcode.' }, 400);
  }
  if (code.length > MAX_BARCODE_LENGTH) {
    return jsonResponse({ error: 'Μη έγκυρος κωδικός barcode.' }, 400);
  }

  let offRes;
  try {
    offRes = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json`, {
      headers: { 'User-Agent': 'MrsVNutritionTracker/1.0 (personal use)' },
    });
  } catch (err) {
    return jsonResponse({ error: 'Αποτυχία σύνδεσης με τη βάση δεδομένων προϊόντων: ' + err.message }, 502);
  }

  if (!offRes.ok) {
    return jsonResponse({ error: `Η βάση δεδομένων προϊόντων επέστρεψε σφάλμα (${offRes.status}).` }, 502);
  }

  let offData;
  try {
    offData = await offRes.json();
  } catch {
    return jsonResponse({ error: 'Μη έγκυρη απάντηση από τη βάση δεδομένων προϊόντων.' }, 502);
  }

  if (offData.status !== 1 || !offData.product) {
    return jsonResponse({ result: { found: false } }, 200);
  }

  const n = offData.product.nutriments || {};
  const result = {
    found: true,
    product_name_guess: offData.product.product_name || offData.product.product_name_el || `Προϊόν ${code}`,
    per_100g: {
      calories: numOr0(n['energy-kcal_100g']),
      protein_g: numOr0(n['proteins_100g']),
      carbs_g: numOr0(n['carbohydrates_100g']),
      fat_g: numOr0(n['fat_100g']),
      fiber_g: numOr0(n['fiber_100g']),
    },
    ingredients_summary: (offData.product.ingredients_text_el || offData.product.ingredients_text || '').slice(0, 300),
  };

  return jsonResponse({ result }, 200);
}

async function callClaude({ system, messages, tool }) {
  const apiKey = Netlify.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    return jsonResponse({
      error: 'Δεν έχει ρυθμιστεί το ANTHROPIC_API_KEY στο Netlify. Δες το README.md για οδηγίες.',
    }, 500);
  }

  const model = Netlify.env.get('ANTHROPIC_MODEL') || DEFAULT_MODEL;

  const anthropicPayload = {
    model,
    max_tokens: 1024,
    system,
    messages,
    tools: [tool],
    tool_choice: { type: 'tool', name: tool.name },
  };

  let anthropicRes;
  try {
    anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(anthropicPayload),
    });
  } catch (err) {
    return jsonResponse({ error: 'Αποτυχία σύνδεσης με το AI: ' + err.message }, 502);
  }

  if (!anthropicRes.ok) {
    let details = '';
    try {
      details = (await anthropicRes.text()).slice(0, 500);
    } catch {
      // ignore
    }
    return jsonResponse({
      error: `Το AI επέστρεψε σφάλμα (${anthropicRes.status}). Έλεγξε ότι το ANTHROPIC_API_KEY είναι σωστό και έχει διαθέσιμο credit.`,
      details,
    }, 502);
  }

  const data = await anthropicRes.json();
  const toolUse = Array.isArray(data.content) ? data.content.find((b) => b.type === 'tool_use') : null;

  if (!toolUse) {
    return jsonResponse({ error: 'Το AI δεν επέστρεψε δομημένο αποτέλεσμα. Δοκίμασε ξανά.' }, 502);
  }

  return jsonResponse({ result: toolUse.input }, 200);
}

function numOr0(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
