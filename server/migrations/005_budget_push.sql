-- Budget moves to the server: it has to know the budget to send alerts, and
-- it fixes the "budget lost on reinstall" gap as a side effect.
CREATE TABLE IF NOT EXISTS user_settings (
  user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  budget_cents  INTEGER NOT NULL DEFAULT 0,
  rollover      INTEGER NOT NULL DEFAULT 0,
  budget_since  TEXT,                -- 'YYYY-MM' the budget was first set; nothing rolls over from before it
  tz            TEXT NOT NULL DEFAULT 'UTC',
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per device that allowed notifications.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint      TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh        TEXT NOT NULL,
  auth          TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions (user_id);

-- Which alerts already fired, so crossing 80% notifies once per month, not on
-- every purchase after it.
CREATE TABLE IF NOT EXISTS alerts_sent (
  user_id  TEXT NOT NULL,
  month    TEXT NOT NULL,
  kind     TEXT NOT NULL,
  sent_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, month, kind)
);
