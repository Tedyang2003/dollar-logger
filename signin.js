/* Sign-in and session handling.
 *
 * Google proves who you are once. We immediately trade that for a session this
 * app's own server signed, good for 30 days, and keep the Google token no
 * longer than the exchange takes.
 *
 * The session is kept in localStorage. An httpOnly cookie would be better in
 * principle, but the page and the API are on different origins, so that cookie
 * would be third-party - blocked outright by Safari. A cookie that silently
 * fails on the one device this app is for is worse than a storage key that
 * works everywhere.
 */

window.DollarAuth = (function () {
  'use strict';

  var SESSION_KEY = 'dollarLogger.session';
  var session = null;      // {token, expires_at, email}
  var listeners = [];
  var started = false;
  var busy = false;

  function clientId() {
    return ((window.DOLLAR_CONFIG && window.DOLLAR_CONFIG.GOOGLE_CLIENT_ID) || '').trim();
  }

  function apiBase() {
    var u = (window.DOLLAR_CONFIG && window.DOLLAR_CONFIG.API_BASE_URL) || '';
    return String(u).trim().replace(/\/+$/, '');
  }

  function configured() { return !!clientId() && !!apiBase(); }

  function gisReady() {
    return !!(window.google && window.google.accounts && window.google.accounts.id);
  }

  /* ---------------- session storage ---------------- */

  function loadSession() {
    try {
      var raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      if (!s || typeof s.token !== 'string' || typeof s.expires_at !== 'number') return null;
      return s;
    } catch (e) {
      return null;
    }
  }

  function storeSession(s) {
    session = s;
    try {
      if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      else localStorage.removeItem(SESSION_KEY);
    } catch (e) { /* private mode - session lasts this tab only */ }
    notify();
  }

  // A minute of headroom so a request cannot expire in flight.
  function valid() {
    return !!session && (session.expires_at * 1000) > (Date.now() + 60000);
  }

  function notify() {
    var state = {
      signedIn: valid(),
      email: session && session.email || null,
      configured: configured(),
      busy: busy
    };
    listeners.forEach(function (fn) {
      try { fn(state); } catch (e) { /* a broken listener must not break sign-in */ }
    });
  }

  /* ---------------- the exchange ---------------- */

  function onCredential(response) {
    if (!response || !response.credential) return;

    busy = true;
    notify();

    // The Google token exists only for this request and is never stored.
    fetch(apiBase() + '/session', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + response.credential }
    }).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) throw new Error((body && body.error) || 'sign_in_failed');
        return body;
      });
    }).then(function (body) {
      busy = false;
      storeSession({
        token: body.token,
        expires_at: body.expires_at,
        email: body.user && body.user.email || null
      });
      if (window.DollarApi) window.DollarApi.syncNow();
    }).catch(function (err) {
      busy = false;
      notify();
      var msg = String(err && err.message);
      // 'not_allowed' comes from the server's email allowlist.
      broadcastError(msg === 'unauthorized' ? 'That account is not allowed to sign in.'
                                            : 'Could not sign in. Check your connection.');
    });
  }

  var errorHandlers = [];
  function broadcastError(msg) {
    errorHandlers.forEach(function (fn) { try { fn(msg); } catch (e) {} });
  }

  /* ---------------- Google button ---------------- */

  function start() {
    if (started || !configured() || !gisReady()) return;
    started = true;

    window.google.accounts.id.initialize({
      client_id: clientId(),
      callback: onCredential,
      cancel_on_tap_outside: false
    });

    renderButtons();
    notify();
  }

  function renderButtons() {
    if (!gisReady()) return;
    ['googleBtn', 'googleBtnGate'].forEach(function (id) {
      var host = document.getElementById(id);
      if (!host) return;
      host.innerHTML = '';
      window.google.accounts.id.renderButton(host, {
        theme: 'filled_blue', size: 'large', shape: 'pill',
        text: 'continue_with', width: 260
      });
    });
  }

  return {
    isConfigured: configured,
    isSignedIn: valid,
    getEmail: function () { return session && session.email || null; },
    getToken: function () { return valid() ? session.token : null; },

    onChange: function (fn) { listeners.push(fn); if (started) notify(); },
    onError: function (fn) { errorHandlers.push(fn); },

    /* Called by api.js when the server rejects our session: it is gone, so
       stop pretending we are signed in and put the sign-in screen back. */
    invalidate: function () {
      if (!session) return;
      storeSession(null);
      broadcastError('Session expired. Please sign in again.');
    },

    init: function () {
      session = loadSession();
      notify();

      if (!configured()) return;

      if (gisReady()) start();
      else {
        var tries = 0;
        var timer = setInterval(function () {
          if (gisReady()) { clearInterval(timer); start(); }
          else if (++tries > 40) { clearInterval(timer); notify(); }   // ~10s
        }, 250);
      }
    },

    signOut: function () {
      var token = session && session.token;

      // Tell the server first so every other device is signed out too. Local
      // state is cleared either way - a failed request must not trap you here.
      if (token) {
        fetch(apiBase() + '/session', {
          method: 'DELETE',
          headers: { Authorization: 'Bearer ' + token }
        }).catch(function () { /* best effort */ });
      }

      storeSession(null);
      try {
        if (gisReady()) window.google.accounts.id.disableAutoSelect();
      } catch (e) { /* best effort */ }
      renderButtons();
    }
  };
})();
