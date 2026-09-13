-- Rollover only counts months after it was switched on, so months from before
-- (possibly never logged) cannot carry a whole unspent budget forward.
ALTER TABLE user_settings ADD COLUMN rollover_since TEXT;
