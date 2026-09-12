# Dollar Logger

A phone-first web app for logging what you spend. Open it, type an amount, tap a category, done. It shows you a monthly and yearly picture of where the money went, and exports the whole lot to CSV whenever you want it in a spreadsheet.

## Introduction

This is deliberately a **static app**: a handful of files of plain HTML, CSS and JavaScript with no framework, no build step, no server and no account of its own. That single decision is what makes the rest of it work — hosting is free and permanent because there is nothing to run, the app opens instantly, it works with no signal, and nobody but you ever sees the data.

The trade-off is that entries are stored in the browser on the device you logged them from, and browser storage can be cleared. Two things cover that: an optional [Google Drive sync](#connect-google-drive) that copies each entry to your own Drive seconds after you log it, and manual Export/Backup buttons. Read [Where your data lives](#where-your-data-lives) before you have a year of entries you care about.

## What It Does

1. You log a purchase — amount, date, category, optional note.
2. It saves to the phone instantly, with no network round-trip to wait on.
3. The Month tab totals that month, splits it by category, and lists it day by day.
4. The Year tab totals the year and charts all twelve months side by side.
5. The Data tab exports any of it to CSV, backs the whole thing up to a JSON file, and manages the Drive connection.
6. If Drive is connected, each entry is pushed there a couple of seconds after you log it.

## Features

#### Fast logging

The amount field is the first thing on screen and opens the numeric keypad. Date defaults to today, with one-tap Today and Yesterday buttons and a date picker for anything older. The amount box also accepts messy input — `$12`, `1,299.99`, and even `3+4.50` when one shop trip was two things.

#### Monthly view

Pick any month with the arrows. You get the total, the number of purchases, a per-day average, a ranked bar chart of categories with percentages, and every purchase grouped under its day with a daily subtotal.

#### Yearly view

The same idea a level up: the year's total, a monthly average, and a twelve-bar chart of the whole year. Tapping any month's bar jumps straight into that month.

#### CSV export

Exports everything, just the month you're looking at, or just the year. The file has one row per purchase with Date, Year, Month, Category, Amount and Note columns, ready to pivot in Excel or Google Sheets. There's a copy-to-clipboard option too, for when a phone makes downloads awkward.

#### Google Drive sync

Optionally connects to your own Google Drive and copies every entry to a single file there, seconds after you log it. It uses the `drive.file` scope, so the app can only ever touch the one file it created. See [Connect Google Drive](#connect-google-drive).

#### Backup and restore

Downloads a JSON file holding every entry, your categories and your settings. Restoring merges it back in and skips anything already there, so restoring the same file twice won't duplicate your history.

#### Works offline, installs like an app

A service worker caches the app on first visit. After that it opens with no signal at all, and it can be added to your home screen so it launches full-screen with its own icon, no browser bar.

#### Your own categories

Seven sensible defaults ship with it. Add or remove your own in the Data tab. Removing a category leaves old entries labelled as they were, so your history never silently changes.

## Configuration

Everything user-facing lives in the **Data** tab: the currency symbol (change `$` to `£`, `€`, `RM`, whatever you use) and the category list.

To change the look, edit the variables at the top of [styles.css](styles.css) — `--accent` is the green, `--bar` is the chart colour, and there's a matching dark-mode block below. The app follows your phone's light/dark setting automatically.

## Run It Locally

Opening `index.html` by double-clicking mostly works, but service workers need a real server, so offline mode won't kick in that way. To see it exactly as it will behave hosted, serve the folder:

```bash
cd "Dollar Logger"
python -m http.server 8000
```

Then open `http://localhost:8000`. Any static server does the same job — `npx serve` if you'd rather use Node.

To check the phone layout without a phone, open your browser's dev tools and switch on device emulation.

## Host It Free, Permanently

GitHub Pages is the recommendation: genuinely free with no trial and no card, no traffic limits that a personal app will ever reach, HTTPS included (required — service workers and the install prompt only work over HTTPS), and a stable URL you control.

### Prerequisites

- A free GitHub account
- Git installed, or the willingness to drag files into the browser uploader

### Steps

1. Create a new **public** repository on GitHub named `dollar-logger`. Public is required for Pages on a free account. Nothing sensitive is in the code, and your purchases never leave your phone, so public costs you no privacy here.

2. Upload the contents of this folder to the repository root — `index.html` must sit at the top level, not inside a subfolder. Either use the web uploader, or from this folder run:

   ```bash
   git init
   git add .
   git commit -m "Dollar Logger"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/dollar-logger.git
   git push -u origin main
   ```

3. In the repository, go to **Settings → Pages**. Under "Build and deployment", set Source to **Deploy from a branch**, branch to **main**, folder to **/ (root)**, and Save.

4. Wait a minute or two, then open `https://YOUR-USERNAME.github.io/dollar-logger/`. That URL is now yours and stays live as long as the repo exists.

To update the app later, push your changes — Pages redeploys on its own. One catch: phones cache aggressively, so after any change bump the `CACHE` version string at the top of [sw.js](sw.js) (`dollar-logger-v2` → `v3`, and so on), or your phone will happily keep serving the old version.

**Alternatives**, if you'd rather not use GitHub: [Cloudflare Pages](https://pages.cloudflare.com/) and [Netlify](https://www.netlify.com/) both have free tiers that will host this, and both accept a drag-and-dropped folder with no Git at all.

## Connect Google Drive

Optional, and the app works fully without it. Once connected, every entry is copied to a single `dollar-logger.json` file in your Drive a couple of seconds after you log it — so a lost phone costs you nothing.

The app requests only the `drive.file` scope, which means **it can see the one file it created and nothing else in your Drive**. That scope is classed as non-sensitive, so Google requires no app review ([Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)).

### Why it syncs on each entry rather than at midnight

A web app gets no background execution — it cannot run while closed. The one API for it, [Periodic Background Sync](https://developer.mozilla.org/en-US/docs/Web/API/Web_Periodic_Background_Synchronization_API), does not exist in Safari or on iOS at all. So instead of a scheduled end-of-day upload, the app syncs a couple of seconds after each entry, and again whenever you bring it back to the foreground. That is both simpler and safer: there is never a window where your phone holds the only copy.

### Steps

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and create a new project. Name it anything.

2. Enable the Drive API: **APIs & Services → Library → Google Drive API → Enable**.

3. Configure the OAuth consent screen: **APIs & Services → OAuth consent screen**. Choose **External**, give it a name ("Dollar Logger"), and put your own email in the required fields. Add your own Google account under **Test users**.

4. Create the credential: **APIs & Services → Credentials → Create credentials → OAuth client ID → Web application**. Under **Authorized JavaScript origins**, add both:

   ```
   https://YOUR-USERNAME.github.io
   http://localhost:8000
   ```

   Leave redirect URIs empty — the app uses the popup token flow, which doesn't need one.

5. Copy the client ID it gives you into [config.js](config.js):

   ```js
   window.DOLLAR_CONFIG = {
     GOOGLE_CLIENT_ID: '1234567890-abcdef.apps.googleusercontent.com'
   };
   ```

6. Push, open the app, go to **Data → Connect Google Drive**, and approve the popup.

A client ID is **not a secret** — it is designed to be visible in public page source, so committing it to a public repo is fine and expected. There is no API key or password in this app at all.

### What to expect day to day

The Data tab shows a coloured dot: green when synced, amber while syncing, red when something needs you. If sync breaks, a small `sync !` marker appears in the header from any tab, so it fails loudly rather than silently.

Access tokens last about an hour and are held in memory only, never written to storage. On iPhone this is the rough edge to expect: Safari's tracking protection often blocks the silent re-auth, so every so often you'll tap **Reconnect**. Entries logged while disconnected are not lost — they sit on the phone and upload on the next successful sync.

Sync **merges** rather than overwrites. Entries are unioned by id, and deletions are tracked as tombstones, so a reinstall pulls your history back and an entry you delete does not reappear from the copy in Drive.

## Install It On Your Phone

**Android (Chrome):** open the URL, tap the ⋮ menu, then "Add to Home screen" or "Install app".

**iPhone (Safari — it must be Safari, Chrome on iOS can't do this):** open the URL, tap the Share button, scroll down, tap "Add to Home Screen".

Either way you get an icon that launches full-screen with no address bar, and it opens with no connection.

## Where Your Data Lives

Entries are held in `localStorage` in the browser you logged them from. Nothing is uploaded anywhere, which is the point — but it has consequences worth knowing before you rely on it:

- It **does not sync by itself** unless you connect Google Drive. Without that, logging on your phone and your laptop gives you two separate histories.
- Clearing browsing data, site data, or "storage for this site" **deletes every entry**.
- On iOS, Safari deletes a site's storage after **7 days of Safari use without you interacting with that site** (not 7 calendar days — days you don't open Safari at all don't count). This is WebKit's [ITP 7-day cap](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/), and it applies to localStorage. Adding the app to your home screen matters here: home-screen web apps get their own use counter, which resets every time you open the app. Open it weekly and the timer never runs out.
- Uninstalling the home-screen app can take the data with it.

None of that is a problem if you export or back up now and then. A monthly habit — hit Export at the end of each month and keep the CSV — means the worst case is losing a few weeks, and you end up with a spreadsheet history as a bonus.

## Project Layout

- `index.html` — the markup and all four screens
- `styles.css` — the styling and theme variables
- `app.js` — all the logic: storage, views, CSV, merge
- `drive.js` — Google Drive auth and sync, kept separate from the app logic
- `config.js` — your Google client ID (the only thing you edit to enable sync)
- `sw.js` — the offline cache
- `manifest.webmanifest` — the install metadata
- `icons/` — the app icons
