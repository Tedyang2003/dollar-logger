/* Server-side budget: settings, rollover, and the 80% alert. */

import { localToday } from './subs.js';
import { notifyUser } from './push.js';

const ALERT_SHARE = 0.8;

function prevMonth(ym) {
  let [y, m] = ym.split('-').map(Number);
  m -= 1;
  if (m === 0) { m = 12; y -= 1; }
  return y + '-' + String(m).padStart(2, '0');
}

async function spentIn(env, userId, ym) {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) AS c FROM entries
      WHERE user_id = ? AND deleted_at IS NULL AND date LIKE ?`
  ).bind(userId, ym + '-%').first();
  return row ? row.c : 0;
}

async function settingsFor(env, userId) {
  return await env.DB.prepare('SELECT * FROM user_settings WHERE user_id = ?').bind(userId).first();
}

/* One month of rollover, both directions: last month's leftover is added,
   last month's overspend is taken off. Nothing carries from before the budget
   existed - spending in a month you had no budget is not "under budget". */
export function effectiveBudget(baseCents, rollover, budgetSince, month, prevSpentCents) {
  const prev = prevMonth(month);
  const carry = rollover && budgetSince && budgetSince <= prev ? baseCents - prevSpentCents : 0;
  return { effective: baseCents + carry, carry };
}

export async function budgetFor(env, userId, month) {
  const s = await settingsFor(env, userId);
  if (!s || !s.budget_cents) return null;
  const prevSpent = s.rollover ? await spentIn(env, userId, prevMonth(month)) : 0;
  const { effective, carry } = effectiveBudget(s.budget_cents, !!s.rollover, s.budget_since, month, prevSpent);
  return { base: s.budget_cents, carry, effective, rollover: !!s.rollover, tz: s.tz };
}

/* Called after anything adds spending. Fires at most once per month. */
export async function checkBudgetAlert(env, userId) {
  const s = await settingsFor(env, userId);
  if (!s || !s.budget_cents) return false;

  const month = localToday(s.tz).slice(0, 7);
  const b = await budgetFor(env, userId, month);
  const spent = await spentIn(env, userId, month);

  if (b.effective > 0 && spent < b.effective * ALERT_SHARE) return false;

  // Claim the alert first: INSERT OR IGNORE is atomic, so two purchases landing
  // at once cannot both send it.
  const claim = await env.DB.prepare(
    'INSERT OR IGNORE INTO alerts_sent (user_id, month, kind) VALUES (?, ?, ?)'
  ).bind(userId, month, 'budget80').run();
  if (claim.meta.changes === 0) return false;

  const pct = b.effective > 0 ? Math.round(spent / b.effective * 100) : 100;
  const left = b.effective - spent;
  await notifyUser(env, userId, {
    title: 'Budget ' + pct + '% used',
    body: left > 0
      ? '$' + (left / 100).toFixed(2) + ' left for the rest of the month.'
      : 'You have used your budget for this month.',
    url: './'
  });
  return true;
}

/* ---------------- HTTP ---------------- */

export async function getSettings(env, ctx, user) {
  const s = await settingsFor(env, user.sub);
  const month = localToday(s ? s.tz : 'UTC').slice(0, 7);
  const b = s ? await budgetFor(env, user.sub, month) : null;
  return ctx.json({
    budget_cents: s ? s.budget_cents : 0,
    rollover: s ? !!s.rollover : false,
    budget_since: s ? s.budget_since : null,
    current: b ? { month, carry_cents: b.carry, effective_cents: b.effective } : null,
    vapid_public_key: env.VAPID_PUBLIC_KEY || null
  });
}

export async function putSettings(request, env, ctx, user) {
  let b;
  try { b = await request.json(); } catch (e) { return ctx.json({ error: 'invalid_json' }, 400); }

  const budget = b.budget_cents;
  if (!Number.isInteger(budget) || budget < 0 || budget > 100000000) {
    return ctx.json({ error: 'invalid_settings', field: 'budget_cents' }, 400);
  }
  let tz = typeof b.tz === 'string' ? b.tz : 'UTC';
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch (e) { tz = 'UTC'; }
  const month = localToday(tz).slice(0, 7);

  await env.DB.prepare('INSERT OR IGNORE INTO users (id, email) VALUES (?, ?)').bind(user.sub, user.email).run();
  await env.DB.prepare(
    `INSERT INTO user_settings (user_id, budget_cents, rollover, budget_since, tz, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
       budget_cents = excluded.budget_cents,
       rollover = excluded.rollover,
       tz = excluded.tz,
       -- keep the original start month; clear it if the budget is removed
       budget_since = CASE WHEN excluded.budget_cents = 0 THEN NULL
                           ELSE COALESCE(user_settings.budget_since, excluded.budget_since) END,
       updated_at = datetime('now')`
  ).bind(user.sub, budget, b.rollover ? 1 : 0, budget ? month : null, tz).run();

  // A budget lowered below what is already spent should alert now, not on the next purchase.
  await checkBudgetAlert(env, user.sub);
  return getSettings(env, ctx, user);
}

export async function subscribePush(request, env, ctx, user) {
  let b;
  try { b = await request.json(); } catch (e) { return ctx.json({ error: 'invalid_json' }, 400); }
  const endpoint = b && b.endpoint;
  const keys = b && b.keys || {};
  // Only real push services - never let a client make the server POST to an arbitrary URL.
  if (typeof endpoint !== 'string' || !/^https:\/\/([a-z0-9-]+\.)*(push\.apple\.com|fcm\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com)\//i.test(endpoint)) {
    return ctx.json({ error: 'invalid_endpoint' }, 400);
  }
  if (typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') {
    return ctx.json({ error: 'invalid_keys' }, 400);
  }
  await env.DB.prepare(
    `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth) VALUES (?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`
  ).bind(endpoint, user.sub, keys.p256dh, keys.auth).run();
  return ctx.json({ subscribed: true }, 201);
}

export async function unsubscribePush(request, env, ctx, user) {
  let b = {};
  try { b = await request.json(); } catch (e) {}
  await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').bind(b.endpoint || '', user.sub).run();
  return ctx.json({ subscribed: false });
}

export async function testPush(env, ctx, user) {
  const n = await notifyUser(env, user.sub, { title: 'Dollar Logger', body: 'Notifications are working.', url: './' });
  return ctx.json({ sent: n });
}
