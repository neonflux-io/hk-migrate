-- Additive and safe to deploy before the code that reads it.
ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
