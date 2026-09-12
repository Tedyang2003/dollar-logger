-- Adds session revocation support to an existing database.
-- Safe to run once; re-running errors with "duplicate column name", which is
-- harmless and means it is already applied.
ALTER TABLE users ADD COLUMN sessions_valid_from INTEGER NOT NULL DEFAULT 0;
