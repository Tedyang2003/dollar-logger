/* Google sign-in for the browser.
 *
 * This gets an ID token and hands it to api.js. It deliberately does NOT
 * decide anything about permissions - the token means nothing until the
 * server verifies it. Everything read here (email, name) is for display only.
 *
 * The token is held in memory, never in localStorage. It expires in about an
 * hour anyway, and memory is not readable by anything that manages to inject
 * a script into the page later.
 */

window.DollarAuth = (function () {
  'use strict';

  var idToken = null;
  var expiresAt = 0;
  var profile = null;
  var listeners = [];
  var started = false;

  function clientId() {
    return ((window.DOLLAR_CONFIG && window.DOLLAR_CONFIG.GOOGLE_CLIENT_ID) || '').trim();
  }

  function configured() { return !!clientId(); }

  function gisReady() {
    return !!(window.google && window.google.accounts && window.google.accounts.id);
  }

  function notify() {
    var state = {
      signedIn: hasValidToken(),
      email: profile && profile.email || null,
      name: profile && profile.name || null,
      configured: configured()
    };
    listeners.forEach(function (fn) {
      try { fn(state); } catch (e) { /* a broken listener must not break sign-in */ }
    });
  }

  // Read-only peek for display. Never a security decision - the server does that.
  function readClaims(jwt) {
    try {
      var part = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      while (part.length % 4) part += '=';
      return JSON.parse(decodeURIComponent(escape(atob(part))));
    } catch (e) {
      return null;
    }
  }

  function hasValidToken() {
    // 2 minutes of headroom so a token does not expire mid-request.
    return !!idToken && Date.now() < expiresAt - 120000;
  }

  function onCredential(response) {
    if (!response || !response.credential) return;
    idToken = response.credential;

    var claims = readClaims(idToken);
    expiresAt = claims && claims.exp ? claims.exp * 1000 : Date.now() + 3600000;
    profile = claims ? { email: claims.email, name: claims.name } : null;

    notify();
    if (window.DollarApi) window.DollarApi.syncNow();
  }

  function start() {
    if (started || !configured() || !gisReady()) return;
    started = true;

    window.google.accounts.id.initialize({
      client_id: clientId(),
      callback: onCredential,
      // Re-issues a token without a tap if you are already signed in to Google
      // and have used this app before. On iOS Safari this often fails, which
      // is why the button below always stays available.
      auto_select: true,
      cancel_on_tap_outside: false
    });

    var host = document.getElementById('googleBtn');
    if (host) {
      window.google.accounts.id.renderButton(host, {
        theme: 'filled_blue', size: 'large', shape: 'pill',
        text: 'signin_with', width: 260
      });
    }

    // Attempt the silent path; the rendered button covers the failure case.
    try { window.google.accounts.id.prompt(); } catch (e) { /* not fatal */ }

    notify();
  }

  return {
    isConfigured: configured,
    isSignedIn: hasValidToken,
    getProfile: function () { return profile; },

    // api.js calls this before each request. Null means "ask the user to sign in".
    getToken: function () { return hasValidToken() ? idToken : null; },

    onChange: function (fn) { listeners.push(fn); },

    init: function () {
      if (!configured()) { notify(); return; }
      if (gisReady()) { start(); return; }
      // The GIS script is async, so wait for it rather than assuming it landed.
      var tries = 0;
      var timer = setInterval(function () {
        if (gisReady()) { clearInterval(timer); start(); }
        else if (++tries > 40) { clearInterval(timer); notify(); }   // ~10s
      }, 250);
    },

    signOut: function () {
      idToken = null;
      expiresAt = 0;
      profile = null;
      try {
        if (gisReady()) window.google.accounts.id.disableAutoSelect();
      } catch (e) { /* best effort */ }
      notify();
    }
  };
})();
