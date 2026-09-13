/* Dollar Logger API - a Cloudflare Worker.
 *
 * A Worker is one function that receives every request. There is no Express,
 * no server to keep running, no port to listen on. Cloudflare runs this at the
 * edge and your job is only to turn a Request into a Response.
 *
 * Configuration, none of which lives in this repo:
 *   [vars] GOOGLE_CLIENT_ID  - the OAuth client ID tokens must target (public)
 *   [vars] ALLOWED_ORIGIN    - comma-separated origins for CORS (public)
 *   wrangler secret put SESSION_SECRET - signing key for our own sessions (SECRET)
 *   wrangler secret put ALLOWED_EMAILS - optional allowlist of sign-ins
 */

import { verifyGoogleIdToken, AuthError, usingTestKeys } from './auth.js';
import { scanReceipt } from './receipt.js';
import { getSettings, putSettings, subscribePush, unsubscribePush, testPush, checkBudgetAlert } from './budget.js';
import { generateDue, createSubscription, listSubscriptions, cancelSubscription } from './subs.js';
import { issueSession, verifySession, revokeSessions, SessionError } from './session.js';

export default {
  // Cron trigger: log any subscription charges that have come due.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(generateDue(env).then(n => console.log('subscriptions: created', n)));
  },

  async fetch(request, env, execution) {
    const url = new URL(request.url);

    // CORS depends on the incoming Origin, so it is computed per request and
    // passed down. Never cache request-derived state in module scope: a Worker
    // isolate handles many requests, and you would leak one caller's origin
    // into another's response.
    const headers = corsHeaders(request, env);
    const ctx = {
      // Work that should finish after the response is sent (e.g. budget alerts).
      later(p) { if (execution && execution.waitUntil) execution.waitUntil(p.catch(e => console.warn('background:', e && e.message))); },
      json(body, status = 200) {
        return new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json', ...headers }
        });
      }
    };

    // Preflight must be answered before auth - a browser sends it without any
    // Authorization header, so requiring auth here would block every request.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    try {
      // Open, and deliberately says nothing about your data.
      if (url.pathname === '/health' && request.method === 'GET') {
        return ctx.json({
          ok: true,
          service: 'dollar-logger-api',
          auth_configured: !!env.GOOGLE_CLIENT_ID,
          test_keys: usingTestKeys(env),   // must be false in production
          time: new Date().toISOString()
        });
      }

      /* Trade a Google ID token for one of ours. This is the ONLY route that
         accepts a Google token; everything else takes our session. */
      if (url.pathname === '/session' && request.method === 'POST') {
        return await createSession(request, env, ctx);
      }

      // Everything past this point is scoped to a verified Google account.
      // Fail closed: any problem at all means 401, never a fallback identity.
      let user;
      try {
        user = await authenticate(request, env);
      } catch (err) {
        if (err instanceof AuthError || err instanceof SessionError) {
          console.warn('auth rejected:', err.reason);
          // The client needs to tell "sign in again" from "something broke".
          return ctx.json({ error: 'unauthorized', reason: err.reason === 'expired' ? 'expired' : undefined }, 401);
        }
        throw err;
      }

      if (url.pathname === '/session' && request.method === 'DELETE') {
        await revokeSessions(user.sub, env.DB);
        return ctx.json({ signed_out: true });
      }

      if (url.pathname === '/settings' && request.method === 'GET') return await getSettings(env, ctx, user);
      if (url.pathname === '/settings' && request.method === 'PUT') return await putSettings(request, env, ctx, user);
      if (url.pathname === '/push' && request.method === 'POST') return await subscribePush(request, env, ctx, user);
      if (url.pathname === '/push' && request.method === 'DELETE') return await unsubscribePush(request, env, ctx, user);
      if (url.pathname === '/push/test' && request.method === 'POST') return await testPush(env, ctx, user);

      if (url.pathname === '/subscriptions' && request.method === 'POST') {
        return await createSubscription(request, env, ctx, user);
      }
      if (url.pathname === '/subscriptions' && request.method === 'GET') {
        return await listSubscriptions(env, ctx, user);
      }
      const subDel = url.pathname.match(/^\/subscriptions\/([A-Za-z0-9]{1,40})$/);
      if (subDel && request.method === 'DELETE') {
        return await cancelSubscription(subDel[1], env, ctx, user);
      }

      if (url.pathname === '/receipts' && request.method === 'POST') {
        return await scanReceipt(request, env, ctx);
      }

      if (url.pathname === '/entries' && request.method === 'POST') {
        return await createEntry(request, env, ctx, user);
      }

      if (url.pathname === '/entries' && request.method === 'GET') {
        return await listEntries(url, env, ctx, user);
      }

      const del = url.pathname.match(/^\/entries\/([A-Za-z0-9_-]{1,64})$/);
      if (del && request.method === 'DELETE') {
        return await deleteEntry(del[1], env, ctx, user);
      }
      if (del && request.method === 'PATCH') {
        return await updateEntry(del[1], request, env, ctx, user);
      }

      return ctx.json({ error: 'not_found', path: url.pathname }, 404);
    } catch (err) {
      // Log the detail, return none of it - stack traces are a gift to attackers.
      console.error('unhandled', err && err.stack);
      return ctx.json({ error: 'server_error' }, 500);
    }
  }
};

