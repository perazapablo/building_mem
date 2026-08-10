-- Session focus as a first-class entity, decoupled from working_state.
-- One row per session; upserted by session_id. `project_id` is denormalised
-- to make "last focus for project X" cheap.
CREATE TABLE IF NOT EXISTS session_focus (
  session_id  TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  focus       TEXT NOT NULL,
  set_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS session_focus_project_idx
  ON session_focus(project_id, updated_at);
