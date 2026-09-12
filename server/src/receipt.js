/* Receipt scanning.
 *
 * The model only ever returns text. Nothing here writes to the database: the
 * result goes back to the phone as a draft that pre-fills the add sheet, and
 * the user saves it through the normal POST /entries path.
 */

const MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
const MAX_BYTES = 4 * 1024 * 1024;

const PROMPT = `You are reading a photo of a shop receipt.
Reply with ONLY this JSON object and no other text:
{"item": string, "merchant": string, "total": number, "date": "YYYY-MM-DD"}
- item: a short description of what was bought (e.g. "groceries", "flat white")
- merchant: the shop name printed on the receipt
- total: the final amount paid, as a plain number with no currency symbol
- date: the purchase date
Use null for any field you cannot read clearly. Do not guess.`;

export async function scanReceipt(request, env, ctx) {
  const type = request.headers.get('Content-Type') || '';
  if (!/^image\/(jpeg|png|webp)$/.test(type)) {
    return ctx.json({ error: 'expected an image/jpeg, image/png or image/webp body' }, 415);
  }

  const buf = await request.arrayBuffer();
  if (buf.byteLength === 0) return ctx.json({ error: 'empty image' }, 400);
  if (buf.byteLength > MAX_BYTES) return ctx.json({ error: 'image too large (max 4 MB)' }, 413);

  const bytes = [...new Uint8Array(buf)];

  let res;
  try {
    res = await runModel(env, bytes);
  } catch (err) {
    console.error('vision model failed:', err && err.message);
    // Out of free quota, model down, etc. The phone falls back to typing.
    return ctx.json({ error: 'scan_unavailable' }, 503);
  }

  const draft = parseDraft(res && res.response);
  if (!draft) return ctx.json({ error: 'unreadable' }, 422);

  return ctx.json({ draft });
}

/* Meta's licence for Llama 3.2 Vision must be accepted once per Cloudflare
   account, by sending the literal prompt "agree". Do that automatically the
   first time the model refuses, then retry once. */
async function runModel(env, bytes) {
  try {
    return await env.AI.run(MODEL, { image: bytes, prompt: PROMPT, max_tokens: 256 });
  } catch (err) {
    if (!/agree/i.test(String(err && err.message))) throw err;
    await env.AI.run(MODEL, { prompt: 'agree' });
    return await env.AI.run(MODEL, { image: bytes, prompt: PROMPT, max_tokens: 256 });
  }
}

/* The model's reply is untrusted text. Pull out the JSON, then keep only the
   fields that pass the same rules a hand-typed entry would. Anything doubtful
   becomes null, so the form shows a blank rather than a confident mistake. */
export function parseDraft(text) {
  if (typeof text !== 'string') return null;

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;

  let raw;
  try { raw = JSON.parse(match[0]); } catch (e) { return null; }
  if (!raw || typeof raw !== 'object') return null;

  const draft = {
    item: cleanText(raw.item, 100),
    merchant: cleanText(raw.merchant, 60),
    amount_cents: toCents(raw.total),
    date: cleanDate(raw.date)
  };

  // Nothing usable at all is the same as unreadable.
  if (!draft.item && !draft.merchant && draft.amount_cents === null && !draft.date) return null;
  return draft;
}

function cleanText(v, max) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+/g, ' ').trim();
  if (!s || /^(null|unknown|n\/a)$/i.test(s)) return null;
  return s.slice(0, max);
}

function toCents(v) {
  // Models sometimes return "$12.50" or "12,50" despite being told not to.
  let n = typeof v === 'number' ? v
        : typeof v === 'string' ? parseFloat(v.replace(/[^0-9.,-]/g, '').replace(',', '.'))
        : NaN;
  if (!isFinite(n) || n <= 0 || n > 1000000) return null;
  return Math.round(parseFloat((n * 100).toFixed(4)));
}

function cleanDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  // A receipt from the future is a misread, not a purchase.
  if (dt.getTime() > Date.now() + 86400000) return null;
  return v;
}