/* ============================ auth ============================ */

function bearer(request) {
  const header = request.headers.get('Authorization') || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

// Normal requests carry OUR session token, not Google's.
async function authenticate(request, env) {
  const token = bearer(request);
  if (!token) throw new AuthError('missing_token');
  return await verifySession(token, env, env.DB);
}

/* POST /session - the one-time exchange.
   In: a Google ID token.  Out: a 30-day session this server signed. */
async function createSession(request, env, ctx) {
  const token = bearer(request);
  if (!token) return ctx.json({ error: 'unauthorized' }, 401);

  let user;
  try {
    user = await verifyGoogleIdToken(token, env);
  } catch (err) {
    if (err instanceof AuthError) {
      console.warn('session exchange rejected:', err.reason);
      return ctx.json({ error: 'unauthorized' }, 401);
    }
    throw err;
  }

  // Signing in for the first time is what creates the account.
  await env.DB.prepare('INSERT OR IGNORE INTO users (id, email) VALUES (?, ?)')
    .bind(user.sub, user.email)
    .run();

  const session = await issueSession(user, env);
  return ctx.json({
    token: session.token,
    expires_at: session.expires_at,
    user: { email: user.email }
  }, 201);
}

/* ============================ CORS ============================ */

function corsHeaders(request, env) {
  // Compared case-insensitively: hostnames are case-insensitive by spec and
  // browsers send them lowercased, so a capital letter in config would fail
  // CORS with no error message anywhere. Cheap to forgive, painful to debug.
  const allowed = String(env.ALLOWED_ORIGIN || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

  const origin = request.headers.get('Origin') || '';

  let allow = '';
  if (allowed.includes('*')) allow = '*';
  else if (origin && allowed.includes(origin.toLowerCase())) allow = origin;

  const headers = {
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
    // Responses differ by Origin, so caches must not reuse one for another.
    'Vary': 'Origin'
  };

  // No header at all when the origin is not on the list - that is what makes
  // the browser refuse the response.
  if (allow) headers['Access-Control-Allow-Origin'] = allow;

  return headers;
}

/* ============================ POST /entries ============================ */

async function createEntry(request, env, ctx, user) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return ctx.json({ error: 'invalid_json' }, 400);
  }

  const check = validateEntry(body);
  if (check.error) {
    return ctx.json({ error: 'invalid_entry', field: check.field, detail: check.error }, 400);
  }
  const e = check.value;
  const userId = user.sub;

  // First request from a new Google account creates their row.
  await env.DB.prepare('INSERT OR IGNORE INTO users (id, email) VALUES (?, ?)')
    .bind(userId, user.email)
    .run();

  const id = e.id || crypto.randomUUID();

  // ON CONFLICT DO NOTHING makes a retry harmless: if the phone resends after a
  // dropped connection, the same id arrives and we do not create a second row.
  const res = await env.DB.prepare(
    `INSERT INTO entries (id, user_id, date, amount_cents, category, item, merchant)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`
  ).bind(id, userId, e.date, e.amount_cents, e.category, e.item, e.merchant).run();

  const row = await env.DB.prepare(
    'SELECT * FROM entries WHERE id = ? AND user_id = ?'
  ).bind(id, userId).first();

  const inserted = res.meta.changes > 0;
  if (inserted) ctx.later(checkBudgetAlert(env, userId));
  return ctx.json({ entry: toApi(row), duplicate: !inserted }, inserted ? 201 : 200);
}

