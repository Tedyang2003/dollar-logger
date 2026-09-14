/* Receipt scanning.
 *
 * The model only ever returns text. Nothing here writes to the database: the
 * result goes back to the phone as a draft that pre-fills the add sheet, and
 * the user saves it through the normal POST /entries path.
 */

const MODEL = '@cf/qwen/qwen3.8-27b';
// Kept as a fallback: if Qwen is unavailable the scan still works, just less accurately.
const FALLBACK = '@cf/meta/llama-3.2-11b-vision-instruct';
const MAX_BYTES = 4 * 1024 * 1024;

const PROMPT = `You are transcribing a photo of a shop receipt.
Reply with ONLY this JSON object and no other text:
{"item": string, "merchant": string, "date": string,
 "amounts": [{"label": string, "value": number}]}
- item: a short description of what was bought
- merchant: the shop name printed on the receipt
- date: the date exactly as printed
- amounts: EVERY money amount in the summary section at the bottom of the
  receipt (subtotal, service charge, GST, discount, rounding, total, cash,
  change...), in the order they appear, with the label printed next to each.
  Copy labels exactly. Do not calculate anything.
Use null for anything you cannot read.`;

export async function scanReceipt(request, env, ctx) {
  const type = request.headers.get('Content-Type') || '';
  if (!/^image\/(jpeg|png|webp)$/.test(type)) {
    return ctx.json({ error: 'expected an image/jpeg, image/png or image/webp body' }, 415);
  }

  const buf = await request.arrayBuffer();
  if (buf.byteLength === 0) return ctx.json({ error: 'empty image' }, 400);
  if (buf.byteLength > MAX_BYTES) return ctx.json({ error: 'image too large (max 4 MB)' }, 413);

  const bytes = new Uint8Array(buf);

  let res;
  try {
    res = await runModel(env, bytes, type);
  } catch (err) {
    console.error('vision model failed:', err && err.message);
    // Out of free quota, model down, etc. The phone falls back to typing.
    return ctx.json({ error: 'scan_unavailable' }, 503);
  }

  const draft = parseDraft(res);
  if (!draft) {
    // Log what the model actually said, so "unreadable" is diagnosable.
    console.warn('unparseable model reply:', JSON.stringify(res).slice(0, 800));
    return ctx.json({ error: 'unreadable' }, 422);
  }

  return ctx.json({ draft });
}

/* Qwen takes OpenAI-style chat messages with the image as a data URI, and
   answers in choices[0].message.content. Its "thinking" mode is switched off:
   for copying text off a receipt it gave the same answer with a fraction of
   the output tokens. If Qwen fails, fall back to Llama so scanning survives. */
async function runModel(env, bytes, type) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  const dataUri = 'data:' + type + ';base64,' + btoa(bin);

  try {
    const r = await env.AI.run(MODEL, {
      messages: [{ role: 'user', content: [
        { type: 'text', text: PROMPT },
        { type: 'image_url', image_url: { url: dataUri } }
      ] }],
      max_tokens: 600,
      chat_template_kwargs: { enable_thinking: false }
    });
    const msg = r && r.choices && r.choices[0] && r.choices[0].message;
    if (msg && msg.content) return msg.content;
    throw new Error('empty reply');
  } catch (err) {
    console.warn('qwen failed, falling back to llama:', err && err.message);
    return await runLlama(env, [...bytes]);
  }
}

async function runLlama(env, bytes) {
  try {
    const r = await env.AI.run(FALLBACK, { image: bytes, prompt: PROMPT, max_tokens: 256 });
    return r && r.response;
  } catch (err) {
    if (!/agree/i.test(String(err && err.message))) throw err;
    await env.AI.run(FALLBACK, { prompt: 'agree' });
    const r = await env.AI.run(FALLBACK, { image: bytes, prompt: PROMPT, max_tokens: 256 });
    return r && r.response;
  }
}

/* The model's reply is untrusted text. Pull out the JSON, then keep only the
   fields that pass the same rules a hand-typed entry would. Anything doubtful
   becomes null, so the form shows a blank rather than a confident mistake. */
export function parseDraft(reply) {
  let raw = null;

  // Workers AI sometimes parses JSON-looking replies itself and hands back an
  // object, and sometimes returns the raw text. Accept both.
  if (reply && typeof reply === 'object') {
    raw = reply;
  } else if (typeof reply === 'string') {
    const match = reply.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { raw = JSON.parse(match[0]); } catch (e) { return null; }
  }
  if (!raw || typeof raw !== 'object') return null;

  const draft = {
    item: cleanText(raw.item, 100),
    merchant: cleanText(raw.merchant, 60),
    amounts: cleanAmounts(raw.amounts),
    amount_cents: null,
    date: cleanDate(raw.date)
  };

  // Older-style reply with a single total still works.
  draft.amount_cents = pickTotal(draft.amounts);
  if (draft.amount_cents === null) draft.amount_cents = toCents(raw.total);

  // Nothing usable at all is the same as unreadable.
  if (!draft.item && !draft.merchant && draft.amount_cents === null && !draft.date) return null;
  return draft;
}

function cleanAmounts(list) {
  if (!Array.isArray(list)) return [];
  return list.map(a => ({
    label: cleanText(a && a.label, 40) || '',
    cents: toCents(a && (a.value !== undefined ? a.value : a.amount))
  })).filter(a => a.cents !== null).slice(0, 20);
}

/* Choose the amount actually paid, by label, in code rather than by asking the
   model to judge. Strongest labels first; among equals, the LAST one printed,
   since receipts run subtotal -> charges -> total. Payment lines ("cash",
   "change", "visa") are never the total. */
const TOTAL_RULES = [
  /grand\s*total|nett?\s*total|total\s*(payable|due|amount)|amount\s*(due|payable)|\bnett?\b/i,
  /^\s*total\b/i,
  /total/i
];
const NOT_TOTAL = /sub\s*-?\s*total|before|excl|gst|tax|svc|service|disc|round|cash|change|tender|visa|master|card|nets|paid|payment|balance/i;

function pickTotal(amounts) {
  for (const rule of TOTAL_RULES) {
    const hits = amounts.filter(a => rule.test(a.label) && !NOT_TOTAL.test(a.label));
    if (hits.length) return hits[hits.length - 1].cents;
  }
  return null;
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
  if (typeof v !== 'string') return null;
  v = v.trim();

  let y, m, d;
  let iso = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  // Receipts print dates day-first (DD/MM/YYYY) in Singapore and most places
  // outside the US, and the model copies what is printed rather than following
  // the requested format. Read slashed and dotted dates as day-first.
  let dmy = v.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if (iso) { y = +iso[1]; m = +iso[2]; d = +iso[3]; }
  else if (dmy) { d = +dmy[1]; m = +dmy[2]; y = +dmy[3]; if (y < 100) y += 2000; }
  else return null;

  const pad = n => String(n).padStart(2, '0');
  v = y + '-' + pad(m) + '-' + pad(d);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  // A receipt from the future is a misread, not a purchase.
  if (dt.getTime() > Date.now() + 86400000) return null;
  return v;
}
