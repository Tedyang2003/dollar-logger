/* Subscriptions: recurring purchases the server logs on a schedule. */

const INTERVALS = ['weekly', 'monthly', 'yearly'];
const MAX_PER_RUN = 400;   // a long-dormant subscription catches up in chunks

/* ---------------- date maths (pure, tested) ---------------- */

function parts(key) {
  const [y, m, d] = key.split('-').map(Number);
  return { y, m, d };
}

function key(y, m, d) {
  return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

function daysIn(y, m) {                     // m is 1-based
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/* The n-th occurrence (0 = the anchor itself). Counted from the anchor every
   time, never from the previous occurrence: chaining would turn a 31st into a
   28th after February and leave it there forever. */
export function occurrence(anchor, interval, n) {
  const a = parts(anchor);
  if (interval === 'weekly') {
    const t = new Date(Date.UTC(a.y, a.m - 1, a.d + 7 * n));
    return key(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  }
  if (interval === 'monthly') {
    const total = (a.m - 1) + n;
    const y = a.y + Math.floor(total / 12);
    const m = (total % 12) + 1;
    return key(y, m, Math.min(a.d, daysIn(y, m)));
  }
  // yearly: 29 Feb falls back to 28 Feb in non-leap years
  const y = a.y + n;
  return key(y, a.m, Math.min(a.d, daysIn(y, a.m)));
}

/* Today's date in the subscriber's own time zone. The Worker runs on UTC; a
   Singapore user's "1st of the month" starts 8 hours before UTC's. */
export function localToday(tz, now = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(now);                        // en-CA formats as YYYY-MM-DD
  } catch (e) {
    return now.toISOString().slice(0, 10);
  }
}

/* ---------------- the scheduled job ---------------- */

export async function generateDue(env, now = new Date()) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM subscriptions WHERE cancelled_at IS NULL'
  ).all();

  let created = 0;

  for (const s of results || []) {
    const today = localToday(s.tz, now);
    let n = s.generated;
    let budget = MAX_PER_RUN;

    while (budget-- > 0) {
      const date = occurrence(s.anchor_date, s.interval, n);
      if (date > today) break;

      /* Deterministic id: the same subscription on the same date is always the
         same row. A re-run inserts nothing, and a charge the user deleted keeps
         its soft-deleted row, so it is never recreated. */
      const res = await env.DB.prepare(
        `INSERT INTO entries (id, user_id, date, amount_cents, category, item, merchant, subscription_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`
      ).bind('sub-' + s.id + '-' + date, s.user_id, date, s.amount_cents,
             s.category, s.item, s.merchant, s.id).run();

      if (res.meta.changes > 0) created++;
      n++;
    }

    if (n !== s.generated) {
      await env.DB.prepare('UPDATE subscriptions SET generated = ? WHERE id = ?')
        .bind(n, s.id).run();
    }
  }
  return created;
}

/* ---------------- HTTP ---------------- */

function validate(b) {
  if (!b || typeof b !== 'object') return { error: 'body must be an object' };
  const item = typeof b.item === 'string' ? b.item.trim() : '';
  if (!item || item.length > 100) return { field: 'item', error: 'required, max 100' };
  const merchant = typeof b.merchant === 'string' ? b.merchant.trim().slice(0, 60) : '';
  const category = typeof b.category === 'string' ? b.category.trim() : '';
  if (!category || category.length > 40) return { field: 'category', error: 'required' };
  if (!Number.isInteger(b.amount_cents) || b.amount_cents <= 0 || b.amount_cents > 100000000) {
    return { field: 'amount_cents', error: 'whole cents, > 0' };
  }
  if (INTERVALS.indexOf(b.interval) === -1) return { field: 'interval', error: 'weekly, monthly or yearly' };
  if (typeof b.anchor_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.anchor_date)) {
    return { field: 'anchor_date', error: "must be 'YYYY-MM-DD'" };
  }
  const p = parts(b.anchor_date);
  if (p.m < 1 || p.m > 12 || p.d < 1 || p.d > daysIn(p.y, p.m)) return { field: 'anchor_date', error: 'not a real date' };
  let tz = typeof b.tz === 'string' ? b.tz : 'UTC';
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch (e) { tz = 'UTC'; }
  return { value: { item, merchant, category, amount_cents: b.amount_cents, interval: b.interval, anchor_date: b.anchor_date, tz } };
}

export async function createSubscription(request, env, ctx, user) {
  let body;
  try { body = await request.json(); } catch (e) { return ctx.json({ error: 'invalid_json' }, 400); }
  const v = validate(body);
  if (v.error) return ctx.json({ error: 'invalid_subscription', field: v.field, detail: v.error }, 400);

  const s = v.value;
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 20);

  await env.DB.prepare('INSERT OR IGNORE INTO users (id, email) VALUES (?, ?)').bind(user.sub, user.email).run();
  await env.DB.prepare(
    `INSERT INTO subscriptions (id, user_id, item, merchant, category, amount_cents, interval, anchor_date, tz)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, user.sub, s.item, s.merchant, s.category, s.amount_cents, s.interval, s.anchor_date, s.tz).run();

  // Log anything already due (including a start date of today) straight away,
  // rather than making the user wait for the next hourly run.
  await generateDue(env);

  return ctx.json({ subscription: { id, ...s } }, 201);
}

export async function listSubscriptions(env, ctx, user) {
  const { results } = await env.DB.prepare(
    `SELECT id, item, merchant, category, amount_cents, interval, anchor_date, generated
       FROM subscriptions WHERE user_id = ? AND cancelled_at IS NULL ORDER BY created_at`
  ).bind(user.sub).all();
  return ctx.json({
    subscriptions: (results || []).map(s => ({ ...s, next_date: occurrence(s.anchor_date, s.interval, s.generated) }))
  });
}

export async function cancelSubscription(id, env, ctx, user) {
  // Stops future charges; entries already logged stay, because they happened.
  const res = await env.DB.prepare(
    `UPDATE subscriptions SET cancelled_at = datetime('now')
      WHERE id = ? AND user_id = ? AND cancelled_at IS NULL`
  ).bind(id, user.sub).run();
  if (res.meta.changes === 0) return ctx.json({ error: 'not_found' }, 404);
  return ctx.json({ cancelled: true, id });
}
