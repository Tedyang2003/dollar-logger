/* Dollar Logger - a local-first purchase log.
   Everything lives in this browser's localStorage. No server, no accounts. */

(function () {
  'use strict';

  var STORE_KEY = 'dollarLogger.v1';
  var DEFAULT_CATS = ['Food', 'Transport', 'Shopping', 'Bills', 'Fun', 'Health', 'Other'];

  var db = {
    entries: [],   // {id, date:'YYYY-MM-DD', amount:Number, category:String, note:String, created:ISO}
    deleted: [],   // tombstones {id, at} - without these, Drive would re-add deleted entries
    categories: DEFAULT_CATS.slice(),
    currency: '$'
  };

  var applyingRemote = false;   // suppresses the sync loop while merging Drive data

  var ui = {
    view: 'log',
    cat: null,     // selected category on the log form
    month: null,   // Date pinned to the 1st of the shown month
    year: null     // Number
  };

  /* ============================ storage ============================ */

  function load() {
    var raw;
    try { raw = localStorage.getItem(STORE_KEY); } catch (e) { raw = null; }
    if (!raw) return;
    try {
      var parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.entries)) db.entries = parsed.entries;
      if (parsed && Array.isArray(parsed.deleted)) db.deleted = parsed.deleted;
      if (parsed && Array.isArray(parsed.categories) && parsed.categories.length) db.categories = parsed.categories;
      if (parsed && typeof parsed.currency === 'string' && parsed.currency) db.currency = parsed.currency;
    } catch (e) {
      toast('Saved data looked corrupted and was skipped.');
    }
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(db));
    } catch (e) {
      toast('Could not save - device storage is full or blocked.');
    }
    // Push shortly after, unless this save IS the result of a pull.
    if (applyingRemote) return;
    if (window.DollarApi) window.DollarApi.scheduleSync();
    if (window.DollarDrive) window.DollarDrive.scheduleSync();
  }

  function tombstone(id) {
    db.deleted.push({ id: id, at: new Date().toISOString() });
    if (db.deleted.length > 1000) db.deleted = db.deleted.slice(-1000);
  }

  /* Merge a copy pulled from Drive into what is on this device.
     Union of entries by id, minus anything either side has deleted. Merging
     rather than overwriting means a reinstall or a second device adds to the
     history instead of wiping it. */
  function mergeRemote(remote) {
    if (!remote || !Array.isArray(remote.entries)) return false;

    applyingRemote = true;
    var changed = false;

    var tomb = {};
    db.deleted.forEach(function (t) { if (t && t.id) tomb[t.id] = t.at || ''; });
    (remote.deleted || []).forEach(function (t) {
      if (t && t.id && !Object.prototype.hasOwnProperty.call(tomb, t.id)) {
        tomb[t.id] = t.at || '';
        changed = true;
      }
    });

    var have = {};
    db.entries.forEach(function (e) { have[e.id] = true; });
    remote.entries.forEach(function (e) {
      if (!e || !e.id || !e.date || typeof e.amount !== 'number') return;
      if (have[e.id] || Object.prototype.hasOwnProperty.call(tomb, e.id)) return;
      db.entries.push(e);
      have[e.id] = true;
      changed = true;
    });

    var before = db.entries.length;
    db.entries = db.entries.filter(function (e) {
      return !Object.prototype.hasOwnProperty.call(tomb, e.id);
    });
    if (db.entries.length !== before) changed = true;

    db.deleted = Object.keys(tomb).map(function (id) { return { id: id, at: tomb[id] }; });

    (remote.categories || []).forEach(function (c) {
      if (typeof c === 'string' && db.categories.indexOf(c) === -1) {
        db.categories.push(c);
        changed = true;
      }
    });

    if (changed) save();
    applyingRemote = false;

    if (changed) { renderCatChips(); renderAll(); }
    return changed;
  }

  /* ============================ dates ============================ */
  // All dates are handled as local 'YYYY-MM-DD' strings. Never hand a plain
  // date string to new Date() - browsers read those as UTC and the day slips.

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function toKey(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function fromKey(key) {
    var p = String(key).split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }

  function todayKey() { return toKey(new Date()); }

  function shiftDayKey(days) {
    var d = new Date();
    d.setDate(d.getDate() - days);
    return toKey(d);
  }

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];
  var MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var DAYS3 = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function prettyDay(key) {
    if (key === todayKey()) return 'Today';
    if (key === shiftDayKey(1)) return 'Yesterday';
    var d = fromKey(key);
    return DAYS3[d.getDay()] + ' ' + d.getDate() + ' ' + MON3[d.getMonth()];
  }

  /* ============================ money ============================ */

  function money(n) {
    var sign = n < 0 ? '-' : '';
    var parts = Math.abs(n).toFixed(2).split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return sign + db.currency + parts.join('.');
  }

  function parseAmount(raw) {
    // Accept "12", "12.50", "1,299.99", "$4" and simple sums like "3+4.50".
    var s = String(raw).replace(/[^0-9.+\-]/g, '');
    if (!s) return NaN;
    var n;
    if (/^[0-9.]+(?:[+\-][0-9.]+)+$/.test(s)) {
      n = s.split(/(?=[+\-])/).reduce(function (total, term) {
        var v = parseFloat(term);
        return isNaN(v) ? total : total + v;
      }, 0);
    } else {
      n = parseFloat(s);
    }
    if (isNaN(n) || n <= 0) return NaN;
    // n * 100 can land at 100.4999... for 1.005, so settle the binary noise
    // with toFixed before rounding to cents.
    return Math.round(parseFloat((n * 100).toFixed(4))) / 100;
  }

  /* ============================ queries ============================ */

  function sorted() {
    return db.entries.slice().sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return (b.created || '') < (a.created || '') ? -1 : 1;
    });
  }

  function inMonth(y, m) {                 // m is 0-based
    var prefix = y + '-' + pad(m + 1) + '-';
    return db.entries.filter(function (e) { return e.date.indexOf(prefix) === 0; });
  }

  function inYear(y) {
    var prefix = y + '-';
    return db.entries.filter(function (e) { return e.date.indexOf(prefix) === 0; });
  }

  function sum(list) {
    return list.reduce(function (t, e) { return t + e.amount; }, 0);
  }

  function byCategory(list) {
    var map = {};
    list.forEach(function (e) {
      var c = e.category || 'Other';
      map[c] = (map[c] || 0) + e.amount;
    });
    return Object.keys(map).map(function (c) {
      return { category: c, total: map[c] };
    }).sort(function (a, b) { return b.total - a.total; });
  }

  /* ============================ DOM helpers ============================ */

  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.add('hidden'); }, 2400);
  }

  /* ============================ shared rendering ============================ */

  function entryNode(e) {
    var li = el('li', 'entry');

    var meta = el('div', 'meta');
    var top = el('div', 'top');
    top.appendChild(el('span', 'cat', e.category || 'Other'));
    if (e.note) top.appendChild(el('span', 'note', e.note));
    meta.appendChild(top);
    meta.appendChild(el('span', 'when', prettyDay(e.date)));

    var del = el('button', 'del', '×');
    del.type = 'button';
    del.setAttribute('aria-label', 'Delete entry');
    del.addEventListener('click', function () { removeEntry(e.id); });

    li.appendChild(meta);
    li.appendChild(el('span', 'amt', money(e.amount)));
    li.appendChild(del);
    return li;
  }

  function barRow(label, value, max, total) {
    var row = el('div', 'bar-row');

    var top = el('div', 'bar-top');
    top.appendChild(el('span', null, label));
    var right = el('span', null, money(value));
    if (total > 0) right.appendChild(el('span', 'pct', Math.round((value / total) * 100) + '%'));
    top.appendChild(right);

    var track = el('div', 'bar-track');
    var fill = el('div', 'bar-fill');
    fill.style.width = (max > 0 ? Math.max(2, (value / max) * 100) : 0) + '%';
    track.appendChild(fill);

    row.appendChild(top);
    row.appendChild(track);
    return row;
  }

  /* ============================ LOG view ============================ */

  function renderCatChips() {
    var wrap = $('catChips');
    wrap.innerHTML = '';
    if (ui.cat === null || db.categories.indexOf(ui.cat) === -1) ui.cat = db.categories[0];
    db.categories.forEach(function (c) {
      var b = el('button', 'chip' + (c === ui.cat ? ' on' : ''), c);
      b.type = 'button';
      b.addEventListener('click', function () { ui.cat = c; renderCatChips(); });
      wrap.appendChild(b);
    });
  }

  function renderLog() {
    $('curSign').textContent = db.currency;

    var today = db.entries.filter(function (e) { return e.date === todayKey(); });
    $('todayTotal').textContent = money(sum(today));

    var list = $('recentList');
    list.innerHTML = '';
    var recent = sorted().slice(0, 15);
    if (!recent.length) {
      list.appendChild(el('li', 'empty', 'No purchases logged yet. Add your first one above.'));
      return;
    }
    recent.forEach(function (e) { list.appendChild(entryNode(e)); });
  }

  function addEntry(ev) {
    ev.preventDefault();

    var amount = parseAmount($('amount').value);
    if (isNaN(amount)) { toast('Enter an amount greater than zero.'); $('amount').focus(); return; }

    var date = $('date').value || todayKey();

    db.entries.push({
      id: 'e' + Date.now() + Math.random().toString(36).slice(2, 7),
      date: date,
      amount: amount,
      category: ui.cat || 'Other',
      note: $('note').value.trim(),
      created: new Date().toISOString()
    });
    save();

    $('amount').value = '';
    $('note').value = '';
    renderAll();
    toast('Logged ' + money(amount) + ' · ' + prettyDay(date));
  }

  function removeEntry(id) {
    var e = db.entries.filter(function (x) { return x.id === id; })[0];
    if (!e) return;
    if (!confirm('Delete ' + money(e.amount) + ' (' + e.category + ', ' + prettyDay(e.date) + ')?')) return;
    db.entries = db.entries.filter(function (x) { return x.id !== id; });
    tombstone(id);
    save();
    renderAll();
    toast('Deleted.');
  }

  /* ============================ MONTH view ============================ */

  function renderMonth() {
    var y = ui.month.getFullYear(), m = ui.month.getMonth();
    $('monthLabel').textContent = MONTHS[m] + ' ' + y;

    var list = inMonth(y, m);
    var total = sum(list);
    $('monthTotal').textContent = money(total);

    var now = new Date();
    var isCurrent = (y === now.getFullYear() && m === now.getMonth());
    var daysElapsed = isCurrent ? now.getDate() : new Date(y, m + 1, 0).getDate();
    var perDay = daysElapsed > 0 ? total / daysElapsed : 0;
    $('monthSub').textContent = list.length
      ? list.length + ' purchase' + (list.length === 1 ? '' : 's') +
        ' · ' + money(perDay) + '/day' + (isCurrent ? ' so far' : '')
      : 'Nothing logged this month';

    var cats = $('monthCats');
    cats.innerHTML = '';
    var grouped = byCategory(list);
    if (!grouped.length) {
      cats.appendChild(el('div', 'empty', 'No spending to break down.'));
    } else {
      var max = grouped[0].total;
      grouped.forEach(function (g) { cats.appendChild(barRow(g.category, g.total, max, total)); });
    }

    var wrap = $('monthDays');
    wrap.innerHTML = '';
    if (!list.length) {
      wrap.appendChild(el('div', 'empty', 'No purchases this month.'));
      return;
    }

    var byDay = {};
    list.forEach(function (e) { (byDay[e.date] = byDay[e.date] || []).push(e); });

    Object.keys(byDay).sort().reverse().forEach(function (key) {
      var group = el('div', 'daygroup');

      var head = el('div', 'dayhead');
      head.appendChild(el('span', null, prettyDay(key)));
      head.appendChild(el('span', null, money(sum(byDay[key]))));
      group.appendChild(head);

      var ul = el('ul', 'entries');
      byDay[key].forEach(function (e) { ul.appendChild(entryNode(e)); });
      group.appendChild(ul);

      wrap.appendChild(group);
    });
  }

  /* ============================ YEAR view ============================ */

  function renderYear() {
    $('yearLabel').textContent = String(ui.year);

    var list = inYear(ui.year);
    var total = sum(list);
    $('yearTotal').textContent = money(total);

    var monthsWith = 0, totals = [];
    for (var m = 0; m < 12; m++) {
      var t = sum(inMonth(ui.year, m));
      totals.push(t);
      if (t > 0) monthsWith++;
    }
    $('yearSub').textContent = list.length
      ? list.length + ' purchase' + (list.length === 1 ? '' : 's') +
        ' · ' + money(monthsWith ? total / monthsWith : 0) + '/month average'
      : 'Nothing logged this year';

    var chart = $('yearChart');
    chart.innerHTML = '';
    var peak = Math.max.apply(null, totals.concat([0]));
    totals.forEach(function (t, i) {
      var col = el('div', 'ycol' + (t > 0 ? '' : ' dim'));
      col.title = MONTHS[i] + ': ' + money(t);

      var bar = el('div', 'ybar');
      bar.style.height = (peak > 0 ? Math.max(2, (t / peak) * 100) : 2) + '%';
      col.appendChild(bar);
      col.appendChild(el('div', 'ylab', MON3[i]));

      col.addEventListener('click', function () {
        ui.month = new Date(ui.year, i, 1);
        setView('month');
      });
      chart.appendChild(col);
    });

    var cats = $('yearCats');
    cats.innerHTML = '';
    var grouped = byCategory(list);
    if (!grouped.length) {
      cats.appendChild(el('div', 'empty', 'No spending to break down.'));
    } else {
      var max = grouped[0].total;
      grouped.forEach(function (g) { cats.appendChild(barRow(g.category, g.total, max, total)); });
    }
  }

  /* ============================ CSV and backup ============================ */

  function csvCell(v) {
    var s = String(v === undefined || v === null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCsv(list) {
    var rows = [['Date', 'Year', 'Month', 'Category', 'Amount', 'Note']];
    list.slice()
      .sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); })
      .forEach(function (e) {
        var d = fromKey(e.date);
        rows.push([e.date, d.getFullYear(), MONTHS[d.getMonth()],
                   e.category || 'Other', e.amount.toFixed(2), e.note || '']);
      });
    return rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n');
  }

  function download(filename, text, mime) {
    // BOM keeps Excel happy with UTF-8 currency symbols.
    var blob = new Blob(['﻿' + text], { type: (mime || 'text/csv') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  function exportCsv(list, name) {
    if (!list.length) { toast('Nothing to export for that period.'); return; }
    download(name, toCsv(list));
    toast('Exported ' + list.length + ' row' + (list.length === 1 ? '' : 's') + '.');
  }

  function restoreFromFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var parsed;
      try { parsed = JSON.parse(String(reader.result)); }
      catch (e) { toast('That file is not a valid backup.'); return; }
      if (!parsed || !Array.isArray(parsed.entries)) { toast('That file is not a valid backup.'); return; }

      var seen = {};
      db.entries.forEach(function (e) { seen[e.id] = true; });

      var added = 0;
      var restored = {};
      parsed.entries.forEach(function (e) {
        if (!e || !e.date || typeof e.amount !== 'number' || seen[e.id]) return;
        db.entries.push(e);
        seen[e.id] = true;
        restored[e.id] = true;
        added++;
      });

      // Restoring is an explicit "I want these back", so clear any tombstone
      // that would otherwise delete them again on the next Drive sync.
      if (added) {
        db.deleted = db.deleted.filter(function (t) { return !restored[t.id]; });
      }

      if (Array.isArray(parsed.categories)) {
        parsed.categories.forEach(function (c) {
          if (db.categories.indexOf(c) === -1) db.categories.push(c);
        });
      }

      save();
      renderAll();
      toast(added ? 'Restored ' + added + ' entr' + (added === 1 ? 'y' : 'ies') + '.' : 'Nothing new to restore.');
    };
    reader.readAsText(file);
  }

  /* ============================ DATA view ============================ */

  function renderData() {
    $('currency').value = db.currency;

    var ed = $('catEditor');
    ed.innerHTML = '';
    db.categories.forEach(function (c) {
      var b = el('button', 'chip', c);
      b.type = 'button';
      b.appendChild(el('span', 'x', '×'));
      b.addEventListener('click', function () {
        if (db.categories.length <= 1) { toast('Keep at least one category.'); return; }
        var used = db.entries.filter(function (e) { return e.category === c; }).length;
        var msg = used
          ? 'Remove "' + c + '"? ' + used + ' existing entr' + (used === 1 ? 'y keeps' : 'ies keep') + ' the label.'
          : 'Remove "' + c + '"?';
        if (!confirm(msg)) return;
        db.categories = db.categories.filter(function (other) { return other !== c; });
        save();
        renderCatChips();
        renderData();
      });
      ed.appendChild(b);
    });

    var n = db.entries.length;
    var line = n + ' entr' + (n === 1 ? 'y' : 'ies') + ' stored on this device';
    if (n) {
      var dates = db.entries.map(function (e) { return e.date; }).sort();
      line += ' · ' + dates[0] + ' to ' + dates[dates.length - 1];
    }
    $('statLine').textContent = line;
  }

  /* ============================ Drive sync UI ============================ */

  var syncState = { state: 'off', detail: '', linked: false };

  var SYNC_TEXT = {
    off: 'Drive sync not set up',
    idle: 'Not connected',
    pending: 'Saving to Drive...',
    syncing: 'Syncing...',
    ok: 'Synced',
    error: 'Sync problem'
  };

  function onSyncStatus(s) {
    syncState = s;

    var dot = $('syncDot');
    if (dot) {
      dot.className = 'sync-dot ' + s.state;
    }
    var label = $('driveStatus');
    if (label) label.textContent = s.detail || SYNC_TEXT[s.state] || '';

    // A quiet marker in the header so sync trouble is visible from any tab.
    var head = $('topbarRight');
    if (head) {
      if (s.state === 'error' && s.linked) { head.textContent = 'sync !'; head.style.color = ''; }
      else if (s.state === 'syncing' || s.state === 'pending') head.textContent = 'sync...';
      else head.textContent = '';
    }

    var connect = $('driveConnect');
    var sync = $('driveSyncNow');
    var disconnect = $('driveDisconnect');
    if (!connect || !sync || !disconnect) return;

    var configured = window.DollarDrive && window.DollarDrive.isConfigured();
    if (!configured) {
      connect.classList.remove('hidden');
      connect.textContent = 'Set up Drive sync';
      connect.disabled = true;
      sync.classList.add('hidden');
      disconnect.classList.add('hidden');
      return;
    }
    connect.disabled = false;

    if (s.linked) {
      connect.classList.toggle('hidden', s.state !== 'error');
      connect.textContent = 'Reconnect';
      sync.classList.remove('hidden');
      disconnect.classList.remove('hidden');
    } else {
      connect.classList.remove('hidden');
      connect.textContent = 'Connect Google Drive';
      sync.classList.add('hidden');
      disconnect.classList.add('hidden');
    }
  }

  function initAuth() {
    if (!window.DollarAuth) return;

    window.DollarAuth.onChange(function (s) {
      var dot = $('authDot');
      if (dot) dot.className = 'sync-dot ' + (s.signedIn ? 'ok' : (s.configured ? 'idle' : 'off'));

      var label = $('authStatus');
      if (label) {
        label.textContent = !s.configured ? 'Sign-in not set up'
          : s.signedIn ? ('Signed in as ' + (s.email || s.name || 'you'))
          : 'Not signed in';
      }

      var out = $('signOutBtn');
      if (out) out.classList.toggle('hidden', !s.signedIn);

      var help = $('authHelp');
      if (help && !s.configured) {
        help.textContent = 'Add GOOGLE_CLIENT_ID to config.js - see the README.';
      }
    });

    $('signOutBtn').addEventListener('click', function () {
      window.DollarAuth.signOut();
      toast('Signed out. Entries stay on this phone.');
    });

    window.DollarAuth.init();
  }

  function initApi() {
    if (!window.DollarApi) return;

    window.DollarApi.init({
      getState: function () { return db; },
      mergeRemote: mergeRemote,
      onStatus: function (s) {
        var dot = $('apiDot');
        if (dot) dot.className = 'sync-dot ' + s.state;
        var label = $('apiStatus');
        if (label) label.textContent = s.detail || SYNC_TEXT[s.state] || '';
      }
    });

    $('apiSyncNow').addEventListener('click', function () {
      if (!window.DollarApi.isConfigured()) {
        toast('Set API_BASE_URL in config.js first.');
        return;
      }
      window.DollarApi.syncNow().then(function (r) {
        toast(r ? 'Synced: ' + r.pushed + ' up, ' + r.pulled + ' down.' : 'Sync failed.');
      });
    });

    if (!window.DollarApi.isConfigured()) {
      var help = $('apiHelp');
      if (help) help.textContent = 'Not set up. Add API_BASE_URL to config.js.';
    }
  }

  function initDrive() {
    if (!window.DollarDrive) return;

    window.DollarDrive.init({
      getState: function () { return db; },
      mergeRemote: mergeRemote,
      onStatus: onSyncStatus
    });

    $('driveConnect').addEventListener('click', function () {
      if (!window.DollarDrive.isConfigured()) {
        toast('Add your Google client ID to config.js first - see the README.');
        return;
      }
      window.DollarDrive.connect().then(function (ok) {
        toast(ok ? 'Drive connected.' : 'Could not connect to Drive.');
      });
    });

    $('driveSyncNow').addEventListener('click', function () {
      window.DollarDrive.syncNow().then(function (ok) {
        toast(ok ? 'Synced to Drive.' : (syncState.detail || 'Sync failed.'));
      });
    });

    $('driveDisconnect').addEventListener('click', function () {
      if (!confirm('Disconnect Drive? Entries stay on this phone, and the file stays in your Drive.')) return;
      window.DollarDrive.disconnect();
      toast('Drive disconnected.');
    });

    if (!window.DollarDrive.isConfigured()) {
      var help = $('driveHelp');
      if (help) help.textContent = 'Not set up yet. Add your Google client ID to config.js - the README walks through it.';
    }
  }

  /* ============================ views ============================ */

  var TITLES = { log: 'Log', month: 'Month', year: 'Year', data: 'Data' };

  function setView(name) {
    ui.view = name;
    ['log', 'month', 'year', 'data'].forEach(function (v) {
      $('view-' + v).classList.toggle('hidden', v !== name);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.classList.toggle('active', t.getAttribute('data-view') === name);
    });
    $('screenTitle').textContent = TITLES[name];
    window.scrollTo(0, 0);
    renderAll();
  }

  function renderAll() {
    if (ui.view === 'log') renderLog();
    if (ui.view === 'month') renderMonth();
    if (ui.view === 'year') renderYear();
    if (ui.view === 'data') renderData();
  }

  /* ============================ wiring ============================ */

  function init() {
    load();

    var now = new Date();
    ui.month = new Date(now.getFullYear(), now.getMonth(), 1);
    ui.year = now.getFullYear();

    $('date').value = todayKey();
    renderCatChips();

    $('entryForm').addEventListener('submit', addEntry);

    Array.prototype.forEach.call(document.querySelectorAll('[data-dayshift]'), function (b) {
      b.addEventListener('click', function () {
        $('date').value = shiftDayKey(Number(b.getAttribute('data-dayshift')));
      });
    });

    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.addEventListener('click', function () { setView(t.getAttribute('data-view')); });
    });

    $('monthPrev').addEventListener('click', function () {
      ui.month = new Date(ui.month.getFullYear(), ui.month.getMonth() - 1, 1);
      renderMonth();
    });
    $('monthNext').addEventListener('click', function () {
      ui.month = new Date(ui.month.getFullYear(), ui.month.getMonth() + 1, 1);
      renderMonth();
    });
    $('yearPrev').addEventListener('click', function () { ui.year--; renderYear(); });
    $('yearNext').addEventListener('click', function () { ui.year++; renderYear(); });

    $('exportAll').addEventListener('click', function () {
      exportCsv(db.entries, 'dollar-logger-all-' + todayKey() + '.csv');
    });
    $('exportMonth').addEventListener('click', function () {
      var y = ui.month.getFullYear(), m = ui.month.getMonth();
      exportCsv(inMonth(y, m), 'dollar-logger-' + y + '-' + pad(m + 1) + '.csv');
    });
    $('exportYear').addEventListener('click', function () {
      exportCsv(inYear(ui.year), 'dollar-logger-' + ui.year + '.csv');
    });
    $('copyCsv').addEventListener('click', function () {
      if (!db.entries.length) { toast('Nothing to copy yet.'); return; }
      var text = toCsv(db.entries);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          function () { toast('CSV copied to clipboard.'); },
          function () { toast('Clipboard blocked - use the download instead.'); }
        );
      } else {
        toast('Clipboard not available - use the download instead.');
      }
    });

    $('backupBtn').addEventListener('click', function () {
      download('dollar-logger-backup-' + todayKey() + '.json', JSON.stringify(db, null, 2), 'application/json');
      toast('Backup downloaded.');
    });
    $('restoreInput').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) restoreFromFile(f);
      e.target.value = '';
    });

    $('currency').addEventListener('change', function () {
      db.currency = $('currency').value.trim() || '$';
      $('currency').value = db.currency;
      save();
      renderAll();
    });

    $('addCat').addEventListener('click', function () {
      var name = (prompt('New category name:') || '').trim();
      if (!name) return;
      if (db.categories.indexOf(name) !== -1) { toast('That category already exists.'); return; }
      db.categories.push(name);
      save();
      renderCatChips();
      renderData();
    });

    $('wipeBtn').addEventListener('click', function () {
      if (!db.entries.length) { toast('Nothing to delete.'); return; }
      if (!confirm('Delete all ' + db.entries.length + ' entries? This cannot be undone.\n\nExport or back up first if you want to keep them.')) return;
      if (!confirm('Really delete everything?')) return;
      db.entries.forEach(function (e) { tombstone(e.id); });
      db.entries = [];
      save();
      renderAll();
      toast('All entries deleted.');
    });

    initAuth();
    initApi();
    initDrive();
    setView('log');

    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js').catch(function () { /* offline support is optional */ });
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
