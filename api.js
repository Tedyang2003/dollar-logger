/* Dollar Logger <-> API sync.
 *
 * The phone stays the source of truth for the UI: every entry is written to
 * localStorage first and rendered from there, so logging works instantly and
 * offline. This module reconciles that local state with the server afterwards.
 *
 * Strategy is pull-then-diff. We fetch what the server has, merge it in, then
 * push whatever it is missing. That needs no "synced yet?" flag on each entry -
 * the server's own list of ids is the record - so there is no local bookkeeping
 * to drift out of step.
 */

window.DollarApi = (function () {
  'use strict';

  var DEBOUNCE_MS = 2000;
  var PAGE_LIMIT = 200;

  var api = null;          // {getState, mergeRemote, onStatus}
  var pending = null;
  var syncing = false;
  var queued = false;

  function baseUrl() {
    var u = (window.DOLLAR_CONFIG && window.DOLLAR_CONFIG.API_BASE_URL) || '';
    return String(u).trim().replace(/\/+$/, '');
  }

  function configured() { return !!baseUrl(); }

  function status(state, detail) {
    if (api && api.onStatus) api.onStatus({ state: state, detail: detail || '', linked: configured() });
  }

  function hhmm() {
    var d = new Date();
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  /* ---------------- shape conversion ----------------
     The app works in dollars, the API in whole cents. Convert once, here, at
     the boundary - never halfway through the app. */

  function toApi(entry) {
    return {
      id: entry.id,
      date: entry.date,
      amount_cents: Math.round(entry.amount * 100),
      category: entry.category || 'Other',
      note: entry.note || ''
    };
  }

  function fromApi(row) {
    return {
      id: row.id,
      date: row.date,
      amount: row.amount_cents / 100,
      category: row.category || 'Other',
      note: row.note || '',
      created: row.created_at || ''
    };
  }

  /* ---------------- HTTP ---------------- */

  function request(path, opts) {
    opts = opts || {};

    // Every request carries the Google ID token. The server verifies it and
    // derives the user from it - we never tell the server who we are.
    var token = window.DollarAuth && window.DollarAuth.getToken();
    if (!token) return Promise.reject(new Error('not_signed_in'));

    opts.headers = opts.headers || {};
    opts.headers.Authorization = 'Bearer ' + token;

    return fetch(baseUrl() + path, opts).then(function (res) {
      return res.text().then(function (text) {
        var body = null;
        try { body = text ? JSON.parse(text) : null; } catch (e) { /* non-JSON error page */ }
        if (!res.ok) {
          var err = new Error((body && body.error) || ('http_' + res.status));
          err.status = res.status;
          err.body = body;
          throw err;
        }
        return body;
      });
    });
  }

  // Walks every page rather than trusting one request to return everything.
  function fetchAll() {
    var all = [];
    function page(cursor) {
      var q = '?limit=' + PAGE_LIMIT + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
      return request('/entries' + q).then(function (body) {
        (body.entries || []).forEach(function (r) { all.push(r); });
        if (body.next_cursor) return page(body.next_cursor);
        return all;
      });
    }
    return page(null);
  }

  /* ---------------- sync ---------------- */

  function describeError(err) {
    if (!err) return 'Sync failed';
    if (err.message === 'not_signed_in') return 'Sign in to sync';
    if (err.status === 401) return 'Session expired - sign in again';
    if (err.status === 0 || err.message === 'Failed to fetch') return 'Server unreachable';
    if (err.status === 400) return 'Server rejected an entry';
    if (err.status >= 500) return 'Server error';
    return err.message || 'Sync failed';
  }

  function runSync() {
    if (!configured()) { status('off', 'API not set up'); return Promise.resolve(false); }
    if (!(window.DollarAuth && window.DollarAuth.isSignedIn())) {
      status('idle', 'Sign in to sync');
      return Promise.resolve(false);
    }
    if (syncing) { queued = true; return Promise.resolve(false); }

    syncing = true;
    status('syncing');

    var serverIds = {};

    return fetchAll()
      .then(function (rows) {
        rows.forEach(function (r) { serverIds[r.id] = true; });

        // Reuse the merge the app already has: union by id, local tombstones win.
        api.mergeRemote({ entries: rows.map(fromApi) });

        var state = api.getState();

        var toPush = state.entries.filter(function (e) { return !serverIds[e.id]; });
        var toDelete = (state.deleted || []).filter(function (t) { return serverIds[t.id]; });

        return sequence(toPush.map(function (e) {
          return function () { return request('/entries', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(toApi(e))
          }); };
        }).concat(toDelete.map(function (t) {
          return function () { return request('/entries/' + encodeURIComponent(t.id), { method: 'DELETE' }); };
        }))).then(function () {
          return { pushed: toPush.length, removed: toDelete.length, pulled: rows.length };
        });
      })
      .then(function (counts) {
        status('ok', 'Synced ' + hhmm());
        return counts;
      })
      .catch(function (err) {
        status('error', describeError(err));
        return false;
      })
      .then(function (result) {
        syncing = false;
        if (queued) { queued = false; schedule(); }
        return result;
      });
  }

  // One request at a time. A burst of parallel writes to a free-tier database
  // is a good way to find its rate limit.
  function sequence(tasks) {
    return tasks.reduce(function (chain, task) {
      return chain.then(task);
    }, Promise.resolve());
  }

  function schedule() {
    if (!configured()) return;
    clearTimeout(pending);
    status('pending');
    pending = setTimeout(runSync, DEBOUNCE_MS);
  }

  /* ---------------- public ---------------- */

  return {
    isConfigured: configured,

    init: function (adapter) {
      api = adapter;
      if (!configured()) { status('off', 'API not set up'); return; }

      status('idle', 'Ready');
      if (navigator.onLine !== false) runSync();   // no-op until signed in

      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) schedule();
      });
      window.addEventListener('online', schedule);
    },

    syncNow: runSync,
    scheduleSync: schedule
  };
})();