/* ============================ PATCH /entries/:id ============================ */

async function updateEntry(id, request, env, ctx, user) {
  let body;
  try { body = await request.json(); } catch (e) { return ctx.json({ error: 'invalid_json' }, 400); }

  // Same rules as creating one: an edit is not a way around validation.
  const check = validateEntry({ ...body, id });
  if (check.error) return ctx.json({ error: 'invalid_entry', field: check.field, detail: check.error }, 400);
  const e = check.value;

  // user_id in the WHERE, as with delete: you can only edit your own rows.
  const res = await env.DB.prepare(
    `UPDATE entries SET date = ?, amount_cents = ?, category = ?, item = ?, merchant = ?,
            updated_at = datetime('now')
      WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
  ).bind(e.date, e.amount_cents, e.category, e.item, e.merchant, id, user.sub).run();

  if (res.meta.changes === 0) return ctx.json({ error: 'not_found' }, 404);

  ctx.later(checkBudgetAlert(env, user.sub));   // a bigger amount can cross 80%
  const row = await env.DB.prepare('SELECT * FROM entries WHERE id = ? AND user_id = ?').bind(id, user.sub).first();
  return ctx.json({ entry: toApi(row) });
}

/* ============================ DELETE /entries/:id ============================ */

async function deleteEntry(id, env, ctx, user) {
  const userId = user.sub;

  // user_id belongs in the WHERE clause, not in an ownership check afterwards.
  // Matching on id alone is the classic IDOR bug: anyone who guesses an id
  // deletes someone else's row, and no amount of later checking undoes it.
  const res = await env.DB.prepare(
    `UPDATE entries
        SET deleted_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
  ).bind(id, userId).run();

  if (res.meta.changes > 0) {
    return ctx.json({ deleted: true, id: id, already_deleted: false });
  }

  const existing = await env.DB.prepare(
    'SELECT id FROM entries WHERE id = ? AND user_id = ?'
  ).bind(id, userId).first();

  // Deleting twice succeeds. The phone may resend after a dropped connection,
  // and "it is gone" is equally true the second time.
  if (existing) {
    return ctx.json({ deleted: true, id: id, already_deleted: true });
  }

  // Same 404 whether the entry never existed or belongs to someone else.
  // A 403 here would confirm the id is real - a free oracle for guessing ids.
  return ctx.json({ error: 'not_found' }, 404);
}

/* ============================ GET /entries ============================ */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

async function listEntries(url, env, ctx, user) {
  const q = url.searchParams;
  const userId = user.sub;

  const from = q.get('from');
  const to = q.get('to');
  if (from && !isValidDate(from)) {
    return ctx.json({ error: 'invalid_query', field: 'from', detail: "must be 'YYYY-MM-DD'" }, 400);
  }
  if (to && !isValidDate(to)) {
    return ctx.json({ error: 'invalid_query', field: 'to', detail: "must be 'YYYY-MM-DD'" }, 400);
  }

  let limit = DEFAULT_LIMIT;
  if (q.has('limit')) {
    limit = Number(q.get('limit'));
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      return ctx.json({ error: 'invalid_query', field: 'limit', detail: '1 to ' + MAX_LIMIT }, 400);
    }
  }

  let cursor = null;
  if (q.has('cursor')) {
    cursor = decodeCursor(q.get('cursor'));
    if (!cursor) {
      return ctx.json({ error: 'invalid_query', field: 'cursor', detail: 'malformed' }, 400);
    }
  }

  // The clause STRUCTURE is assembled here, but every VALUE is still bound with
  // a placeholder. Building SQL dynamically is fine; interpolating values is not.
  const where = ['user_id = ?', 'deleted_at IS NULL'];
  const args = [userId];

  if (from) { where.push('date >= ?'); args.push(from); }
  if (to) { where.push('date <= ?'); args.push(to); }

  // Keyset pagination: "strictly after the last row I sent you". The id is the
  // tiebreaker, because several entries share one date.
  if (cursor) {
    where.push('(date < ? OR (date = ? AND id < ?))');
    args.push(cursor.date, cursor.date, cursor.id);
  }

  // Ask for one more than requested - if it comes back, there is another page.
  args.push(limit + 1);

  const res = await env.DB.prepare(
    'SELECT * FROM entries WHERE ' + where.join(' AND ') +
    ' ORDER BY date DESC, id DESC LIMIT ?'
  ).bind(...args).all();

  const rows = res.results || [];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return ctx.json({
    entries: page.map(toApi),
    next_cursor: hasMore ? encodeCursor(page[page.length - 1]) : null
  });
}

