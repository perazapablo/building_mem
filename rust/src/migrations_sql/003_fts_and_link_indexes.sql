CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts
  USING fts5(decision, reasoning, content=decisions, content_rowid=rowid);

CREATE TRIGGER IF NOT EXISTS decisions_fts_ai AFTER INSERT ON decisions BEGIN
  INSERT INTO decisions_fts(rowid, decision, reasoning)
  VALUES (new.rowid, new.decision, new.reasoning);
END;

CREATE TRIGGER IF NOT EXISTS decisions_fts_ad AFTER DELETE ON decisions BEGIN
  INSERT INTO decisions_fts(decisions_fts, rowid, decision, reasoning)
  VALUES ('delete', old.rowid, old.decision, old.reasoning);
END;

CREATE TRIGGER IF NOT EXISTS decisions_fts_au AFTER UPDATE ON decisions BEGIN
  INSERT INTO decisions_fts(decisions_fts, rowid, decision, reasoning)
  VALUES ('delete', old.rowid, old.decision, old.reasoning);
  INSERT INTO decisions_fts(rowid, decision, reasoning)
  VALUES (new.rowid, new.decision, new.reasoning);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS artifacts_fts
  USING fts5(type, content, content=artifacts, content_rowid=rowid);

CREATE TRIGGER IF NOT EXISTS artifacts_fts_ai AFTER INSERT ON artifacts BEGIN
  INSERT INTO artifacts_fts(rowid, type, content)
  VALUES (new.rowid, new.type, new.content);
END;

CREATE TRIGGER IF NOT EXISTS artifacts_fts_ad AFTER DELETE ON artifacts BEGIN
  INSERT INTO artifacts_fts(artifacts_fts, rowid, type, content)
  VALUES ('delete', old.rowid, old.type, old.content);
END;

CREATE TRIGGER IF NOT EXISTS artifacts_fts_au AFTER UPDATE ON artifacts BEGIN
  INSERT INTO artifacts_fts(artifacts_fts, rowid, type, content)
  VALUES ('delete', old.rowid, old.type, old.content);
  INSERT INTO artifacts_fts(rowid, type, content)
  VALUES (new.rowid, new.type, new.content);
END;

CREATE INDEX IF NOT EXISTS links_from_idx ON links(from_id, from_type);
CREATE INDEX IF NOT EXISTS links_to_idx ON links(to_id, to_type);

INSERT INTO notes_fts(notes_fts) VALUES ('rebuild');
INSERT INTO decisions_fts(decisions_fts) VALUES ('rebuild');
INSERT INTO artifacts_fts(artifacts_fts) VALUES ('rebuild');
