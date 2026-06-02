CREATE TABLE IF NOT EXISTS memory_relations (
  sync_id          TEXT PRIMARY KEY,
  source_type      TEXT NOT NULL,
  source_id        TEXT NOT NULL,
  target_type      TEXT NOT NULL,
  target_id        TEXT NOT NULL,
  relation         TEXT NOT NULL CHECK (relation IN (
                     'implements', 'depends_on', 'conflicts_with', 'replaces',
                     'references', 'structural_sibling', 'topically_related',
                     'variant_of', 'semantically_related'
                   )),
  reason           TEXT NOT NULL DEFAULT '',
  evidence         TEXT NOT NULL DEFAULT '',
  confidence       REAL NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0.0 AND 1.0),
  judgment_status  TEXT NOT NULL DEFAULT 'pending'
                     CHECK (judgment_status IN ('pending', 'accepted', 'rejected')),
  marked_by_actor  TEXT NOT NULL DEFAULT '',
  marked_by_kind   TEXT NOT NULL DEFAULT 'auto',
  marked_by_model  TEXT NOT NULL DEFAULT '',
  session_id       TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS memory_relations_source_idx
  ON memory_relations(source_type, source_id);
CREATE INDEX IF NOT EXISTS memory_relations_target_idx
  ON memory_relations(target_type, target_id);
CREATE INDEX IF NOT EXISTS memory_relations_judgment_idx
  ON memory_relations(judgment_status, confidence);