/* The cursor is deliberately opaque: base64 so nobody builds a client that
   parses it, which would freeze the sort order as a public contract. */
function encodeCursor(row) {
  return b64urlEncode(row.date + '|' + row.id);
}

function decodeCursor(s) {
  try {
    const text = b64urlDecode(String(s));
    const i = text.indexOf('|');
    if (i < 1) return null;
    const date = text.slice(0, i);
    const id = text.slice(i + 1);
    if (!isValidDate(date) || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
    return { date: date, id: id };
  } catch (e) {
    return null;
  }
}

function b64urlEncode(s) {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s) {
  let t = s.replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  return atob(t);
}

/* ============================ validation ============================ */

/* Everything arriving from the network is hostile until proven otherwise -
   including requests from your own app, which can be replayed or edited. */
function validateEntry(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) {
    return { error: 'body must be a JSON object' };
  }

  if (typeof b.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.date)) {
    return { field: 'date', error: "must be 'YYYY-MM-DD'" };
  }
  if (!isRealDate(b.date)) {
    return { field: 'date', error: 'not a real calendar date' };
  }

  if (!Number.isInteger(b.amount_cents)) {
    return { field: 'amount_cents', error: 'must be a whole number of cents' };
  }
  if (b.amount_cents <= 0) {
    return { field: 'amount_cents', error: 'must be greater than zero' };
  }
  if (b.amount_cents > 100000000) {           // $1,000,000
    return { field: 'amount_cents', error: 'unreasonably large' };
  }

  const category = typeof b.category === 'string' ? b.category.trim() : '';
  if (!category) return { field: 'category', error: 'required' };
  if (category.length > 40) return { field: 'category', error: 'max 40 characters' };

  // Accept the old field name too, so a phone running a cached older build
  // keeps working until its service worker picks up the new one.
  var itemRaw = typeof b.item === 'string' ? b.item : (typeof b.note === 'string' ? b.note : '');
  const item = itemRaw.trim();
  if (!item) return { field: 'item', error: 'required' };
  if (item.length > 100) return { field: 'item', error: 'max 100 characters' };

  const merchant = typeof b.merchant === 'string' ? b.merchant.trim() : '';
  if (merchant.length > 60) return { field: 'merchant', error: 'max 60 characters' };

  const id = typeof b.id === 'string' ? b.id.trim() : '';
  if (id && !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    return { field: 'id', error: 'must be 1-64 chars of A-Z a-z 0-9 _ -' };
  }

  return { value: { id: id, date: b.date, amount_cents: b.amount_cents, category: category, item: item, merchant: merchant } };
}

// Right shape AND a day that exists.
function isValidDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && isRealDate(s);
}

// '2026-02-30' matches the regex but is not a day that exists.
function isRealDate(s) {
  const parts = s.split('-').map(Number);
  const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  return d.getUTCFullYear() === parts[0] &&
         d.getUTCMonth() === parts[1] - 1 &&
         d.getUTCDate() === parts[2];
}

/* ============================ helpers ============================ */

function toApi(row) {
  if (!row) return null;
  return {
    id: row.id,
    date: row.date,
    amount_cents: row.amount_cents,
    category: row.category,
    item: row.item,
    merchant: row.merchant,
    subscription_id: row.subscription_id || null,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}
