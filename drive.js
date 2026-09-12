/* Google Drive sync for Dollar Logger.
 *
 * Scope is drive.file, which means this app can only ever see the one file it
 * created itself. It cannot read anything else in your Drive, and Google does
 * not require app verification for that scope.
 *
 * Auth uses Google Identity Services. Access tokens last about an hour and are
 * held in memory only - never written to localStorage, where any script on the
 * page could read them. On reload we try a silent refresh; if the browser
 * blocks it (Safari often will) the UI asks you to reconnect.
 */

window.DollarDrive = (function () {
  'use strict';

  var FILE_NAME = 'dollar-logger.json';
  var SCOPE = 'https://www.googleapis.com/auth/drive.file';
  var FILE_ID_KEY = 'dollarLogger.driveFileId';
  var LINKED_KEY = 'dollarLogger.driveLinked';
  var DEBOUNCE_MS = 2000;

  var api = null;          // {getState, mergeRemote, onStatus}
  var tokenClient = null;
  var accessToken = null;
  var tokenExpiresAt = 0;
  var pending = null;      // debounce timer
  var syncing = false;
  var queuedWhileSyncing = false;
  var lastError = '';

  /* ---------------- small helpers ---------------- */

  function clientId() {
    return (window.DOLLAR_CONFIG && window.DOLLAR_CONFIG.GOOGLE_CLIENT_ID || '').trim();
  }

  function configured() { return !!clientId(); }

  function gisReady() {
    return !!(window.google && window.google.accounts && window.google.accounts.oauth2);
  }

  function linked() {
    try { return localStorage.getItem(LINKED_KEY) === '1'; } catch (e) { return false; }
  }

  function setLinked(v) {
    try {
      if (v) localStorage.setItem(LINKED_KEY, '1');
      else localStorage.removeItem(LINKED_KEY);
    } catch (e) { /* private mode */ }
  }

  function fileId() {
    try { return localStorage.getItem(FILE_ID_KEY) || ''; } catch (e) { return ''; }
  }

  function setFileId(id) {
    try {
      if (id) localStorage.setItem(FILE_ID_KEY, id);
      else localStorage.removeItem(FILE_ID_KEY);
    } catch (e) { /* private mode */ }
  }

  function tokenValid() {
    return !!accessToken && Date.now() < tokenExpiresAt - 60000; // 1 min of headroom
  }

  function status(state, detail) {
    if (api && api.onStatus) api.onStatus({ state: state, detail: detail || '', linked: linked() });
  }

  function hhmm() {
    var d = new Date();
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }

  /* ---------------- auth ---------------- */

  function makeTokenClient() {
    if (tokenClient || !gisReady() || !configured()) return tokenClient;
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId(),
      scope: SCOPE,
      callback: function () { /* replaced per request */ }
    });
    return tokenClient;
  }

  // interactive=true opens the Google popup, so it MUST be called straight from
  // a click - Safari blocks popups that are not tied to a user gesture.
  function getToken(interactive) {
    return new Promise(function (resolve, reject) {
      if (tokenValid()) { resolve(accessToken); return; }
      if (!configured()) { reject(new Error('not-configured')); return; }
      if (!gisReady()) { reject(new Error('gis-unavailable')); return; }

      var client = makeTokenClient();
      if (!client) { reject(new Error('gis-unavailable')); return; }

      var settled = false;
      var timer = setTimeout(function () {
        if (!settled) { settled = true; reject(new Error('auth-timeout')); }
      }, interactive ? 120000 : 12000);

      client.callback = function (res) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (res && res.access_token) {
          accessToken = res.access_token;
          tokenExpiresAt = Date.now() + (Number(res.expires_in || 3600) * 1000);
          setLinked(true);
          resolve(accessToken);
        } else {
          reject(new Error((res && res.error) || 'auth-failed'));
        }
      };
      client.error_callback = function (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error((err && err.type) || 'auth-failed'));
      };

      try {
        client.requestAccessToken({ prompt: interactive ? 'consent' : '' });
      } catch (e) {
        if (!settled) { settled = true; clearTimeout(timer); reject(e); }
      }
    });
  }

  /* ---------------- Drive REST ---------------- */

  function authFetch(url, opts) {
    opts = opts || {};
    opts.headers = opts.headers || {};
    opts.headers.Authorization = 'Bearer ' + accessToken;
    return fetch(url, opts).then(function (res) {
      if (res.status === 401 || res.status === 403) {
        accessToken = null;            // force a fresh token next time
        tokenExpiresAt = 0;
        throw new Error('auth-expired');
      }
      if (!res.ok) throw new Error('drive-http-' + res.status);
      return res;
    });
  }

  // Under drive.file this only ever matches our own file.
  function findFile() {
    var q = encodeURIComponent("name='" + FILE_NAME + "' and trashed=false");
    return authFetch('https://www.googleapis.com/drive/v3/files?q=' + q +
                     '&spaces=drive&fields=files(id,modifiedTime)&pageSize=1')
      .then(function (r) { return r.json(); })
      .then(function (j) { return (j.files && j.files[0] && j.files[0].id) || ''; });
  }

  function createFile(state) {
    var boundary = 'dlbound' + Date.now();
    var meta = { name: FILE_NAME, mimeType: 'application/json' };
    var body =
      '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(meta) + '\r\n' +
      '--' + boundary + '\r\nContent-Type: application/json\r\n\r\n' +
      JSON.stringify(state) + '\r\n' +
      '--' + boundary + '--';

    return authFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/related; boundary=' + boundary },
      body: body
    }).then(function (r) { return r.json(); })
      .then(function (j) { setFileId(j.id); return j.id; });
  }

  function downloadFile(id) {
    return authFetch('https://www.googleapis.com/drive/v3/files/' + id + '?alt=media')
      .then(function (r) { return r.text(); })
      .then(function (t) {
        try { return JSON.parse(t); } catch (e) { return null; }  // corrupt remote: treat as empty
      });
  }

  function uploadFile(id, state) {
    return authFetch('https://www.googleapis.com/upload/drive/v3/files/' + id + '?uploadType=media', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state)
    });
  }

  /* ---------------- sync ---------------- */

  function describeError(err) {
    var m = String(err && err.message || err);
    if (m === 'not-configured') return 'No Google client ID set yet';
    if (m === 'gis-unavailable') return 'Google sign-in unavailable (offline?)';
    if (m === 'auth-expired' || m === 'auth-failed' || m === 'auth-timeout') return 'Tap Reconnect';
    if (m.indexOf('drive-http-') === 0) return 'Drive error ' + m.slice(11);
    if (m === 'popup_closed' || m === 'popup_failed_to_open') return 'Sign-in window was closed';
    return 'Sync failed';
  }

  // Pull, merge, push. Merging (not overwriting) means a second device, or a
  // reinstall, adds to the history instead of clobbering it.
  function runSync(interactive) {
    if (!configured()) { status('off', 'Drive sync not set up'); return Promise.resolve(false); }

    if (syncing) { queuedWhileSyncing = true; return Promise.resolve(false); }
    syncing = true;
    status('syncing');

    return getToken(!!interactive)
      .then(function () {
        var id = fileId();
        return id ? id : findFile();
      })
      .then(function (id) {
        if (!id) return createFile(api.getState()).then(function () { return null; });
        setFileId(id);
        return downloadFile(id).then(function (remote) {
          if (remote) api.mergeRemote(remote);
          return uploadFile(id, api.getState());
        });
      })
      .then(function () {
        lastError = '';
        status('ok', 'Synced ' + hhmm());
        return true;
      })
      .catch(function (err) {
        lastError = describeError(err);
        // A stale file id (file deleted in Drive) should not wedge us forever.
        if (String(err.message).indexOf('drive-http-404') === 0) setFileId('');
        status('error', lastError);
        return false;
      })
      .then(function (ok) {
        syncing = false;
        if (queuedWhileSyncing) {
          queuedWhileSyncing = false;
          schedule();
        }
        return ok;
      });
  }

  function schedule() {
    if (!configured() || !linked()) return;
    clearTimeout(pending);
    status('pending');
    pending = setTimeout(function () { runSync(false); }, DEBOUNCE_MS);
  }

  /* ---------------- public ---------------- */

  return {
    isConfigured: configured,
    isLinked: linked,

    init: function (adapter) {
      api = adapter;

      if (!configured()) { status('off', 'Drive sync not set up'); return; }
      if (!linked()) { status('idle', 'Not connected'); return; }

      // Reconnect quietly on load, but only when we are actually online.
      var start = function () {
        if (navigator.onLine === false) { status('error', 'Offline'); return; }
        runSync(false);
      };
      if (gisReady()) start();
      else setTimeout(function () { gisReady() ? start() : status('error', 'Tap Reconnect'); }, 2500);

      // iOS gives no background time, so the next best moment is whenever the
      // app comes back to the foreground.
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden && linked()) schedule();
      });
      window.addEventListener('online', function () { if (linked()) schedule(); });
    },

    connect: function () {
      if (!configured()) { status('off', 'No Google client ID set yet'); return Promise.resolve(false); }
      return runSync(true);
    },

    disconnect: function () {
      if (accessToken && window.google && window.google.accounts &&
          window.google.accounts.oauth2 && window.google.accounts.oauth2.revoke) {
        try { window.google.accounts.oauth2.revoke(accessToken); } catch (e) { /* best effort */ }
      }
      accessToken = null;
      tokenExpiresAt = 0;
      clearTimeout(pending);
      setLinked(false);
      setFileId('');
      status('idle', 'Not connected');
    },

    syncNow: function () { return runSync(true); },
    scheduleSync: schedule
  };
})();
