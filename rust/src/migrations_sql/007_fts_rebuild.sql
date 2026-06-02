DROP TRIGGER IF EXISTS notes_ai;
DROP TRIGGER IF EXISTS notes_ad;
DROP TRIGGER IF EXISTS notes_au;
DROP TRIGGER IF EXISTS decisions_fts_ai;
DROP TRIGGER IF EXISTS decisions_fts_ad;
DROP TRIGGER IF EXISTS decisions_fts_au;
DROP TRIGGER IF EXISTS artifacts_fts_ai;
DROP TRIGGER IF EXISTS artifacts_fts_ad;
DROP TRIGGER IF EXISTS artifacts_fts_au;
DROP TRIGGER IF EXISTS code_entities_fts_ai;
DROP TRIGGER IF EXISTS code_entities_fts_ad;
DROP TRIGGER IF EXISTS code_entities_fts_au;

DROP TABLE IF EXISTS notes_fts;
DROP TABLE IF EXISTS decisions_fts;
DROP TABLE IF EXISTS artifacts_fts;
DROP TABLE IF EXISTS code_entities_fts;

CREATE VIRTUAL TABLE notes_fts
  USING fts5(content, tags, topic_key, content=notes, content_rowid=rowid);
CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, content, tags, topic_key)
  VALUES (new.rowid, new.content, new.tags, new.topic_key);
END;
CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, content, tags, topic_key)
  VALUES ('delete', old.rowid, old.content, old.tags, old.topic_key);
END;
CREATE TRIGGER notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, content, tags, topic_key)
  VALUES ('delete', old.rowid, old.content, old.tags, old.topic_key);
  INSERT INTO notes_fts(rowid, content, tags, topic_key)
  VALUES (new.rowid, new.content, new.tags, new.topic_key);
END;

CREATE VIRTUAL TABLE decisions_fts
  USING fts5(decision, reasoning, topic_key, content=decisions, content_rowid=rowid);
CREATE TRIGGER decisions_fts_ai AFTER INSERT ON decisions BEGIN
  INSERT INTO decisions_fts(rowid, decision, reasoning, topic_key)
  VALUES (new.rowid, new.decision, new.reasoning, new.topic_key);
END;
CREATE TRIGGER decisions_fts_ad AFTER DELETE ON decisions BEGIN
  INSERT INTO decisions_fts(decisions_fts, rowid, decision, reasoning, topic_key)
  VALUES ('delete', old.rowid, old.decision, old.reasoning, old.topic_key);
END;
CREATE TRIGGER decisions_fts_au AFTER UPDATE ON decisions BEGIN
  INSERT INTO decisions_fts(decisions_fts, rowid, decision, reasoning, topic_key)
  VALUES ('delete', old.rowid, old.decision, old.reasoning, old.topic_key);
  INSERT INTO decisions_fts(rowid, decision, reasoning, topic_key)
  VALUES (new.rowid, new.decision, new.reasoning, new.topic_key);
END;

CREATE VIRTUAL TABLE artifacts_fts
  USING fts5(type, content, topic_key, content=artifacts, content_rowid=rowid);
CREATE TRIGGER artifacts_fts_ai AFTER INSERT ON artifacts BEGIN
  INSERT INTO artifacts_fts(rowid, type, content, topic_key)
  VALUES (new.rowid, new.type, new.content, new.topic_key);
END;
CREATE TRIGGER artifacts_fts_ad AFTER DELETE ON artifacts BEGIN
  INSERT INTO artifacts_fts(artifacts_fts, rowid, type, content, topic_key)
  VALUES ('delete', old.rowid, old.type, old.content, old.topic_key);
END;
CREATE TRIGGER artifacts_fts_au AFTER UPDATE ON artifacts BEGIN
  INSERT INTO artifacts_fts(artifacts_fts, rowid, type, content, topic_key)
  VALUES ('delete', old.rowid, old.type, old.content, old.topic_key);
  INSERT INTO artifacts_fts(rowid, type, content, topic_key)
  VALUES (new.rowid, new.type, new.content, new.topic_key);
END;

CREATE VIRTUAL TABLE code_entities_fts
  USING fts5(kind, name, qualified_name, path, signature, summary, inputs, outputs, side_effects, tags, topic_key, content=code_entities, content_rowid=rowid);
CREATE TRIGGER code_entities_fts_ai AFTER INSERT ON code_entities BEGIN
  INSERT INTO code_entities_fts(rowid, kind, name, qualified_name, path, signature, summary, inputs, outputs, side_effects, tags, topic_key)
  VALUES (new.rowid, new.kind, new.name, new.qualified_name, new.path, new.signature, new.summary, new.inputs, new.outputs, new.side_effects, new.tags, new.topic_key);
END;
CREATE TRIGGER code_entities_fts_ad AFTER DELETE ON code_entities BEGIN
  INSERT INTO code_entities_fts(code_entities_fts, rowid, kind, name, qualified_name, path, signature, summary, inputs, outputs, side_effects, tags, topic_key)
  VALUES ('delete', old.rowid, old.kind, old.name, old.qualified_name, old.path, old.signature, old.summary, old.inputs, old.outputs, old.side_effects, old.tags, old.topic_key);
END;
CREATE TRIGGER code_entities_fts_au AFTER UPDATE ON code_entities BEGIN
  INSERT INTO code_entities_fts(code_entities_fts, rowid, kind, name, qualified_name, path, signature, summary, inputs, outputs, side_effects, tags, topic_key)
  VALUES ('delete', old.rowid, old.kind, old.name, old.qualified_name, old.path, old.signature, old.summary, old.inputs, old.outputs, old.side_effects, old.tags, old.topic_key);
  INSERT INTO code_entities_fts(rowid, kind, name, qualified_name, path, signature, summary, inputs, outputs, side_effects, tags, topic_key)
  VALUES (new.rowid, new.kind, new.name, new.qualified_name, new.path, new.signature, new.summary, new.inputs, new.outputs, new.side_effects, new.tags, new.topic_key);
END;

INSERT INTO notes_fts(notes_fts) VALUES ('rebuild');
INSERT INTO decisions_fts(decisions_fts) VALUES ('rebuild');
INSERT INTO artifacts_fts(artifacts_fts) VALUES ('rebuild');
INSERT INTO code_entities_fts(code_entities_fts) VALUES ('rebuild');
