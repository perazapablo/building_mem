CREATE TABLE IF NOT EXISTS events (
  id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  entity_type    TEXT NOT NULL,
  entity_id      TEXT NOT NULL,
  op             TEXT NOT NULL CHECK (op IN ('insert', 'update', 'delete')),
  payload_before TEXT,
  payload_after  TEXT,
  ts             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS events_entity_idx ON events(entity_type, entity_id, ts);

CREATE TRIGGER IF NOT EXISTS sessions_events_ai AFTER INSERT ON sessions BEGIN
  INSERT INTO events(entity_type, entity_id, op, payload_after)
  VALUES ('session', new.id, 'insert', json_object('id', new.id, 'title', new.title, 'summary', new.summary, 'project_id', new.project_id, 'created_at', new.created_at, 'updated_at', new.updated_at));
END;
CREATE TRIGGER IF NOT EXISTS sessions_events_au AFTER UPDATE ON sessions BEGIN
  INSERT INTO events(entity_type, entity_id, op, payload_before, payload_after)
  VALUES ('session', old.id, 'update',
    json_object('id', old.id, 'title', old.title, 'summary', old.summary, 'project_id', old.project_id, 'created_at', old.created_at, 'updated_at', old.updated_at),
    json_object('id', new.id, 'title', new.title, 'summary', new.summary, 'project_id', new.project_id, 'created_at', new.created_at, 'updated_at', new.updated_at));
END;
CREATE TRIGGER IF NOT EXISTS sessions_events_ad AFTER DELETE ON sessions BEGIN
  INSERT INTO events(entity_type, entity_id, op, payload_before)
  VALUES ('session', old.id, 'delete', json_object('id', old.id, 'title', old.title, 'summary', old.summary, 'project_id', old.project_id, 'created_at', old.created_at, 'updated_at', old.updated_at));
END;

CREATE TRIGGER IF NOT EXISTS projects_events_ai AFTER INSERT ON projects BEGIN
  INSERT INTO events(entity_type, entity_id, op, payload_after)
  VALUES ('project', new.id, 'insert', json_object('id', new.id, 'name', new.name, 'description', new.description, 'project_type', new.project_type, 'tags', new.tags, 'created_at', new.created_at, 'updated_at', new.updated_at));
END;
CREATE TRIGGER IF NOT EXISTS projects_events_au AFTER UPDATE ON projects BEGIN
  INSERT INTO events(entity_type, entity_id, op, payload_before, payload_after)
  VALUES ('project', old.id, 'update',
    json_object('id', old.id, 'name', old.name, 'description', old.description, 'project_type', old.project_type, 'tags', old.tags, 'created_at', old.created_at, 'updated_at', old.updated_at),
    json_object('id', new.id, 'name', new.name, 'description', new.description, 'project_type', new.project_type, 'tags', new.tags, 'created_at', new.created_at, 'updated_at', new.updated_at));
END;
CREATE TRIGGER IF NOT EXISTS projects_events_ad AFTER DELETE ON projects BEGIN
  INSERT INTO events(entity_type, entity_id, op, payload_before)
  VALUES ('project', old.id, 'delete', json_object('id', old.id, 'name', old.name, 'description', old.description, 'project_type', old.project_type, 'tags', old.tags, 'created_at', old.created_at, 'updated_at', old.updated_at));
END;

CREATE TRIGGER IF NOT EXISTS notes_events_ai AFTER INSERT ON notes BEGIN
  INSERT INTO events(entity_type, entity_id, op, payload_after)
  VALUES ('note', new.id, 'insert', json_object('id', new.id, 'project_id', new.project_id, 'content', new.content, 'tags', new.tags, 'status', new.status, 'importance', new.importance, 'obsolete_reason', new.obsolete_reason, 'created_at', new.created_at, 'updated_at', new.updated_at));
END;
CREATE TRIGGER IF NOT EXISTS notes_events_au AFTER UPDATE ON notes BEGIN
  INSERT INTO events(entity_type, entity_id, op, payload_before, payload_after)
  VALUES ('note', old.id, 'update',
    json_object('id', old.id, 'project_id', old.project_id, 'content', old.content, 'tags', old.tags, 'status', old.status, 'importance', old.importance, 'obsolete_reason', old.obsolete_reason, 'created_at', old.created_at, 'updated_at', old.updated_at),
    json_object('id', new.id, 'project_id', new.project_id, 'content', new.content, 'tags', new.tags, 'status', new.status, 'importance', new.importance, 'obsolete_reason', new.obsolete_reason, 'created_at', new.created_at, 'updated_at', new.updated_at));
END;
CREATE TRIGGER IF NOT EXISTS notes_events_ad AFTER DELETE ON notes BEGIN
  INSERT INTO events(entity_type, entity_id, op, payload_before)
  VALUES ('note', old.id, 'delete', json_object('id', old.id, 'project_id', old.project_id, 'content', old.content, 'tags', old.tags, 'status', old.status, 'importance', old.importance, 'obsolete_reason', old.obsolete_reason, 'created_at', old.created_at, 'updated_at', old.updated_at));
END;

CREATE TRIGGER IF NOT EXISTS decisions_events_ai AFTER INSERT ON decisions BEGIN
  INSERT INTO events(entity_type, entity_id, op, payload_after)
  VALUES ('decision', new.id, 'insert', json_object('id', new.id, 'project_id', new.project_id, 'decision', new.decision, 'reasoning', new.reasoning, 'status', new.status, 'importance', new.importance, 'obsolete_reason', new.obsolete_reason, 'created_at', new.created_at, 'updated_at', new.updated_at));
END;
CREATE TRIGGER IF NOT EXISTS decisions_events_au AFTER UPDATE ON decisions BEGIN
  INSERT INTO events(entity_type, entity_id, op, payload_before, payload_after)
  VALUES ('decision', old.id, 'update',
    json_object('id', old.id, 'project_id', old.project_id, 'decision', old.decision, 'reasoning', old.reasoning, 'status', old.status, 'importance', old.importance, 'obsolete_reason', old.obsolete_reason, 'created_at', old.created_at, 'updated_at', old.updated_at),
    json_object('id', new.id, 'project_id', new.project_id, 'decision', new.decision, 'reasoning', new.reasoning, 'status', new.status, 'importance', new.importance, 'obsolete_reason', new.obsolete_reason, 'created_at', new.created_at, 'updated_at', new.updated_at));
END;
CREATE TRIGGER IF NOT EXISTS decisions_events_ad AFTER DELETE ON decisions BEGIN
  INSERT INTO events(entity_type, entity_id, op, payload_before)
  VALUES ('decision', old.id, 'delete', json_object('id', old.id, 'project_id', old.project_id, 'decision', old.decision, 'reasoning', old.reasoning, 'status', old.status, 'importance', old.importance, 'obsolete_reason', old.obsolete_reason, 'created_at', old.created_at, 'updated_at', old.updated_at));
END;

CREATE TRIGGER IF NOT EXISTS artifacts_events_ai AFTER INSERT ON artifacts BEGIN
  INSERT INTO events(entity_type, entity_id, op, payload_after)
  VALUES ('artifact', new.id, 'insert', json_object('id', new.id, 'project_id', new.project_id, 'type', new.type, 'content', new.content, 'status', new.status, 'importance', new.importance, 'obsolete_reason', new.obsolete_reason, 'created_at', new.created_at, 'updated_at', new.updated_at));
END;
CREATE TRIGGER IF NOT EXISTS artifacts_events_au AFTER UPDATE ON artifacts BEGIN
  INSERT INTO events(entity_type, entity_id, op, payload_before, payload_after)
  VALUES ('artifact', old.id, 'update',
    json_object('id', old.id, 'project_id', old.project_id, 'type', old.type, 'content', old.content, 'status', old.status, 'importance', old.importance, 'obsolete_reason', old.obsolete_reason, 'created_at', old.created_at, 'updated_at', old.updated_at),
    json_object('id', new.id, 'project_id', new.project_id, 'type', new.type, 'content', new.content, 'status', new.status, 'importance', new.importance, 'obsolete_reason', new.obsolete_reason, 'created_at', new.created_at, 'updated_at', new.updated_at));
END;
CREATE TRIGGER IF NOT EXISTS artifacts_events_ad AFTER DELETE ON artifacts BEGIN
  INSERT INTO events(entity_type, entity_id, op, payload_before)
  VALUES ('artifact', old.id, 'delete', json_object('id', old.id, 'project_id', old.project_id, 'type', old.type, 'content', old.content, 'status', old.status, 'importance', old.importance, 'obsolete_reason', old.obsolete_reason, 'created_at', old.created_at, 'updated_at', old.updated_at));
END;

CREATE TRIGGER IF NOT EXISTS links_events_ai AFTER INSERT ON links BEGIN
  INSERT INTO events(entity_type, entity_id, op, payload_after)
  VALUES ('link', new.id, 'insert', json_object('id', new.id, 'from_type', new.from_type, 'from_id', new.from_id, 'to_type', new.to_type, 'to_id', new.to_id, 'created_at', new.created_at));
END;
CREATE TRIGGER IF NOT EXISTS links_events_ad AFTER DELETE ON links BEGIN
  INSERT INTO events(entity_type, entity_id, op, payload_before)
  VALUES ('link', old.id, 'delete', json_object('id', old.id, 'from_type', old.from_type, 'from_id', old.from_id, 'to_type', old.to_type, 'to_id', old.to_id, 'created_at', old.created_at));
END;
