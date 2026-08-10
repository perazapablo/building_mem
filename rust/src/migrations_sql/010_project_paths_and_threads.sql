-- Multi-path bindings per project. `path_key` is the canonical form
-- (lowercase, forward slashes, no trailing slash) used for matching;
-- `path` preserves the caller's original form for display.
CREATE TABLE IF NOT EXISTS project_paths (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  path_key    TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS project_paths_project_idx ON project_paths(project_id);

-- Threads with explicit lifecycle. Lives at project level so a thread
-- opened in one session survives across sessions until explicitly closed
-- or marked stale by age. `opened_in` / `closed_in` reference sessions
-- for audit but never gate the thread's own lifetime.
CREATE TABLE IF NOT EXISTS project_threads (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  thread        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'done', 'dropped', 'stale')),
  opened_in     TEXT NOT NULL,
  closed_in     TEXT,
  close_reason  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at     TEXT
);
CREATE INDEX IF NOT EXISTS project_threads_project_status_idx
  ON project_threads(project_id, status);
CREATE INDEX IF NOT EXISTS project_threads_updated_idx
  ON project_threads(project_id, updated_at);
