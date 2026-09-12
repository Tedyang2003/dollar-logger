-- Recurring purchases. The server generates their entries on a schedule, so
-- they appear even if the phone never opens the app.
CREATE TABLE IF NOT EXISTS subscriptions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item          TEXT NOT NULL,
  merchant      TEXT NOT NULL DEFAULT '',
  category      TEXT NOT NULL,
  amount_cents  INTEGER NOT NULL CHECK (amount_cents > 0),
  interval      TEXT NOT NULL CHECK (interval IN ('weekly', 'monthly', 'yearly')),
  -- Occurrences are counted from the anchor rather than chained from the last
  -- one, so a 31st-of-the-month charge returns to the 31st after February.
  anchor_date   TEXT NOT NULL CHECK (anchor_date LIKE '____-__-__'),
  generated     INTEGER NOT NULL DEFAULT 0,
  tz            TEXT NOT NULL DEFAULT 'UTC',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  cancelled_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_subs_active ON subscriptions (cancelled_at);

-- Tags generated entries with the subscription that made them.
ALTER TABLE entries ADD COLUMN subscription_id TEXT;
