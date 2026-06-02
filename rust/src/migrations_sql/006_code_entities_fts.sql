CREATE TABLE IF NOT EXISTS code_entities (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('module', 'file', 'function', 'class', 'method', 'endpoint', 'config', 'schema')),
  name            TEXT NOT NULL,
  qualified_name  TEXT NOT NULL DEFAULT '',
  path            TEXT NOT NULL DEFAULT '',
  signature       TEXT NOT NULL DEFAULT '',
  summary         TEXT NOT NULL DEFAULT '',
  inputs          TEXT NOT NULL DEFAULT '',
  outputs         TEXT NOT NULL DEFAULT '',
  side_effects    TEXT NOT NULL DEFAULT '',
  tags            TEXT NOT NULL DEFAULT '[]',
  status          TEXT NOT NULL DEFAULT 'active',
  importance      INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  obsolete_reason TEXT,
  token_count     INTEGER NOT NULL DEFAULT 0,
  tokenizer_model TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT
);

CREATE INDEX IF NOT EXISTS code_entities_project_idx
  ON code_entities(project_id, status, kind, name);
CREATE INDEX IF NOT EXISTS code_entities_context_rank_idx
  ON code_entities(project_id, status, importance, token_count);

CREATE VIRTUAL TABLE IF NOT EXISTS code_entities_fts
  USING fts5(name, qualified_name, path, signature, summary, inputs, outputs, side_effects, tags, content=code_entities, content_rowid=rowid);

CREATE TRIGGER IF NOT EXISTS code_entities_fts_ai AFTER INSERT ON code_entities BEGIN
  INSERT INTO code_entities_fts(rowid, name, qualified_name, path, signature, summary, inputs, outputs, side_effects, tags)
  VALUES (new.rowid, new.name, new.qualified_name, new.path, new.signature, new.summary, new.inputs, new.outputs, new.side_effects, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS code_entities_fts_ad AFTER DELETE ON code_entities BEGIN
  INSERT INTO code_entities_fts(code_entities_fts, rowid, name, qualified_name, path, signature, summary, inputs, outputs, side_effects, tags)
  VALUES ('delete', old.rowid, old.name, old.qualified_name, old.path, old.signature, old.summary, old.inputs, old.outputs, old.side_effects, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS code_entities_fts_au AFTER UPDATE ON code_entities BEGIN
  INSERT INTO code_entities_fts(code_entities_fts, rowid, name, qualified_name, path, signature, summary, inputs, outputs, side_effects, tags)
  VALUES ('delete', old.rowid, old.name, old.qualified_name, old.path, old.signature, old.summary, old.inputs, old.outputs, old.side_effects, old.tags);
  INSERT INTO code_entities_fts(rowid, name, qualified_name, path, signature, summary, inputs, outputs, side_effects, tags)
  VALUES (new.rowid, new.name, new.qualified_name, new.path, new.signature, new.summary, new.inputs, new.outputs, new.side_effects, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS code_entities_events_ai AFTER INSERT ON code_entities BEGIN
  INSERT INTO events(entity_type, entity_id, op, payload_after)
  VALUES ('code_entity', new.id, 'insert', json_object('id', new.id, 'project_id', new.project_id, 'kind', new.kind, 'name', new.name, 'qualified_name', new.qualified_name, 'path', new.path, 'signature', new.signature, 'summary', new.summary, 'inputs', new.inputs, 'outputs', new.outputs, 'side_effects', new.side_effects, 'tags', new.tags, 'status', new.status, 'importance', new.importance, 'obsolete_reason', new.obsolete_reason, 'created_at', new.created_at, 'updated_at', new.updated_at));
END;

CREATE TRIGGER IF NOT EXISTS code_entities_events_au AFTER UPDATE ON code_entities BEGIN
  INSERT INTO events(entity_type, entity_id, op, payload_before, payload_after)
  VALUES ('code_entity', old.id, 'update',
    json_object('id', old.id, 'project_id', old.project_id, 'kind', old.kind, 'name', old.name, 'qualified_name', old.qualified_name, 'path', old.path, 'signature', old.signature, 'summary', old.summary, 'inputs', old.inputs, 'outputs', old.outputs, 'side_effects', old.side_effects, 'tags', old.tags, 'status', old.status, 'importance', old.importance, 'obsolete_reason', old.obsolete_reason, 'created_at', old.created_at, 'updated_at', old.updated_at),
    json_object('id', new.id, 'project_id', new.project_id, 'kind', new.kind, 'name', new.name, 'qualified_name', new.qualified_name, 'path', new.path, 'signature', new.signature, 'summary', new.summary, 'inputs', new.inputs, 'outputs', new.outputs, 'side_effects', new.side_effects, 'tags', new.tags, 'status', new.status, 'importance', new.importance, 'obsolete_reason', new.obsolete_reason, 'created_at', new.created_at, 'updated_at', new.updated_at));
END;

CREATE TRIGGER IF NOT EXISTS code_entities_events_ad AFTER DELETE ON code_entities BEGIN
  INSERT INTO events(entity_type, entity_id, op, payload_before)
  VALUES ('code_entity', old.id, 'delete', json_object('id', old.id, 'project_id', old.project_id, 'kind', old.kind, 'name', old.name, 'qualified_name', old.qualified_name, 'path', old.path, 'signature', old.signature, 'summary', old.summary, 'inputs', old.inputs, 'outputs', old.outputs, 'side_effects', old.side_effects, 'tags', old.tags, 'status', old.status, 'importance', old.importance, 'obsolete_reason', old.obsolete_reason, 'created_at', old.created_at, 'updated_at', old.updated_at));
END;

INSERT INTO code_entities_fts(code_entities_fts) VALUES ('rebuild');
