-- Decision records: append-only ADR chains captured in the moment.
--
-- Replaces the upsert semantics of `decisions` (topic_key collision UPDATEs
-- the row, destroying history) with immutable records linked by
-- supersedes/superseded_by. `topic_key` identifies the CHAIN, not the row;
-- the tip is the single `status='active'` record per (project_id, topic_key),
-- enforced by a partial unique index — not by protocol prose.
--
-- The legacy `decisions` table stays frozen as a read-only snapshot (the
-- viewer still reads it until its redesign). Active legacy rows are migrated
-- below as single-link chains keeping their original ids, so existing
-- links/memory_relations remain valid.

CREATE TABLE decision_records (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  topic_key     TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  -- Sin 'verification' a propósito: esa fase no captura decisiones (una
  -- desviación tardía se registra en implementation o tras un rollback).
  -- Si el harness habilitara captura ahí, hay que ampliar este CHECK primero.
  phase         TEXT CHECK (phase IN ('exploration', 'planning', 'implementation')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),

  statement          TEXT NOT NULL,
  forces_json        TEXT NOT NULL DEFAULT '[]',
  alternatives_json  TEXT NOT NULL DEFAULT '[]',
  consequences_json  TEXT NOT NULL DEFAULT '[]',

  origin        TEXT NOT NULL CHECK (origin IN ('user_explicit', 'user_implicit', 'agent_inferred')),
  evidence_json TEXT NOT NULL DEFAULT '[]',
  confidence    TEXT NOT NULL CHECK (confidence IN ('decided', 'tentative')),

  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'superseded', 'reverted')),
  status_reason TEXT,
  closed_by_session TEXT,
  supersedes    TEXT,
  superseded_by TEXT,

  -- statement + forces + alternatives + consequences flattened by the repo
  -- layer; what FTS indexes beyond the statement itself.
  search_text   TEXT NOT NULL DEFAULT ''
);

-- One active tip per chain: physically impossible to violate.
CREATE UNIQUE INDEX decision_records_chain_tip_idx
  ON decision_records(project_id, topic_key)
  WHERE status = 'active';

CREATE INDEX decision_records_topic_idx
  ON decision_records(project_id, topic_key, created_at);

-- Append-only: the only mutable fields are the closure fields
-- (status, status_reason, closed_by_session, superseded_by), written once.
CREATE TRIGGER decision_records_immutable BEFORE UPDATE ON decision_records
WHEN new.id IS NOT old.id
  OR new.project_id IS NOT old.project_id
  OR new.topic_key IS NOT old.topic_key
  OR new.session_id IS NOT old.session_id
  OR new.phase IS NOT old.phase
  OR new.created_at IS NOT old.created_at
  OR new.statement IS NOT old.statement
  OR new.forces_json IS NOT old.forces_json
  OR new.alternatives_json IS NOT old.alternatives_json
  OR new.consequences_json IS NOT old.consequences_json
  OR new.origin IS NOT old.origin
  OR new.evidence_json IS NOT old.evidence_json
  OR new.confidence IS NOT old.confidence
  OR new.supersedes IS NOT old.supersedes
  OR new.search_text IS NOT old.search_text
BEGIN
  SELECT RAISE(ABORT, 'decision_records is append-only: only status/status_reason/closed_by_session/superseded_by may change');
END;

-- A closed record (superseded/reverted) is fully frozen, closure fields included.
CREATE TRIGGER decision_records_closed_frozen BEFORE UPDATE ON decision_records
WHEN old.status <> 'active'
BEGIN
  SELECT RAISE(ABORT, 'decision_record is closed: superseded/reverted records are frozen');
END;

CREATE VIRTUAL TABLE decision_records_fts
  USING fts5(statement, search_text, topic_key, content=decision_records, content_rowid=rowid);

CREATE TRIGGER decision_records_fts_ai AFTER INSERT ON decision_records BEGIN
  INSERT INTO decision_records_fts(rowid, statement, search_text, topic_key)
  VALUES (new.rowid, new.statement, new.search_text, new.topic_key);
END;
-- No AFTER UPDATE trigger: every FTS-indexed column is frozen by
-- decision_records_immutable. Delete only happens via project cascade.
CREATE TRIGGER decision_records_fts_ad AFTER DELETE ON decision_records BEGIN
  INSERT INTO decision_records_fts(decision_records_fts, rowid, statement, search_text, topic_key)
  VALUES ('delete', old.rowid, old.statement, old.search_text, old.topic_key);
END;

CREATE TRIGGER decision_records_events_ai AFTER INSERT ON decision_records BEGIN
  INSERT INTO events(entity_type, entity_id, op, payload_after)
  VALUES ('decision_record', new.id, 'insert',
    json_object('id', new.id, 'project_id', new.project_id, 'topic_key', new.topic_key,
                'session_id', new.session_id, 'statement', new.statement, 'origin', new.origin,
                'confidence', new.confidence, 'status', new.status, 'supersedes', new.supersedes,
                'created_at', new.created_at));
END;
CREATE TRIGGER decision_records_events_au AFTER UPDATE ON decision_records BEGIN
  INSERT INTO events(entity_type, entity_id, op, payload_before, payload_after)
  VALUES ('decision_record', old.id, 'update',
    json_object('status', old.status, 'status_reason', old.status_reason, 'closed_by_session', old.closed_by_session, 'superseded_by', old.superseded_by),
    json_object('status', new.status, 'status_reason', new.status_reason, 'closed_by_session', new.closed_by_session, 'superseded_by', new.superseded_by));
END;
CREATE TRIGGER decision_records_events_ad AFTER DELETE ON decision_records BEGIN
  INSERT INTO events(entity_type, entity_id, op, payload_before)
  VALUES ('decision_record', old.id, 'delete',
    json_object('id', old.id, 'project_id', old.project_id, 'topic_key', old.topic_key,
                'statement', old.statement, 'status', old.status));
END;

-- Legacy migration: each active `decisions` row becomes a single-link chain.
-- Same id (existing links/relations stay valid); reasoning preserved as a
-- quote in evidence and kept searchable via search_text; origin is
-- agent_inferred because nobody re-affirmed these — the honest default.
-- Rows with NULL/empty topic_key get a per-row fallback key. MAX(rowid)
-- guards against pre-v7 duplicates sharing an active topic.
INSERT INTO decision_records (
  id, project_id, topic_key, session_id, phase, created_at,
  statement, forces_json, alternatives_json, consequences_json,
  origin, evidence_json, confidence, status, search_text
)
SELECT
  d.id,
  d.project_id,
  COALESCE(NULLIF(d.topic_key, ''), 'legacy-' || d.id),
  'legacy-migration',
  NULL,
  d.created_at,
  d.decision,
  '[]', '[]', '[]',
  'agent_inferred',
  json_array(json_object('kind', 'quote', 'value', d.reasoning)),
  'decided',
  'active',
  d.decision || ' ' || d.reasoning
FROM decisions d
WHERE d.status = 'active'
  AND d.rowid IN (
    SELECT MAX(rowid) FROM decisions
    WHERE status = 'active'
    GROUP BY project_id, COALESCE(NULLIF(topic_key, ''), 'legacy-' || id)
  );
