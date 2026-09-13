/* Dollar Logger - a local-first purchase log.
   Entries are written to localStorage first and rendered from there, so the app
   is instant and works offline. api.js reconciles that with the server after. */

(function () {
  'use strict';

  var STORE_KEY = 'dollarLogger.v1';
  var DEFAULT_CATS = ['Food', 'Transport', 'Shopping', 'Bills', 'Fun', 'Health', 'Other'];

  var db = {
    entries: [],   // {id, date:'YYYY-MM-DD', amount:Number, category:String, note:String, created:ISO}
    deleted: [],   // tombstones {id, at} - without these, sync would re-add deleted entries
    categories: DEFAULT_CATS.slice(),
    currency: '$',
    budget: 0,     // monthly budget in dollars; 0 = not set (source of truth: server)
    rollover: false,
    budgetSince: null,
    rolloverSince: null
  };

  var applyingRemote = false;   // suppresses the sync loop while merging server data

  var ui = {
    view: 'log',
    day: null,     // 'YYYY-MM-DD' currently shown in the Log tab
    repeat: '',    // '' | weekly | monthly | yearly, for the add sheet
    editingId: null, // set while the sheet is editing an existing entry
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
      if (parsed && typeof parsed.budget === 'number' && parsed.budget > 0) db.budget = parsed.budget;
      if (parsed && typeof parsed.rollover === 'boolean') db.rollover = parsed.rollover;
      if (parsed && typeof parsed.budgetSince === 'string') db.budgetSince = parsed.budgetSince;
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
  }

  function tombstone(id) {
    db.deleted.push({ id: id, at: new Date().toISOString() });
    if (db.deleted.length > 1000) db.deleted = db.deleted.slice(-1000);
  }

  /* Merge a copy pulled from the server into what is on this device.
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
    db.entries.forEach(function (e, i) { have[e.id] = i + 1; });
    remote.entries.forEach(function (e) {
      if (!e || !e.id || !e.date || typeof e.amount !== 'number') return;
      if (Object.prototype.hasOwnProperty.call(tomb, e.id)) return;
      if (have[e.id]) {
        /* Already here. Take the server's version if it is newer - an edit
           made elsewhere - unless this phone has its own unsent edit, which
           wins and is pushed on this same sync. */
        var local = db.entries[have[e.id] - 1];
        if (!local.dirty && e.updated && e.updated > (local.updated || '')) {
          db.entries[have[e.id] - 1] = e;
          changed = true;
        }
        return;
      }
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

  /* ============================ category icons ============================ */

  /* 24x24 stroke paths, drawn to read at 18px on a phone. Categories the user
     invents fall back to a tag, so a custom category never renders blank. */
  var CAT_ICONS = {
    Food:      ['M6 2v7M9 2v7M6 9h3M7.5 9v13', 'M17 2c-1.6 2-2.5 4.2-2.5 6.5 0 1.7.9 2.9 2.5 3.3V22'],
    Transport: ['M4 17v-5l2-5h12l2 5v5', 'M4 17h16M7 17v2M17 17v2', 'M7.5 13h2M14.5 13h2'],
    Shopping:  ['M6 8h12l-1 13H7L6 8z', 'M9 8V6a3 3 0 0 1 6 0v2'],
    Bills:     ['M6 3h12v18l-3-2-3 2-3-2-3 2V3z', 'M9.5 8h5M9.5 12h5'],
    Fun:       ['M9 18V5l10-2v13', 'M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0z', 'M19 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z'],
    Health:    ['M12 20.5S4 16 4 10.5A4.2 4.2 0 0 1 12 8a4.2 4.2 0 0 1 8 2.5c0 5.5-8 10-8 10z'],
    Other:     ['M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0l-7.2-7.2A2 2 0 0 1 2.8 12V4.8A2 2 0 0 1 4.8 2.8H12a2 2 0 0 1 1.4.6l7.2 7.2a2 2 0 0 1 0 2.8z', 'M7.5 7.5h.01']
  };
  var FALLBACK_ICON = CAT_ICONS.Other;

  function catIcon(category) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');

    (CAT_ICONS[category] || FALLBACK_ICON).forEach(function (d) {
      var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    });
    return svg;
  }

  var KNOWN_CATS = { food: 1, transport: 1, shopping: 1, bills: 1, fun: 1, health: 1, other: 1 };
  function catClass(name) {
    var k = String(name || '').toLowerCase();
    return 'cat-' + (KNOWN_CATS[k] ? k : 'other');
  }

  /* ============================ budget maths ============================ */

  /* All in cents, so "left per day" never shows float noise. `today` is a
     'YYYY-MM-DD' key. Days left INCLUDES today: on the last day of the month
     you still have one day to spend in, not zero. */
  function budgetStatus(spent, budget, y, m, today) {
    var spentC = Math.round(spent * 100), budgetC = Math.round(budget * 100);
    var dim = new Date(y, m + 1, 0).getDate();
    var monthKey = y + '-' + pad(m + 1);
    var nowKey = today.slice(0, 7);

    var daysLeft, pace;                       // pace: share of the month elapsed, 0..1
    if (monthKey < nowKey) { daysLeft = 0; pace = 1; }
    else if (monthKey > nowKey) { daysLeft = dim; pace = 0; }
    else {
      var d = Number(today.slice(8, 10));
      daysLeft = dim - d + 1;
      pace = d / dim;                         // through the end of today
    }

    var leftC = budgetC - spentC;
    var expectedC = Math.round(budgetC * pace);
    var state = spentC > budgetC ? 'bad' : (spentC > expectedC && daysLeft > 0 ? 'warn' : 'good');

    return {
      state: state,
      leftC: leftC,
      daysLeft: daysLeft,
      perDayC: daysLeft > 0 ? Math.floor(Math.max(leftC, 0) / daysLeft) : null,
      expectedC: expectedC,
      pace: pace,
      usedShare: budgetC > 0 ? spentC / budgetC : 0
    };
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

    var badge = el('div', 'cat-badge ' + catClass(e.category));
    badge.appendChild(catIcon(e.category));
    li.appendChild(badge);

    var meta = el('div', 'meta');
    var head = el('div', 'item', e.item || e.note || e.category || 'Purchase');
    if (e.subscription_id) head.appendChild(el('span', 'sub-tag', '↻ repeats'));
    meta.appendChild(head);
    meta.appendChild(el('span', 'cat', e.merchant ? (e.merchant + ' · ' + (e.category || 'Other')) : (e.category || 'Other')));

    var del = el('button', 'del', '×');
    del.type = 'button';
    del.setAttribute('aria-label', 'Delete entry');
    del.addEventListener('click', function (ev) { ev.stopPropagation(); removeEntry(e.id); });
    li.classList.add('tappable');
    li.addEventListener('click', function () { openSheet(e); });

    li.appendChild(meta);
    li.appendChild(el('span', 'amt', money(e.amount)));
    li.appendChild(del);
    return li;
  }

  function barRow(label, value, max, total) {
    var row = el('div', 'bar-row ' + catClass(label));

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

  /* Renders entries grouped under day headings, newest day first.
     Both the Log tab and the Month tab want exactly this, so it lives once. */
  function renderDayGroups(host, list, emptyText) {
    host.innerHTML = '';
    if (!list.length) {
      host.appendChild(el('div', 'empty', emptyText));
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

      host.appendChild(group);
    });
  }

  /* ============================ LOG view ============================ */

  function renderCatChips() {
    var wrap = $('catChips');
    wrap.innerHTML = '';
    if (ui.cat === null || db.categories.indexOf(ui.cat) === -1) ui.cat = db.categories[0];
    db.categories.forEach(function (c) {
      var b = el('button', 'chip' + (c === ui.cat ? ' on' : ''));
      b.type = 'button';
      b.appendChild(catIcon(c));
      b.appendChild(el('span', null, c));
      b.addEventListener('click', function () { ui.cat = c; renderCatChips(); });
      wrap.appendChild(b);
    });
  }

  function entriesOn(key) {
    return db.entries.filter(function (e) { return e.date === key; })
                     .sort(function (a, b) { return (b.created || '') < (a.created || '') ? -1 : 1; });
  }

  /* Sunday-first week containing the given day, the way a calendar grid runs. */
  function weekOf(key) {
    var d = fromKey(key);
    d.setDate(d.getDate() - d.getDay());
    var out = [];
    for (var i = 0; i < 7; i++) {
      out.push(toKey(d));
      d.setDate(d.getDate() + 1);
    }
    return out;
  }

  function setDay(key, direction) {
    var today = todayKey();
    if (key > today) key = today;          // you cannot have spent money yet
    ui.day = key;
    renderLog();

    if (direction) {
      var area = $('dayArea');
      area.classList.remove('slide-l', 'slide-r');
      void area.offsetWidth;               // restart the animation
      area.classList.add(direction > 0 ? 'slide-l' : 'slide-r');
    }
  }

  function shiftDay(days) {
    var d = fromKey(ui.day);
    d.setDate(d.getDate() + days);
    var key = toKey(d);
    if (key > todayKey()) return;          // nothing to see in the future
    setDay(key, days);
  }

  function renderLog() {
    if (!ui.day) ui.day = todayKey();

    var d = fromKey(ui.day);
    $('dayTitleText').textContent = MONTHS[d.getMonth()] + ' ' + d.getFullYear();

    // week strip
    var today = todayKey();
    var busy = {};
    db.entries.forEach(function (e) { busy[e.date] = true; });

    var strip = $('weekStrip');
    strip.innerHTML = '';
    weekOf(ui.day).forEach(function (key) {
      var dd = fromKey(key);
      var cls = 'wday';
      if (key === ui.day) cls += ' sel';
      if (key === today) cls += ' today';
      if (busy[key]) cls += ' has';

      var b = el('button', cls);
      b.type = 'button';
      b.appendChild(el('span', 'dow', DAYS3[dd.getDay()].charAt(0)));
      b.appendChild(el('span', 'num', String(dd.getDate())));
      b.appendChild(el('span', 'dot'));

      if (key > today) b.disabled = true;
      else b.addEventListener('click', (function (k) {
        return function () { setDay(k, k > ui.day ? 1 : (k < ui.day ? -1 : 0)); };
      })(key));

      strip.appendChild(b);
    });

    // the day itself
    var list = entriesOn(ui.day);
    $('dayLabel').textContent = prettyDay(ui.day);
    $('dayTotal').textContent = money(sum(list));

    var host = $('dayEntries');
    host.innerHTML = '';
    if (!list.length) {
      host.appendChild(el('li', 'empty', 'Nothing logged on this day.'));
    } else {
      list.forEach(function (e) { host.appendChild(entryNode(e)); });
    }

    $('curSign').textContent = db.currency;
  }

  function addEntry(ev) {
    ev.preventDefault();

    var amount = parseAmount($('amount').value);
    if (isNaN(amount)) { toast('Enter an amount greater than zero.'); $('amount').focus(); return; }

    var item = $('item').value.trim();
    if (!item) { toast('What did you buy?'); $('item').focus(); return; }

    if (ui.editingId) {
      var target = db.entries.filter(function (x) { return x.id === ui.editingId; })[0];
      if (!target) { closeSheet(); return; }
      target.amount = amount;
      target.item = item;
      target.merchant = $('merchant').value.trim();
      target.date = $('date').value || target.date;
      target.category = ui.cat || target.category;
      target.dirty = true;               // pushed to the server on the next sync
      target.editRev = (target.editRev || 0) + 1;
      save();
      closeSheet();
      if (ui.view === 'log') ui.day = target.date;
      renderAll();
      toast('Saved.');
      return;
    }

    /* A repeating purchase is created on the server, which logs this and every
       future charge itself - so nothing is written locally here, and the entry
       arrives with the next sync. That needs a connection. */
    if (ui.repeat) {
      if (!window.DollarApi || navigator.onLine === false) { toast('Repeating purchases need a connection.'); return; }
      var btn = $('addBtn'); btn.disabled = true;
      window.DollarApi.subscriptions('POST', '', {
        item: item, merchant: $('merchant').value.trim(), category: ui.cat || 'Other',
        amount_cents: Math.round(amount * 100), interval: ui.repeat,
        anchor_date: $('date').value || todayKey(),
        tz: (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
      }).then(function () {
        closeSheet();
        toast('Repeats ' + ui.repeat + ' from ' + prettyDay($('date').value || todayKey()) + '.');
        return window.DollarApi.syncNow();
      }).then(renderSubs).catch(function () {
        toast('Could not save the subscription. Try again.');
      }).then(function () { btn.disabled = false; });
      return;
    }

    var date = $('date').value || todayKey();

    db.entries.push({
      id: 'e' + Date.now() + Math.random().toString(36).slice(2, 7),
      date: date,
      amount: amount,
      category: ui.cat || 'Other',
      item: item,
      merchant: $('merchant').value.trim(),
      created: new Date().toISOString()
    });
    save();

    $('amount').value = '';
    $('item').value = '';
    $('merchant').value = '';
    closeSheet();
    if (ui.view === 'log') ui.day = date;
    renderAll();
    toast('Logged ' + money(amount) + ' · ' + prettyDay(date));
  }

  function removeEntry(id) {
    var e = db.entries.filter(function (x) { return x.id === id; })[0];
    if (!e) return;
    if (!confirm('Delete "' + (e.item || e.category) + '" (' + money(e.amount) + ', ' + prettyDay(e.date) + ')?')) return;
    db.entries = db.entries.filter(function (x) { return x.id !== id; });
    tombstone(id);
    save();
    renderAll();
    toast('Deleted.');
  }

  /* ============================ date picker ============================ */

  var calMonth = null;      // Date pinned to the 1st of the displayed month
  var calMode = 'form';     // 'form' sets the new entry's date, 'nav' moves the day view

  function setDate(key) {
    $('date').value = key;
    $('dateLabel').textContent = longDay(key);
  }

  function longDay(key) {
    if (key === todayKey()) return 'Today';
    if (key === shiftDayKey(1)) return 'Yesterday';
    var d = fromKey(key);
    var base = DAYS3[d.getDay()] + ', ' + d.getDate() + ' ' + MON3[d.getMonth()];
    // Only show the year when it is not the current one - less noise, no ambiguity.
    return d.getFullYear() === new Date().getFullYear() ? base : base + ' ' + d.getFullYear();
  }

  function openCal(mode) {
    calMode = mode || 'form';
    var selected = (calMode === 'nav' ? ui.day : $('date').value) || todayKey();
    var d = fromKey(selected);
    calMonth = new Date(d.getFullYear(), d.getMonth(), 1);

    renderCal();
    $('calScrim').classList.remove('hidden');
    requestAnimationFrame(function () { $('calScrim').classList.add('show'); });
  }

  function closeCal() {
    $('calScrim').classList.remove('show');
    setTimeout(function () { $('calScrim').classList.add('hidden'); }, 180);
  }

  function renderCal() {
    var y = calMonth.getFullYear(), m = calMonth.getMonth();
    $('calTitle').textContent = MONTHS[m] + ' ' + y;

    var today = todayKey();
    var selected = (calMode === 'nav' ? ui.day : $('date').value);

    // Which days already have entries - a dot under the number, like a calendar app.
    var busy = {};
    db.entries.forEach(function (e) { busy[e.date] = true; });

    var grid = $('calGrid');
    grid.innerHTML = '';

    // Blank cells so the 1st lands under its real weekday.
    var firstWeekday = new Date(y, m, 1).getDay();
    for (var b = 0; b < firstWeekday; b++) {
      var pad = el('button', 'cal-day blank', '');
      pad.type = 'button';
      pad.disabled = true;
      grid.appendChild(pad);
    }

    var daysInMonth = new Date(y, m + 1, 0).getDate();
    for (var day = 1; day <= daysInMonth; day++) {
      var key = y + '-' + pad2(m + 1) + '-' + pad2(day);
      var cls = 'cal-day';
      if (key === today) cls += ' today';
      if (key === selected) cls += ' chosen';
      if (busy[key]) cls += ' has-entries';

      var cell = el('button', cls, String(day));
      cell.type = 'button';

      // You cannot have spent money tomorrow.
      if (key > today) {
        cell.disabled = true;
      } else {
        cell.addEventListener('click', (function (k) {
          return function () {
            if (calMode === 'nav') setDay(k, 0);
            else setDate(k);
            closeCal();
          };
        })(key));
      }
      grid.appendChild(cell);
    }

    // Nothing to see in future months either.
    var nextMonthStart = new Date(y, m + 1, 1);
    $('calNext').disabled = toKey(nextMonthStart) > today;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /* ============================ receipt scan ============================ */

  /* Phone photos are 3-12 MB. Shrink to 1024px JPEG before upload: faster on
     mobile data, well under the server's 4 MB cap, and fewer image tokens. */
  function shrinkImage(file) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      var url = URL.createObjectURL(file);
      img.onload = function () {
        var scale = Math.min(1, 1024 / Math.max(img.width, img.height));
        var c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function (b) { b ? resolve(b) : reject(new Error('encode')); }, 'image/jpeg', 0.85);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('decode')); };
      img.src = url;
    });
  }

  function fillFromDraft(d) {
    var filled = 0;
    function put(id, v) {
      if (v === null || v === undefined || v === '') return;
      $(id).value = v; $(id).classList.add('filled'); filled++;
    }
    put('amount', d.amount_cents ? (d.amount_cents / 100).toFixed(2) : null);
    showAmountPicks(d.amounts || [], d.amount_cents);
    put('item', d.item);
    put('merchant', d.merchant);
    if (d.date) { setDate(d.date); filled++; }
    return filled;
  }

  /* Every amount the model read, as tappable chips. If the automatic pick is
     wrong (a subtotal instead of the total), one tap fixes it. */
  function showAmountPicks(list, chosen) {
    var box = $('amountPicks');
    box.innerHTML = '';
    if (list.length < 2) { box.classList.add('hidden'); return; }
    box.appendChild(el('span', 'lbl', 'Amounts on the receipt - tap the one you paid'));
    list.forEach(function (a) {
      var b = el('button', 'pick' + (a.cents === chosen ? ' on' : ''));
      b.type = 'button';
      b.appendChild(document.createTextNode(a.label || 'Amount'));
      b.appendChild(el('b', null, money(a.cents / 100)));
      b.addEventListener('click', function () {
        $('amount').value = (a.cents / 100).toFixed(2);
        showAmountPicks(list, a.cents);
      });
      box.appendChild(b);
    });
    box.classList.remove('hidden');
  }

  function onScan(e) {
    var file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file || !window.DollarApi) return;

    var btn = $('scanBtn');
    btn.classList.add('busy');
    $('scanLabel').textContent = 'Reading receipt...';

    shrinkImage(file)
      .then(function (blob) { return window.DollarApi.scanReceipt(blob); })
      .then(function (draft) {
        var n = fillFromDraft(draft || {});
        toast(n ? 'Check the details, then tap Add.' : 'Could not read that - please type it in.');
      })
      .catch(function (err) {
        var m = String(err && err.message);
        toast(m === 'unreadable' ? 'Could not read that receipt - try a clearer photo.'
            : m === 'scan_unavailable' ? 'Scanning is unavailable right now - please type it in.'
            : 'Scan failed - please type it in.');
      })
      .then(function () {
        btn.classList.remove('busy');
        $('scanLabel').textContent = 'Scan a receipt';
      });
  }

  /* ============================ subscriptions ============================ */

  function setRepeat(v) {
    ui.repeat = v;
    Array.prototype.forEach.call(document.querySelectorAll('[data-repeat]'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-repeat') === v);
    });
  }

  function renderSubs() {
    var host = $('subList');
    if (!host || !window.DollarApi || !(window.DollarAuth && window.DollarAuth.isSignedIn())) return;
    window.DollarApi.subscriptions('GET').then(function (body) {
      host.innerHTML = '';
      var list = (body && body.subscriptions) || [];
      if (!list.length) { host.appendChild(el('li', 'empty', 'No repeating purchases. Pick Repeat when adding one.')); return; }
      list.forEach(function (s) {
        var li = el('li', 'entry');
        var badge = el('div', 'cat-badge ' + catClass(s.category)); badge.appendChild(catIcon(s.category)); li.appendChild(badge);
        var meta = el('div', 'meta');
        meta.appendChild(el('div', 'item', s.item));
        meta.appendChild(el('span', 'cat', s.interval.charAt(0).toUpperCase() + s.interval.slice(1) + ' · next ' + prettyDay(s.next_date)));
        li.appendChild(meta);
        li.appendChild(el('span', 'amt', money(s.amount_cents / 100)));
        var x = el('button', 'del', '×'); x.type = 'button'; x.setAttribute('aria-label', 'Cancel subscription');
        x.addEventListener('click', function () {
          if (!confirm('Stop "' + s.item + '" repeating? Charges already logged stay.')) return;
          window.DollarApi.subscriptions('DELETE', '/' + s.id).then(function () { toast('Cancelled.'); renderSubs(); })
            .catch(function () { toast('Could not cancel. Try again.'); });
        });
        li.appendChild(x);
        host.appendChild(li);
      });
    }).catch(function () { /* offline: leave the list as it was */ });
  }

  /* ============================ notifications ============================ */

  function standalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  }

  function urlB64ToBytes(s) {
    var p = s.replace(/-/g, '+').replace(/_/g, '/'); while (p.length % 4) p += '=';
    var raw = atob(p), out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function renderPush() {
    var btn = $('pushBtn'), test = $('pushTest'), status = $('pushStatus'), dot = $('pushDot'), help = $('pushHelp');
    var supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

    if (!supported || !standalone()) {
      status.textContent = 'Not available here';
      dot.className = 'sync-dot off';
      help.textContent = 'On iPhone, notifications only work from the home-screen app (Share > Add to Home Screen, iOS 16.4+).';
      btn.classList.add('hidden'); test.classList.add('hidden');
      return;
    }
    navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); }).then(function (sub) {
      var on = !!sub && Notification.permission === 'granted';
      status.textContent = on ? 'On - alerts at 80% of budget' : (Notification.permission === 'denied' ? 'Blocked in Settings' : 'Off');
      dot.className = 'sync-dot ' + (on ? 'ok' : 'idle');
      btn.classList.remove('hidden');
      btn.textContent = on ? 'Turn off budget alerts' : 'Turn on budget alerts';
      test.classList.toggle('hidden', !on);
      if (Notification.permission === 'denied') help.textContent = 'Notifications are blocked. Enable them in Settings > Notifications > Dollar Logger.';
    });
  }

  function togglePush() {
    navigator.serviceWorker.ready.then(function (reg) {
      return reg.pushManager.getSubscription().then(function (existing) {
        if (existing) {
          return window.DollarApi.call('DELETE', '/push', { endpoint: existing.endpoint })
            .catch(function () {}).then(function () { return existing.unsubscribe(); })
            .then(function () { toast('Budget alerts off.'); });
        }
        if (!ui.vapidKey) throw new Error('no_key');
        // Must run from the tap itself: iOS only shows the prompt for a user gesture.
        return Notification.requestPermission().then(function (perm) {
          if (perm !== 'granted') throw new Error('denied');
          return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(ui.vapidKey) });
        }).then(function (sub) {
          return window.DollarApi.call('POST', '/push', sub.toJSON());
        }).then(function () { toast('Budget alerts on.'); });
      });
    }).catch(function (err) {
      var m = String(err && err.message);
      toast(m === 'denied' ? 'Notifications were not allowed.' : m === 'no_key' ? 'Still loading - try again in a moment.' : 'Could not change notifications.');
    }).then(renderPush);
  }

  /* ============================ merchant suggestions ============================ */

  /* Past merchants, most used first, with the category most often used there. */
  function merchantStats() {
    var map = {};
    db.entries.forEach(function (e) {
      var name = (e.merchant || '').trim();
      if (!name) return;
      var k = name.toLowerCase();
      var m = map[k] || (map[k] = { name: name, count: 0, cats: {}, last: '' });
      m.count++;
      m.cats[e.category] = (m.cats[e.category] || 0) + 1;
      if (e.date >= m.last) { m.last = e.date; m.name = name; }   // keep the latest spelling
    });
    return Object.keys(map).map(function (k) { return map[k]; })
      .sort(function (a, b) { return b.count - a.count || (a.last < b.last ? 1 : -1); });
  }

  function usualCategory(merchant) {
    var k = String(merchant || '').trim().toLowerCase();
    var m = merchantStats().filter(function (x) { return x.name.toLowerCase() === k; })[0];
    if (!m) return null;
    return Object.keys(m.cats).sort(function (a, b) { return m.cats[b] - m.cats[a]; })[0];
  }

  function renderMerchantPicks() {
    var stats = merchantStats();

    var list = $('merchantList');
    list.innerHTML = '';
    stats.slice(0, 50).forEach(function (m) {
      var o = document.createElement('option'); o.value = m.name; list.appendChild(o);
    });

    var box = $('merchantPicks');
    box.innerHTML = '';
    stats.slice(0, 6).forEach(function (m) {
      var b = el('button', 'pick', m.name);
      b.type = 'button';
      b.addEventListener('click', function () { $('merchant').value = m.name; onMerchantChosen(); });
      box.appendChild(b);
    });
    box.classList.toggle('hidden', !stats.length);
  }

  var catTouched = false;   // don't override a category the user picked by hand
  function onMerchantChosen() {
    if (catTouched) return;
    var c = usualCategory($('merchant').value);
    if (c && db.categories.indexOf(c) !== -1) { ui.cat = c; renderCatChips(); }
  }

  /* ============================ add sheet ============================ */

  var sheetOpen = false;
  var lastFocus = null;

  function openSheet(entry) {
    if (sheetOpen) return;
    sheetOpen = true;
    lastFocus = document.activeElement;
    // Called from a click handler, openSheet receives an Event - only a real entry means edit.
    var editing = entry && entry.id ? entry : null;
    ui.editingId = editing ? editing.id : null;

    setDate(ui.day && ui.day <= todayKey() ? ui.day : todayKey());
    $('amount').value = '';
    $('item').value = '';
    $('merchant').value = '';
    ['amount', 'item', 'merchant'].forEach(function (id) { $(id).classList.remove('filled'); });
    renderMerchantPicks();
    $('sheetTitle').textContent = editing ? 'Edit purchase' : 'New purchase';
    $('sheetSave').textContent = editing ? 'Save' : 'Add';
    $('addBtn').textContent = editing ? 'Save changes' : 'Add purchase';
    // Scanning and repeating are for new purchases only.
    $('scanBtn').classList.toggle('hidden', !!editing);
    $('repeatField').classList.toggle('hidden', !!editing);
    if (editing) {
      $('amount').value = editing.amount.toFixed(2);
      $('item').value = editing.item || editing.note || '';
      $('merchant').value = editing.merchant || '';
      setDate(editing.date);
      ui.cat = editing.category || ui.cat;
      renderCatChips();
    }
    setRepeat('');
    $('amountPicks').classList.add('hidden');
    renderCatChips();

    $('scrim').classList.remove('hidden');
    $('addSheet').classList.remove('hidden');

    // One frame between "displayed" and "animated" or the transition is skipped:
    // the browser needs a paint at the start position before it has one to move from.
    requestAnimationFrame(function () {
      $('scrim').classList.add('show');
      $('addSheet').classList.add('show');
    });

    // The page behind must not scroll while a sheet is over it.
    document.body.classList.add('locked');

    // Deliberately NOT focusing the amount field: on iOS that summons the
    // keyboard mid-animation and the sheet lands in the wrong place.
    $('fabAdd').classList.add('hidden');
  }

  function closeSheet() {
    if (!sheetOpen) return;
    sheetOpen = false;
    ui.editingId = null;

    $('scrim').classList.remove('show');
    $('addSheet').classList.remove('show');
    document.body.classList.remove('locked');

    setTimeout(function () {
      if (sheetOpen) return;                 // reopened during the animation
      $('scrim').classList.add('hidden');
      $('addSheet').classList.add('hidden');
    }, 240);

    if (ui.view === 'log') $('fabAdd').classList.remove('hidden');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
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

    renderBudget(y, m, total);
    renderDayGroups($('monthDays'), list, 'No purchases this month.');
  }

  function renderBudget(y, m, spent) {
    var card = $('budgetCard');
    card.innerHTML = '';
    card.className = 'budget-card';

    var edit = el('button', 'link-btn', db.budget ? 'Edit' : 'Set a monthly budget');
    edit.type = 'button';
    edit.addEventListener('click', function () {
      var v = prompt('Monthly budget (' + db.currency + '), blank to remove:', db.budget ? db.budget.toFixed(2) : '');
      if (v === null) return;
      var n = parseAmount(v);
      saveBudget(isNaN(n) ? 0 : n, db.rollover);
    });

    if (!db.budget) {
      card.appendChild(el('span', 'muted', 'No budget set. '));
      card.appendChild(edit);
      return;
    }

    var carry = rolloverCarry(y, m);
    var effective = db.budget + carry;
    var st = budgetStatus(spent, effective, y, m, todayKey());
    card.classList.add(st.state);

    var top = el('div', 'budget-top');
    var label = el('div');
    label.appendChild(el('span', 'muted small', 'Budget ' + money(effective) +
      (carry ? ' (' + (carry > 0 ? '+' : '-') + money(Math.abs(carry)) + ' from last month)' : '') + ' · '));
    label.appendChild(edit);
    top.appendChild(label);
    top.appendChild(el('strong', 'budget-state',
      st.leftC >= 0 ? money(st.leftC / 100) + ' left' : 'Over by ' + money(-st.leftC / 100)));
    card.appendChild(top);

    var track = el('div', 'budget-track');
    var fill = el('div', 'budget-fill');
    fill.style.width = Math.min(st.usedShare, 1) * 100 + '%';
    track.appendChild(fill);
    if (st.pace > 0 && st.pace < 1) {
      var mark = el('div', 'budget-pace');           // where spending "should" be today
      mark.style.left = st.pace * 100 + '%';
      track.appendChild(mark);
    }
    card.appendChild(track);

    card.appendChild(el('span', 'muted small',
      Math.round(st.usedShare * 100) + '% used' +
      (st.state === 'warn' ? ' · ahead of pace' : st.state === 'bad' ? ' · over budget' : ' · on track')));

    var grid = el('div', 'budget-grid');
    function cell(title, value) {
      var c = el('div'); c.appendChild(el('span', null, title)); c.appendChild(el('b', null, value)); grid.appendChild(c);
    }
    if (st.daysLeft > 0) {
      cell('Can spend per day', st.perDayC > 0 ? money(st.perDayC / 100) : money(0));
      cell('Days left', st.daysLeft + (st.daysLeft === 1 ? ' day' : ' days') + (st.pace > 0 ? ' incl. today' : ''));
    } else {
      cell('Month result', st.leftC >= 0 ? 'Under by ' + money(st.leftC / 100) : 'Over by ' + money(-st.leftC / 100));
      cell('Spent', money(spent));
    }
    card.appendChild(grid);

    var roll = el('button', 'link-btn', db.rollover ? 'Rollover on - turn off' : 'Turn on rollover');
    roll.type = 'button';
    roll.addEventListener('click', function () { saveBudget(db.budget, !db.rollover); });
    var foot = el('div', 'small'); foot.appendChild(roll);
    card.appendChild(foot);
  }

  /* Mirrors the server exactly: one month, both directions, and last month only
     carries if rollover was already on for all of it. */
  function rolloverCarry(y, m) {
    if (!db.rollover || !db.budget || !db.rolloverSince) return 0;
    var py = m === 0 ? y - 1 : y, pm = m === 0 ? 11 : m - 1;
    var prevKey = py + '-' + pad(pm + 1);
    if (db.rolloverSince > prevKey) return 0;
    var prevSpent = Math.round(sum(inMonth(py, pm)) * 100);
    return (Math.round(db.budget * 100) - prevSpent) / 100;
  }

  function applySettings(s) {
    if (!s) return;
    try { applySettingsUnsafe(s); } catch (e) { console.warn('settings not applied', e); }
  }

  function applySettingsUnsafe(s) {
    db.budget = (s.budget_cents || 0) / 100;
    db.rollover = !!s.rollover;
    db.budgetSince = s.budget_since || null;
    db.rolloverSince = s.rollover_since || null;
    if (s.vapid_public_key) ui.vapidKey = s.vapid_public_key;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(db)); } catch (e) {}
    if (ui.view === 'month') renderMonth();
  }

  function loadSettings() {
    if (!window.DollarApi || !(window.DollarAuth && window.DollarAuth.isSignedIn())) return;
    window.DollarApi.call('GET', '/settings').then(applySettings).catch(function () {});
  }

  function saveBudget(dollars, rollover) {
    if (!window.DollarApi || navigator.onLine === false) { toast('Changing the budget needs a connection.'); return; }
    window.DollarApi.call('PUT', '/settings', {
      budget_cents: Math.round((dollars || 0) * 100),
      rollover: !!rollover,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    }).then(applySettings).catch(function () { toast('Could not save the budget. Try again.'); });
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
    var rows = [['Date', 'Year', 'Month', 'Item', 'Merchant', 'Category', 'Amount']];
    list.slice()
      .sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); })
      .forEach(function (e) {
        var d = fromKey(e.date);
        rows.push([e.date, d.getFullYear(), MONTHS[d.getMonth()],
                   e.item || '', e.merchant || '', e.category || 'Other', e.amount.toFixed(2)]);
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
      // that would otherwise delete them again on the next sync.
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

  /* ============================ sync status UI ============================ */

  var syncState = { state: 'off', detail: '', linked: false };

  var SYNC_TEXT = {
    off: 'Sync not set up',
    idle: 'Not connected',
    pending: 'Saving...',
    syncing: 'Syncing...',
    ok: 'Synced',
    error: 'Sync problem'
  };

  /* ============================ account + gate ============================ */

  /* The gate is the whole point of the change: until there is a session, the
     app is not shown at all. It is driven only by DollarAuth state, so a
     session expiring mid-use puts the sign-in screen back without a reload. */
  function applyAuthState(s) {
    var signedIn = !!s.signedIn;

    document.body.classList.toggle('gated', !signedIn);
    $('gate').classList.toggle('hidden', signedIn);

    // Nothing is configured yet - say so rather than showing a dead button.
    $('gateUnconfigured').classList.toggle('hidden', !!s.configured);

    var initial = (s.email || '?').trim().charAt(0).toUpperCase() || '?';
    $('avatarInitial').textContent = signedIn ? initial : '?';
    $('accountBtn').classList.toggle('out', !signedIn);
    $('acctAvatar').textContent = signedIn ? initial : '?';

    $('authStatus').textContent = signedIn ? (s.email || 'Signed in') : 'Not signed in';
    $('authHelp').textContent = s.busy ? 'Signing in...'
      : signedIn ? 'Session lasts 30 days' : 'Sign in to sync';

    var dot = $('authDot');
    if (dot) dot.className = 'sync-dot ' + (signedIn ? 'ok' : 'idle');

    $('signOutBtn').classList.toggle('hidden', !signedIn);
    $('googleBtn').classList.toggle('hidden', signedIn);

    // The + button belongs to the Log tab, and only once you are in.
    $('fabAdd').classList.toggle('hidden', !signedIn || ui.view !== 'log' || sheetOpen);
  }

  function initAuth() {
    if (!window.DollarAuth) return;

    window.DollarAuth.onChange(function (s) { applyAuthState(s); if (s.signedIn) loadSettings(); });

    window.DollarAuth.onError(function (msg) {
      var box = $('gateError');
      box.textContent = msg;
      box.classList.remove('hidden');
      toast(msg);
    });

    $('accountBtn').addEventListener('click', openAccount);
    $('acctClose').addEventListener('click', closeAccount);
    $('acctScrim').addEventListener('click', closeAccount);

    $('signOutBtn').addEventListener('click', function () {
      if (!confirm('Sign out on all devices? Entries already on this phone stay here.')) return;
      window.DollarAuth.signOut();
      closeAccount();
      toast('Signed out.');
    });

    window.DollarAuth.init();
  }

  var accountOpen = false;

  function openAccount() {
    if (accountOpen) return;
    accountOpen = true;
    $('acctScrim').classList.remove('hidden');
    $('acctSheet').classList.remove('hidden');
    requestAnimationFrame(function () {
      $('acctScrim').classList.add('show');
      $('acctSheet').classList.add('show');
    });
    document.body.classList.add('locked');
  }

  function closeAccount() {
    if (!accountOpen) return;
    accountOpen = false;
    $('acctScrim').classList.remove('show');
    $('acctSheet').classList.remove('show');
    document.body.classList.remove('locked');
    setTimeout(function () {
      if (accountOpen) return;
      $('acctScrim').classList.add('hidden');
      $('acctSheet').classList.add('hidden');
    }, 240);
  }

  function initApi() {
    if (!window.DollarApi) return;

    window.DollarApi.init({
      getState: function () { return db; },
      markSynced: function (entry, updatedAt, sentRev) {
        entry.updated = updatedAt || entry.updated;
        // Clear the flag only if no newer edit happened while the request was in flight.
        if (entry.editRev === sentRev) delete entry.dirty;
        try { localStorage.setItem(STORE_KEY, JSON.stringify(db)); } catch (e) {}
      },

      mergeRemote: mergeRemote,
      onStatus: function (s) {
        var dot = $('apiDot');
        if (dot) dot.className = 'sync-dot ' + s.state;
        var label = $('apiStatus');
        if (label) label.textContent = s.detail || SYNC_TEXT[s.state] || '';

        // A quiet marker in the header so sync trouble is visible from any tab.
        var head = $('topbarRight');
        if (head) {
          if (s.state === 'error') head.textContent = 'sync !';
          else if (s.state === 'syncing' || s.state === 'pending') head.textContent = 'sync...';
          else head.textContent = '';
        }
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

  /* The header's height depends on the status-bar inset, which differs between
     a browser tab and an installed app, so the week strip cannot be given a
     hardcoded offset to stick below. Measure it and hand it to CSS. */
  function measureHeader() {
    var bar = $('topbar');
    if (!bar) return;
    var h = bar.offsetHeight;
    if (h > 0) document.documentElement.style.setProperty('--topbar-h', h + 'px');
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
    var signedIn = window.DollarAuth && window.DollarAuth.isSignedIn();
    $('fabAdd').classList.toggle('hidden', !signedIn || name !== 'log' || sheetOpen);
    window.scrollTo(0, 0);
    renderAll();
  }

  function renderAll() {
    if (ui.view === 'log') renderLog();
    if (ui.view === 'month') renderMonth();
    if (ui.view === 'year') renderYear();
    if (ui.view === 'data') { renderData(); renderSubs(); renderPush(); }
  }

  /* ============================ wiring ============================ */

  function init() {
    load();

    var now = new Date();
    ui.month = new Date(now.getFullYear(), now.getMonth(), 1);
    ui.year = now.getFullYear();

    setDate(todayKey());
    renderCatChips();

    $('entryForm').addEventListener('submit', addEntry);

    // --- add sheet ---
    $('fabAdd').addEventListener('click', openSheet);
    $('scanInput').addEventListener('change', onScan);
    $('merchant').addEventListener('change', onMerchantChosen);
    $('catChips').addEventListener('click', function () { catTouched = true; });
    $('fabAdd').addEventListener('click', function () { catTouched = false; });
    $('pushBtn').addEventListener('click', togglePush);
    $('pushTest').addEventListener('click', function () {
      window.DollarApi.call('POST', '/push/test').then(function (r) {
        toast(r && r.sent ? 'Test sent.' : 'No device registered - turn alerts off and on again.');
      }).catch(function () { toast('Test failed.'); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-repeat]'), function (b) {
      b.addEventListener('click', function () { setRepeat(b.getAttribute('data-repeat')); });
    });
    $('sheetCancel').addEventListener('click', closeSheet);
    $('scrim').addEventListener('click', closeSheet);

    // --- date picker ---
    $('dateBtn').addEventListener('click', function () { openCal('form'); });
    $('dayTitle').addEventListener('click', function () { openCal('nav'); });
    $('calCancel').addEventListener('click', closeCal);
    $('calToday').addEventListener('click', function () {
      if (calMode === 'nav') setDay(todayKey(), 0);
      else setDate(todayKey());
      closeCal();
    });
    $('calPrev').addEventListener('click', function () {
      calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() - 1, 1);
      renderCal();
    });
    $('calNext').addEventListener('click', function () {
      calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 1);
      renderCal();
    });
    $('calScrim').addEventListener('click', function (e) {
      if (e.target === $('calScrim')) closeCal();    // backdrop only, not the card
    });

    /* Swipe the day area left/right to change day. Deliberately strict: the
       gesture must be clearly horizontal, or every attempt to scroll the list
       would flick you to another day. */
    (function () {
      var area = $('dayArea');
      var start = null;

      area.addEventListener('touchstart', function (e) {
        if (e.touches.length !== 1) { start = null; return; }
        start = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
      }, { passive: true });

      area.addEventListener('touchend', function (e) {
        if (!start) return;
        var t = e.changedTouches[0];
        var dx = t.clientX - start.x;
        var dy = t.clientY - start.y;
        var ms = Date.now() - start.t;
        start = null;

        if (ms > 700) return;                          // a slow drag is not a swipe
        if (Math.abs(dx) < 55) return;                 // too small to be deliberate
        if (Math.abs(dx) < Math.abs(dy) * 1.6) return; // mostly vertical: let it scroll

        shiftDay(dx < 0 ? 1 : -1);                     // swipe left = next day
      }, { passive: true });
    })();

    // Arrow keys do the same thing on a desktop browser.
    document.addEventListener('keydown', function (e) {
      if (ui.view !== 'log' || sheetOpen || accountOpen) return;
      if (!$('calScrim').classList.contains('hidden')) return;
      if (e.key === 'ArrowLeft') shiftDay(-1);
      if (e.key === 'ArrowRight') shiftDay(1);
    });

    // Escape closes the topmost layer first.
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (!$('calScrim').classList.contains('hidden')) closeCal();
      else if (sheetOpen) closeSheet();
      else if (accountOpen) closeAccount();
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

    measureHeader();
    window.addEventListener('resize', measureHeader);
    window.addEventListener('orientationchange', measureHeader);
    initAuth();
    initApi();
    setView('log');

    if ('serviceWorker' in navigator) {
      /* Was a worker already driving this page? On a first-ever visit there is
         none, and the reload below would be pointless churn. */
      var hadController = !!navigator.serviceWorker.controller;
      var reloading = false;

      // Fires when a newly installed worker takes over. At that moment the old
      // files are stale, so pick up the new ones rather than leaving a half-old
      // page on screen.
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (!hadController || reloading) return;
        reloading = true;
        location.reload();
      });

      window.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js').then(function (reg) {
          reg.update();
          // Phones can stay open for days; check again occasionally.
          setInterval(function () { reg.update(); }, 60 * 60 * 1000);
          // And whenever you come back to the app.
          document.addEventListener('visibilitychange', function () {
            if (!document.hidden) reg.update();
          });
        }).catch(function () { /* offline support is optional */ });
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
