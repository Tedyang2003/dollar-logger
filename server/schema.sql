-- Dollar Logger schema (SQLite / Cloudflare D1)
-- Apply with:  npm run db:local   (or db:remote once deployed)

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,           -- Google's 'sub' claim, not an email
  email       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),

  -- Unix seconds. Sessions issued before this are dead; signing out
  -- everywhere moves it to now. Without it, "sign out" is a lie.
  sessions_valid_from INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS entries (
  id            TEXT PRIMARY KEY,         -- generated on the phone, not by the DB
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  date          TEXT NOT NULL CHECK (date LIKE '____-__-__'),
  amount_cents  INTEGER NOT NULL CHECK (amount_cents > 0),
  category      TEXT NOT NULL,
  item          TEXT NOT NULL DEFAULT '',   -- what was bought

  receipt_id    TEXT,                     -- reserved: filled in when scanning lands

  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at    TEXT                      -- soft delete: NULL means live
);

-- Every read is "this user, this date range", so user_id must come first.
CREATE INDEX IF NOT EXISTS idx_entries_user_date
  ON entries (user_id, date);

-- Powers delta sync: "everything of mine that changed since X".
CREATE INDEX IF NOT EXISTS idx_entries_user_updated
  ON entries (user_id, updated_at);
