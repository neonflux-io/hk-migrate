CREATE TABLE notes (
  id         INTEGER PRIMARY KEY,
  user_id    TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX notes_user_created ON notes (user_id, created_at DESC);
