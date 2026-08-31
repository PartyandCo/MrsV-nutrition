// Netlify serverless function (v2 API — Request/Response, ESM).
// Takes a free-text meal description and asks the Anthropic API to estimate
// calories/protein/carbs/fat for it, returned as structured JSON.
//
// Requires the environment variable ANTHROPIC_API_KEY to be set in the
// Netlify site (Site settings -> Environment variables). Optionally
// ANTHROPIC_MODEL to override the default model, and APP_SHARED_SECRET to
// require a matching header from the frontend (a light deterrent against
// random bots hitting this endpoint and spending your API credits — not
// real authentication, since a static site can't keep a secret truly
// private. See README.md for details).

const DEFAULT_MODEL = 'claude-haiku-4-5';
const MAX_DESCRIPTION_LENGTH = 500;

const NUTRITION_TOOL = {
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
          },
          required: ['name', 'calories', 'protein_g', 'carbs_g', 'fat_g'],
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
        },
        required: ['calories', 'protein_g', 'carbs_g', 'fat_g'],
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

  const description = (body && body.description ? String(body.description) : '').trim();
  if (!description) {
    return jsonResponse({ error: 'Λείπει η περιγραφή του γεύματος.' }, 400);
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return jsonResponse({ error: `Η περιγραφή είναι πολύ μεγάλη (μέγιστο ${MAX_DESCRIPTION_LENGTH} χαρακτήρες).` }, 400);
  }

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
    system:
      'Είσαι βοηθός διατροφολόγος μέσα σε μια εφαρμογή καταγραφής θερμίδων. ' +
      'Ο χρήστης περιγράφει σε ελεύθερο κείμενο τι έφαγε, συχνά χωρίς ακριβείς ποσότητες. ' +
      'Υπόθεσε λογικές, συνηθισμένες μερίδες όταν λείπουν στοιχεία, και υπολόγισε ρεαλιστικές ' +
      'εκτιμήσεις θερμίδων, πρωτεΐνης, υδατανθράκων και λίπους βασισμένες σε τυπικές διατροφικές τιμές. ' +
      'Κάλεσε ΠΑΝΤΑ το εργαλείο record_nutrition_estimate με το αποτέλεσμα — μην απαντάς με απλό κείμενο.',
    messages: [{ role: 'user', content: description }],
    tools: [NUTRITION_TOOL],
    tool_choice: { type: 'tool', name: 'record_nutrition_estimate' },
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
};

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
