CREATE TABLE IF NOT EXISTS working_state (
  session_id   TEXT PRIMARY KEY,
  focus        TEXT NOT NULL DEFAULT '',
  open_threads TEXT NOT NULL DEFAULT '[]',
  pinned_ids   TEXT NOT NULL DEFAULT '[]',
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS working_state_updated_idx ON working_state(updated_at);
