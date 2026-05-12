import Database from "better-sqlite3";
import { countTokens as countAnthropicTokens } from "@anthropic-ai/tokenizer";
import { createHash, randomUUID } from "crypto";
import { countTokens as countOpenAiTokens } from "gpt-tokenizer";
import { countTokens as countCl100kTokens } from "gpt-tokenizer/encoding/cl100k_base";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = path.join(__dirname, "..", "memory.db");
const DB_PATH = process.env.MCP_MEMORY_DB_PATH ?? DEFAULT_DB_PATH;

export const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

type Migration = {
  version: number;
  name: string;
  up: () => void;
};

function checksum(migration: Migration) {
  return createHash("sha256")
    .update(`${migration.version}:${migration.name}:${migration.up.toString()}`)
    .digest("hex");
}

function tableExists(table: string) {
  return Boolean(
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
      .get(table),
  );
}

function columnExists(table: string, column: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  return cols.some((c) => c.name === column);
}

function addColumnIfMissing(table: string, column: string, definition: string) {
  if (tableExists(table) && !columnExists(table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function normalizeImportance(importance = 3) {
  return Math.min(5, Math.max(1, Math.trunc(importance)));
}

function normalizeStableText(text: string) {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function hashNormalized(text: string): string {
  return createHash("sha256").update(normalizeStableText(text)).digest("hex");
}

function normalizeTopicKey(key?: string | null): string | null {
  if (!key) return null;
  const normalized = normalizeStableText(key)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return normalized || null;
}

function noteHashSource(content: string) {
  return content;
}

function decisionHashSource(decision: string, reasoning: string) {
  return `${decision}\n${reasoning}`;
}

function artifactHashSource(type: string, content: string) {
  return `${type}\n${content}`;
}

function codeEntityHashSource(row: {
  kind: string;
  name: string;
  qualified_name: string;
  path: string;
  signature: string;
  summary: string;
}) {
  return [
    row.kind,
    row.qualified_name || row.name,
    row.path,
    row.signature,
    row.summary,
  ].join("\n");
}

const CONTEXT_WRAPPER_TOKEN_MARGIN = 128;
const GENERIC_TOKENIZER_MODEL = "generic:conservative";
const SUPPORTED_TOKENIZER_MODELS = new Set([
  "openai:o200k_base",
  "openai:cl100k_base",
  "anthropic:claude",
  GENERIC_TOKENIZER_MODEL,
]);

function resolveTokenizerModel(value?: string) {
  if (!value) return GENERIC_TOKENIZER_MODEL;
  return SUPPORTED_TOKENIZER_MODELS.has(value) ? value : GENERIC_TOKENIZER_MODEL;
}

const TOKENIZER_MODEL = resolveTokenizerModel(process.env.MCP_MEMORY_TOKENIZER);

function countTokens(text: string) {
  if (TOKENIZER_MODEL === "openai:o200k_base") {
    return countOpenAiTokens(text);
  }
  if (TOKENIZER_MODEL === "openai:cl100k_base") {
    return countCl100kTokens(text);
  }
  if (TOKENIZER_MODEL === "anthropic:claude") {
    return countAnthropicTokens(text);
  }
  return Math.max(1, Math.ceil(text.length / 2.5));
}

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function canonicalJson(value: Record<string, unknown>) {
  return JSON.stringify(value);
}

function toFtsQuery(query: string) {
  const terms = query
    .trim()
    .split(/\s+/)
    .map((term) => term.replace(/"/g, "").trim())
    .filter(Boolean);
  if (terms.length === 0) return "";
  return terms.map((term) => `"${term}"`).join(" OR ");
}

type NoteTokenSource = {
  id: string;
  content: string;
  tags: string | string[];
  importance: number;
  topic_key?: string | null;
  revision_count?: number;
};

type DecisionTokenSource = {
  id: string;
  decision: string;
  reasoning: string;
  importance: number;
  topic_key?: string | null;
  revision_count?: number;
};

type ArtifactTokenSource = {
  id: string;
  type: string;
  content: string;
  importance: number;
  topic_key?: string | null;
  revision_count?: number;
};

type CodeEntityKind =
  | "module"
  | "file"
  | "function"
  | "class"
  | "method"
  | "endpoint"
  | "config"
  | "schema";

type CodeEntityTokenSource = {
  id: string;
  kind: CodeEntityKind;
  name: string;
  qualified_name: string;
  path: string;
  signature: string;
  summary: string;
  inputs: string;
  outputs: string;
  side_effects: string;
  tags: string | string[];
  importance: number;
  topic_key?: string | null;
  revision_count?: number;
};

function serializeNoteForContext(row: NoteTokenSource) {
  return canonicalJson({
    type: "note",
    id: row.id,
    importance: row.importance,
    topic_key: row.topic_key ?? null,
    revision_count: row.revision_count ?? 1,
    tags: Array.isArray(row.tags) ? row.tags : parseJsonArray(row.tags),
    content: row.content,
  });
}

function serializeDecisionForContext(row: DecisionTokenSource) {
  return canonicalJson({
    type: "decision",
    id: row.id,
    importance: row.importance,
    topic_key: row.topic_key ?? null,
    revision_count: row.revision_count ?? 1,
    decision: row.decision,
    reasoning: row.reasoning,
  });
}

function serializeArtifactForContext(row: ArtifactTokenSource) {
  return canonicalJson({
    type: "artifact",
    id: row.id,
    importance: row.importance,
    topic_key: row.topic_key ?? null,
    revision_count: row.revision_count ?? 1,
    artifact_type: row.type,
    content: row.content,
  });
}

function serializeCodeEntityForContext(row: CodeEntityTokenSource) {
  return canonicalJson({
    type: "code_entity",
    id: row.id,
    importance: row.importance,
    topic_key: row.topic_key ?? null,
    revision_count: row.revision_count ?? 1,
    kind: row.kind,
    name: row.name,
    qualified_name: row.qualified_name,
    path: row.path,
    signature: row.signature,
    summary: row.summary,
    inputs: row.inputs,
    outputs: row.outputs,
    side_effects: row.side_effects,
    tags: Array.isArray(row.tags) ? row.tags : parseJsonArray(row.tags),
  });
}

function tokenMetadata(serialized: string) {
  return {
    token_count: countTokens(serialized),
    tokenizer_model: TOKENIZER_MODEL,
  };
}

const migrations: Migration[] = [
  {
    version: 1,
    name: "baseline_schema",
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          id          TEXT PRIMARY KEY,
          title       TEXT NOT NULL,
          summary     TEXT NOT NULL,
          project_id  TEXT,
          created_at  TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS projects (
          id           TEXT PRIMARY KEY,
          name         TEXT NOT NULL UNIQUE,
          description  TEXT,
          project_type TEXT NOT NULL DEFAULT 'development',
          tags         TEXT NOT NULL DEFAULT '[]',
          created_at   TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS notes (
          id          TEXT PRIMARY KEY,
          project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          content     TEXT NOT NULL,
          tags        TEXT NOT NULL DEFAULT '[]',
          created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS decisions (
          id          TEXT PRIMARY KEY,
          project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          decision    TEXT NOT NULL,
          reasoning   TEXT NOT NULL,
          created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS artifacts (
          id          TEXT PRIMARY KEY,
          project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          type        TEXT NOT NULL,
          content     TEXT NOT NULL,
          created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS links (
          id          TEXT PRIMARY KEY,
          from_type   TEXT NOT NULL,
          from_id     TEXT NOT NULL,
          to_type     TEXT NOT NULL,
          to_id       TEXT NOT NULL,
          created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts
          USING fts5(content, tags, content=notes, content_rowid=rowid);

        CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
          INSERT INTO notes_fts(rowid, content, tags)
          VALUES (new.rowid, new.content, new.tags);
        END;

        CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
          INSERT INTO notes_fts(notes_fts, rowid, content, tags)
          VALUES ('delete', old.rowid, old.content, old.tags);
        END;

        CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
          INSERT INTO notes_fts(notes_fts, rowid, content, tags)
          VALUES ('delete', old.rowid, old.content, old.tags);
          INSERT INTO notes_fts(rowid, content, tags)
          VALUES (new.rowid, new.content, new.tags);
        END;
      `);
    },
  },
  {
    version: 2,
    name: "status_and_importance",
    up: () => {
      for (const table of ["notes", "decisions", "artifacts"]) {
        addColumnIfMissing(table, "status", "TEXT NOT NULL DEFAULT 'active'");
        addColumnIfMissing(table, "updated_at", "TEXT");
        addColumnIfMissing(table, "obsolete_reason", "TEXT");
        addColumnIfMissing(
          table,
          "importance",
          "INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5)",
        );
      }
    },
  },
  {
    version: 3,
    name: "decisions_artifacts_fts_and_link_indexes",
    up: () => {
      db.exec(`
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
      `);
    },
  },
  {
    version: 4,
    name: "events_audit_log",
    up: () => {
      db.exec(`
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
      `);
    },
  },
  {
    version: 5,
    name: "context_intelligence",
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS working_state (
          session_id   TEXT PRIMARY KEY,
          focus        TEXT NOT NULL DEFAULT '',
          open_threads TEXT NOT NULL DEFAULT '[]',
          pinned_ids   TEXT NOT NULL DEFAULT '[]',
          updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS working_state_updated_idx ON working_state(updated_at);
      `);

      addColumnIfMissing(
        "projects",
        "context_summary",
        "TEXT NOT NULL DEFAULT ''",
      );

      for (const table of ["notes", "decisions", "artifacts"]) {
        addColumnIfMissing(table, "token_count", "INTEGER NOT NULL DEFAULT 0");
        addColumnIfMissing(
          table,
          "tokenizer_model",
          "TEXT NOT NULL DEFAULT ''",
        );
        db.exec(
          `CREATE INDEX IF NOT EXISTS ${table}_context_rank_idx ON ${table}(project_id, status, importance, token_count)`,
        );
      }
    },
  },
  {
    version: 6,
    name: "code_entities_fts",
    up: () => {
      db.exec(`
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
      `);
    },
  },
  {
    version: 7,
    name: "memory_identity_topic_key",
    up: () => {
      for (const table of ["notes", "decisions", "artifacts", "code_entities"]) {
        addColumnIfMissing(table, "content_hash", "TEXT NOT NULL DEFAULT ''");
        addColumnIfMissing(table, "topic_key", "TEXT");
        addColumnIfMissing(
          table,
          "revision_count",
          "INTEGER NOT NULL DEFAULT 1",
        );
        db.exec(`
          CREATE INDEX IF NOT EXISTS ${table}_content_hash_idx
            ON ${table}(project_id, content_hash);
          CREATE INDEX IF NOT EXISTS ${table}_topic_key_idx
            ON ${table}(project_id, topic_key);
          CREATE INDEX IF NOT EXISTS ${table}_topic_key_status_idx
            ON ${table}(project_id, topic_key, status);
        `);
      }

      const updateNoteIdentity = db.prepare(
        `UPDATE notes SET content_hash = ? WHERE id = ?`,
      );
      for (const row of db
        .prepare(`SELECT id, content FROM notes WHERE content_hash = ''`)
        .all() as { id: string; content: string }[]) {
        updateNoteIdentity.run(hashNormalized(noteHashSource(row.content)), row.id);
      }

      const updateDecisionIdentity = db.prepare(
        `UPDATE decisions SET content_hash = ? WHERE id = ?`,
      );
      for (const row of db
        .prepare(
          `SELECT id, decision, reasoning FROM decisions WHERE content_hash = ''`,
        )
        .all() as { id: string; decision: string; reasoning: string }[]) {
        updateDecisionIdentity.run(
          hashNormalized(decisionHashSource(row.decision, row.reasoning)),
          row.id,
        );
      }

      const updateArtifactIdentity = db.prepare(
        `UPDATE artifacts SET content_hash = ? WHERE id = ?`,
      );
      for (const row of db
        .prepare(`SELECT id, type, content FROM artifacts WHERE content_hash = ''`)
        .all() as { id: string; type: string; content: string }[]) {
        updateArtifactIdentity.run(
          hashNormalized(artifactHashSource(row.type, row.content)),
          row.id,
        );
      }

      const updateCodeIdentity = db.prepare(
        `UPDATE code_entities SET content_hash = ?, topic_key = COALESCE(topic_key, ?) WHERE id = ?`,
      );
      for (const row of db
        .prepare(
          `SELECT id, kind, name, qualified_name, path, signature, summary
           FROM code_entities
           WHERE content_hash = '' OR topic_key IS NULL`,
        )
        .all() as {
        id: string;
        kind: string;
        name: string;
        qualified_name: string;
        path: string;
        signature: string;
        summary: string;
      }[]) {
        updateCodeIdentity.run(
          hashNormalized(codeEntityHashSource(row)),
          normalizeTopicKey(row.qualified_name || row.name),
          row.id,
        );
      }

      db.exec(`
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
      `);
    },
  },
  {
    version: 8,
    name: "memory_relations",
    up: () => {
      db.exec(`
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
      `);
    },
  },
  {
    version: 9,
    name: "decision_artifact_tags",
    up: () => {
      for (const table of ["decisions", "artifacts"]) {
        addColumnIfMissing(table, "tags", "TEXT NOT NULL DEFAULT '[]'");
        db.exec(
          `CREATE INDEX IF NOT EXISTS ${table}_tags_idx ON ${table}(project_id, tags)`,
        );
      }
    },
  },
];

function runMigrations() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      checksum   TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Map(
    (
      db.prepare(`SELECT version, checksum FROM schema_migrations`).all() as {
        version: number;
        checksum: string;
      }[]
    ).map((row) => [row.version, row.checksum]),
  );

  const apply = db.transaction((pending: Migration[]) => {
    for (const migration of pending) {
      migration.up();
      db.prepare(
        `INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)`,
      ).run(migration.version, migration.name, checksum(migration));
    }
  });

  const pending: Migration[] = [];
  for (const migration of migrations) {
    const existingChecksum = applied.get(migration.version);
    const currentChecksum = checksum(migration);
    if (existingChecksum && existingChecksum !== currentChecksum) {
      throw new Error(
        `Migration checksum mismatch for version ${migration.version}`,
      );
    }
    if (!existingChecksum) pending.push(migration);
  }

  if (pending.length > 0) {
    apply(pending);
  }
}

runMigrations();

function backfillTokenCounts() {
  const updateNotes = db.prepare(
    `UPDATE notes SET token_count = ?, tokenizer_model = ? WHERE id = ?`,
  );
  const updateDecisions = db.prepare(
    `UPDATE decisions SET token_count = ?, tokenizer_model = ? WHERE id = ?`,
  );
  const updateArtifacts = db.prepare(
    `UPDATE artifacts SET token_count = ?, tokenizer_model = ? WHERE id = ?`,
  );
  const updateCodeEntities = db.prepare(
    `UPDATE code_entities SET token_count = ?, tokenizer_model = ? WHERE id = ?`,
  );

  const tx = db.transaction(() => {
    const notes = db
      .prepare(
        `SELECT id, content, tags, importance, topic_key, revision_count FROM notes WHERE token_count = 0 OR tokenizer_model != ?`,
      )
      .all(TOKENIZER_MODEL) as NoteTokenSource[];
    for (const note of notes) {
      const meta = tokenMetadata(serializeNoteForContext(note));
      updateNotes.run(meta.token_count, meta.tokenizer_model, note.id);
    }

    const decisions = db
      .prepare(
        `SELECT id, decision, reasoning, importance, topic_key, revision_count FROM decisions WHERE token_count = 0 OR tokenizer_model != ?`,
      )
      .all(TOKENIZER_MODEL) as DecisionTokenSource[];
    for (const decision of decisions) {
      const meta = tokenMetadata(serializeDecisionForContext(decision));
      updateDecisions.run(meta.token_count, meta.tokenizer_model, decision.id);
    }

    const artifacts = db
      .prepare(
        `SELECT id, type, content, importance, topic_key, revision_count FROM artifacts WHERE token_count = 0 OR tokenizer_model != ?`,
      )
      .all(TOKENIZER_MODEL) as ArtifactTokenSource[];
    for (const artifact of artifacts) {
      const meta = tokenMetadata(serializeArtifactForContext(artifact));
      updateArtifacts.run(meta.token_count, meta.tokenizer_model, artifact.id);
    }

    if (tableExists("code_entities")) {
      const codeEntities = db
        .prepare(
          `SELECT id, kind, name, qualified_name, path, signature, summary, inputs, outputs, side_effects, tags, importance, topic_key, revision_count
           FROM code_entities
           WHERE token_count = 0 OR tokenizer_model != ?`,
        )
        .all(TOKENIZER_MODEL) as CodeEntityTokenSource[];
      for (const codeEntity of codeEntities) {
        const meta = tokenMetadata(serializeCodeEntityForContext(codeEntity));
        updateCodeEntities.run(
          meta.token_count,
          meta.tokenizer_model,
          codeEntity.id,
        );
      }
    }
  });

  tx();
}
// Solo correr si hay entidades sin tokenizar o con modelo diferente
function needsBackfill(): boolean {
  const count = db
    .prepare(
      `
    SELECT COUNT(*) as n FROM (
      SELECT id FROM notes     WHERE token_count = 0 OR tokenizer_model != ?
      UNION ALL
      SELECT id FROM decisions WHERE token_count = 0 OR tokenizer_model != ?
      UNION ALL
      SELECT id FROM artifacts WHERE token_count = 0 OR tokenizer_model != ?
      UNION ALL
      SELECT id FROM code_entities WHERE token_count = 0 OR tokenizer_model != ?
    )
  `,
    )
    .get(TOKENIZER_MODEL, TOKENIZER_MODEL, TOKENIZER_MODEL, TOKENIZER_MODEL) as {
    n: number;
  };
  return count.n > 0;
}

if (needsBackfill()) backfillTokenCounts();

// ─── Sessions ─────────────────────────────────────────────────────────────────

export function getSessions(limit = 20) {
  return db
    .prepare(
      `SELECT id, title, summary, project_id, created_at, updated_at
       FROM sessions
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(limit);
}

export function getSession(session_id: string) {
  return db
    .prepare(
      `SELECT id, title, summary, project_id, created_at, updated_at
       FROM sessions
       WHERE id = ?`,
    )
    .get(session_id);
}

export function saveSession(
  title: string,
  summary: string,
  project_id?: string,
) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO sessions (id, title, summary, project_id)
     VALUES (?, ?, ?, ?)`,
  ).run(id, title, summary, project_id ?? null);
  return id;
}

export function updateSession(id: string, summary: string) {
  db.prepare(
    `UPDATE sessions SET summary = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(summary, id);
}

function updateSessionCheckpoint(
  id: string,
  project_id: string,
  summary?: string,
) {
  db.prepare(
    `UPDATE sessions
     SET project_id = ?,
         summary = COALESCE(?, summary),
         updated_at = datetime('now')
     WHERE id = ?`,
  ).run(project_id, summary ?? null, id);
}

// ─── Projects ─────────────────────────────────────────────────────────────────

export function upsertProject(
  name: string,
  description: string,
  project_type: string,
  tags: string[],
) {
  const existing = db
    .prepare(`SELECT id FROM projects WHERE name = ?`)
    .get(name) as { id: string } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE projects SET description = ?, project_type = ?, tags = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(description, project_type, JSON.stringify(tags), existing.id);
    return { id: existing.id, existed: true };
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO projects (id, name, description, project_type, tags) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, name, description, project_type, JSON.stringify(tags));
  return { id, existed: false };
}

export function getProject(project_id: string) {
  return db.prepare(`SELECT * FROM projects WHERE id = ?`).get(project_id);
}

function findActiveByTopic(table: string, project_id: string, topic_key: string) {
  return db
    .prepare(
      `SELECT id FROM ${table}
       WHERE project_id = ? AND topic_key = ? AND status = 'active'
       ORDER BY revision_count DESC, COALESCE(updated_at, created_at) DESC
       LIMIT 1`,
    )
    .get(project_id, topic_key) as { id: string } | undefined;
}

function findActiveByHash(table: string, project_id: string, content_hash: string) {
  return db
    .prepare(
      `SELECT id FROM ${table}
       WHERE project_id = ? AND content_hash = ? AND status = 'active'
       ORDER BY revision_count DESC, COALESCE(updated_at, created_at) DESC
       LIMIT 1`,
    )
    .get(project_id, content_hash) as { id: string } | undefined;
}

// ─── Notes ────────────────────────────────────────────────────────────────────

export function addNote(
  project_id: string,
  content: string,
  tags: string[],
  importance = 3,
  topic_key?: string | null,
) {
  const id = randomUUID();
  const normalizedImportance = normalizeImportance(importance);
  const finalTopicKey = normalizeTopicKey(topic_key);
  const contentHash = hashNormalized(noteHashSource(content));
  const collision = finalTopicKey
    ? findActiveByTopic("notes", project_id, finalTopicKey)
    : findActiveByHash("notes", project_id, contentHash);
  if (collision) {
    updateNote(collision.id, content, tags, normalizedImportance, finalTopicKey);
    return collision.id;
  }
  const meta = tokenMetadata(
    serializeNoteForContext({
      id,
      content,
      tags,
      importance: normalizedImportance,
      topic_key: finalTopicKey,
      revision_count: 1,
    }),
  );
  db.prepare(
    `INSERT INTO notes (id, project_id, content, tags, importance, token_count, tokenizer_model, content_hash, topic_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    project_id,
    content,
    JSON.stringify(tags),
    normalizedImportance,
    meta.token_count,
    meta.tokenizer_model,
    contentHash,
    finalTopicKey,
  );
  runAutoLinkRules(id, "note", project_id);
  return id;
}

export function searchNotes(
  query: string,
  project_id?: string,
  limit = 5,
  include_obsolete = false,
) {
  const statusClause = include_obsolete ? "" : "AND n.status = 'active'";
  if (project_id) {
    return db
      .prepare(
        `SELECT n.id, n.project_id, n.content, n.tags, n.topic_key, n.revision_count, n.status, n.importance, n.created_at, n.updated_at
         FROM notes_fts f
         JOIN notes n ON f.rowid = n.rowid
         WHERE notes_fts MATCH ? AND n.project_id = ? ${statusClause}
         ORDER BY rank
         LIMIT ?`,
      )
      .all(query, project_id, limit);
  }
  return db
    .prepare(
      `SELECT n.id, n.project_id, n.content, n.tags, n.topic_key, n.revision_count, n.status, n.importance, n.created_at, n.updated_at
       FROM notes_fts f
       JOIN notes n ON f.rowid = n.rowid
       WHERE notes_fts MATCH ? ${statusClause}
       ORDER BY rank
       LIMIT ?`,
    )
    .all(query, limit);
}

export function updateNote(
  id: string,
  content?: string,
  tags?: string[],
  importance?: number,
  topic_key?: string | null,
) {
  if (
    content === undefined &&
    tags === undefined &&
    importance === undefined &&
    topic_key === undefined
  )
    return;
  const existing = db
    .prepare(`SELECT id, content, tags, importance, topic_key, revision_count FROM notes WHERE id = ?`)
    .get(id) as NoteTokenSource | undefined;
  if (!existing) return;

  const finalTopicKey =
    topic_key === undefined
      ? existing.topic_key ?? null
      : normalizeTopicKey(topic_key);
  const next = {
    id,
    content: content ?? existing.content,
    tags: tags ?? parseJsonArray(existing.tags as string),
    importance:
      importance === undefined
        ? existing.importance
        : normalizeImportance(importance),
    topic_key: finalTopicKey,
    revision_count: (existing.revision_count ?? 1) + 1,
  };
  const contentHash = hashNormalized(noteHashSource(next.content));
  const meta = tokenMetadata(serializeNoteForContext(next));
  db.prepare(
    `UPDATE notes
     SET content = COALESCE(?, content),
         tags = COALESCE(?, tags),
         importance = COALESCE(?, importance),
         content_hash = ?,
         topic_key = ?,
         revision_count = revision_count + 1,
         token_count = ?,
         tokenizer_model = ?,
         updated_at = datetime('now')
     WHERE id = ?`,
  ).run(
    content ?? null,
    tags === undefined ? null : JSON.stringify(tags),
    importance === undefined ? null : normalizeImportance(importance),
    contentHash,
    finalTopicKey,
    meta.token_count,
    meta.tokenizer_model,
    id,
  );
}

export function deleteNote(id: string) {
  db.prepare(`DELETE FROM notes WHERE id = ?`).run(id);
}

// ─── Decisions ────────────────────────────────────────────────────────────────

export function addDecision(
  project_id: string,
  decision: string,
  reasoning: string,
  importance = 3,
  topic_key?: string | null,
) {
  const id = randomUUID();
  const normalizedImportance = normalizeImportance(importance);
  const finalTopicKey = normalizeTopicKey(topic_key);
  const contentHash = hashNormalized(decisionHashSource(decision, reasoning));
  const collision = finalTopicKey
    ? findActiveByTopic("decisions", project_id, finalTopicKey)
    : findActiveByHash("decisions", project_id, contentHash);
  if (collision) {
    updateDecision(
      collision.id,
      decision,
      reasoning,
      normalizedImportance,
      finalTopicKey,
    );
    return collision.id;
  }
  const meta = tokenMetadata(
    serializeDecisionForContext({
      id,
      decision,
      reasoning,
      importance: normalizedImportance,
      topic_key: finalTopicKey,
      revision_count: 1,
    }),
  );
  db.prepare(
    `INSERT INTO decisions (id, project_id, decision, reasoning, importance, token_count, tokenizer_model, content_hash, topic_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    project_id,
    decision,
    reasoning,
    normalizedImportance,
    meta.token_count,
    meta.tokenizer_model,
    contentHash,
    finalTopicKey,
  );
  runAutoLinkRules(id, "decision", project_id);
  return id;
}

export function updateDecision(
  id: string,
  decision?: string,
  reasoning?: string,
  importance?: number,
  topic_key?: string | null,
) {
  if (
    decision === undefined &&
    reasoning === undefined &&
    importance === undefined &&
    topic_key === undefined
  )
    return;
  const existing = db
    .prepare(
      `SELECT id, decision, reasoning, importance, topic_key, revision_count FROM decisions WHERE id = ?`,
    )
    .get(id) as DecisionTokenSource | undefined;
  if (!existing) return;

  const finalTopicKey =
    topic_key === undefined
      ? existing.topic_key ?? null
      : normalizeTopicKey(topic_key);
  const next = {
    id,
    decision: decision ?? existing.decision,
    reasoning: reasoning ?? existing.reasoning,
    importance:
      importance === undefined
        ? existing.importance
        : normalizeImportance(importance),
    topic_key: finalTopicKey,
    revision_count: (existing.revision_count ?? 1) + 1,
  };
  const contentHash = hashNormalized(
    decisionHashSource(next.decision, next.reasoning),
  );
  const meta = tokenMetadata(serializeDecisionForContext(next));
  db.prepare(
    `UPDATE decisions
     SET decision = COALESCE(?, decision),
         reasoning = COALESCE(?, reasoning),
         importance = COALESCE(?, importance),
         content_hash = ?,
         topic_key = ?,
         revision_count = revision_count + 1,
         token_count = ?,
         tokenizer_model = ?,
         updated_at = datetime('now')
     WHERE id = ?`,
  ).run(
    decision ?? null,
    reasoning ?? null,
    importance === undefined ? null : normalizeImportance(importance),
    contentHash,
    finalTopicKey,
    meta.token_count,
    meta.tokenizer_model,
    id,
  );
}

export function deleteDecision(id: string) {
  db.prepare(`DELETE FROM decisions WHERE id = ?`).run(id);
}

// ─── Artifacts ────────────────────────────────────────────────────────────────

export function addArtifact(
  project_id: string,
  type: string,
  content: string,
  importance = 3,
  topic_key?: string | null,
) {
  const id = randomUUID();
  const normalizedImportance = normalizeImportance(importance);
  const finalTopicKey = normalizeTopicKey(topic_key);
  const contentHash = hashNormalized(artifactHashSource(type, content));
  const collision = finalTopicKey
    ? findActiveByTopic("artifacts", project_id, finalTopicKey)
    : findActiveByHash("artifacts", project_id, contentHash);
  if (collision) {
    updateArtifact(collision.id, type, content, normalizedImportance, finalTopicKey);
    return collision.id;
  }
  const meta = tokenMetadata(
    serializeArtifactForContext({
      id,
      type,
      content,
      importance: normalizedImportance,
      topic_key: finalTopicKey,
      revision_count: 1,
    }),
  );
  db.prepare(
    `INSERT INTO artifacts (id, project_id, type, content, importance, token_count, tokenizer_model, content_hash, topic_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    project_id,
    type,
    content,
    normalizedImportance,
    meta.token_count,
    meta.tokenizer_model,
    contentHash,
    finalTopicKey,
  );
  runAutoLinkRules(id, "artifact", project_id);
  return id;
}

export function updateArtifact(
  id: string,
  type?: string,
  content?: string,
  importance?: number,
  topic_key?: string | null,
) {
  if (
    type === undefined &&
    content === undefined &&
    importance === undefined &&
    topic_key === undefined
  )
    return;
  const existing = db
    .prepare(`SELECT id, type, content, importance, topic_key, revision_count FROM artifacts WHERE id = ?`)
    .get(id) as ArtifactTokenSource | undefined;
  if (!existing) return;

  const finalTopicKey =
    topic_key === undefined
      ? existing.topic_key ?? null
      : normalizeTopicKey(topic_key);
  const next = {
    id,
    type: type ?? existing.type,
    content: content ?? existing.content,
    importance:
      importance === undefined
        ? existing.importance
        : normalizeImportance(importance),
    topic_key: finalTopicKey,
    revision_count: (existing.revision_count ?? 1) + 1,
  };
  const contentHash = hashNormalized(artifactHashSource(next.type, next.content));
  const meta = tokenMetadata(serializeArtifactForContext(next));
  db.prepare(
    `UPDATE artifacts
     SET type = COALESCE(?, type),
         content = COALESCE(?, content),
         importance = COALESCE(?, importance),
         content_hash = ?,
         topic_key = ?,
         revision_count = revision_count + 1,
         token_count = ?,
         tokenizer_model = ?,
         updated_at = datetime('now')
     WHERE id = ?`,
  ).run(
    type ?? null,
    content ?? null,
    importance === undefined ? null : normalizeImportance(importance),
    contentHash,
    finalTopicKey,
    meta.token_count,
    meta.tokenizer_model,
    id,
  );
}

export function deleteArtifact(id: string) {
  db.prepare(`DELETE FROM artifacts WHERE id = ?`).run(id);
}

// ─── Code Entities ───────────────────────────────────────────────────────────

type CodeEntityUpdate = Partial<
  Pick<
    CodeEntityTokenSource,
    | "kind"
    | "name"
    | "qualified_name"
    | "path"
    | "signature"
    | "summary"
    | "inputs"
    | "outputs"
    | "side_effects"
    | "tags"
    | "importance"
    | "topic_key"
  >
>;

export function addCodeEntity(
  project_id: string,
  kind: CodeEntityKind,
  name: string,
  qualified_name = "",
  path = "",
  signature = "",
  summary = "",
  inputs = "",
  outputs = "",
  side_effects = "",
  tags: string[] = [],
  importance = 3,
  topic_key?: string | null,
) {
  const id = randomUUID();
  const normalizedImportance = normalizeImportance(importance);
  const finalTopicKey =
    normalizeTopicKey(topic_key ?? qualified_name ?? name) ??
    normalizeTopicKey(name) ??
    hashNormalized(name).slice(0, 120);
  const entity = {
    id,
    kind,
    name,
    qualified_name,
    path,
    signature,
    summary,
    inputs,
    outputs,
    side_effects,
    tags,
    importance: normalizedImportance,
    topic_key: finalTopicKey,
    revision_count: 1,
  };
  const contentHash = hashNormalized(codeEntityHashSource(entity));
  const collision = findActiveByTopic("code_entities", project_id, finalTopicKey);
  if (collision) {
    updateCodeEntity(collision.id, {
      kind,
      name,
      qualified_name,
      path,
      signature,
      summary,
      inputs,
      outputs,
      side_effects,
      tags,
      importance: normalizedImportance,
      topic_key: finalTopicKey,
    });
    return collision.id;
  }
  const meta = tokenMetadata(serializeCodeEntityForContext(entity));
  db.prepare(
    `INSERT INTO code_entities (
       id, project_id, kind, name, qualified_name, path, signature, summary,
       inputs, outputs, side_effects, tags, importance, token_count, tokenizer_model,
       content_hash, topic_key
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    project_id,
    kind,
    name,
    qualified_name,
    path,
    signature,
    summary,
    inputs,
    outputs,
    side_effects,
    JSON.stringify(tags),
    normalizedImportance,
    meta.token_count,
    meta.tokenizer_model,
    contentHash,
    finalTopicKey,
  );
  runAutoLinkRules(id, "code_entity", project_id);
  return id;
}

export function updateCodeEntity(id: string, updates: CodeEntityUpdate) {
  if (Object.keys(updates).length === 0) return;
  const existing = db
    .prepare(
      `SELECT id, kind, name, qualified_name, path, signature, summary, inputs, outputs, side_effects, tags, importance, topic_key, revision_count
       FROM code_entities
       WHERE id = ?`,
    )
    .get(id) as CodeEntityTokenSource | undefined;
  if (!existing) return;

  const next: CodeEntityTokenSource = {
    id,
    kind: updates.kind ?? existing.kind,
    name: updates.name ?? existing.name,
    qualified_name: updates.qualified_name ?? existing.qualified_name,
    path: updates.path ?? existing.path,
    signature: updates.signature ?? existing.signature,
    summary: updates.summary ?? existing.summary,
    inputs: updates.inputs ?? existing.inputs,
    outputs: updates.outputs ?? existing.outputs,
    side_effects: updates.side_effects ?? existing.side_effects,
    tags:
      updates.tags === undefined
        ? parseJsonArray(existing.tags as string)
        : updates.tags,
    importance:
      updates.importance === undefined
        ? existing.importance
        : normalizeImportance(updates.importance),
    topic_key:
      normalizeTopicKey(
        updates.topic_key ??
          existing.topic_key ??
          updates.qualified_name ??
          existing.qualified_name ??
          updates.name ??
          existing.name,
      ) ??
      normalizeTopicKey(updates.name ?? existing.name) ??
      hashNormalized(updates.name ?? existing.name).slice(0, 120),
    revision_count: (existing.revision_count ?? 1) + 1,
  };
  const contentHash = hashNormalized(codeEntityHashSource(next));
  const meta = tokenMetadata(serializeCodeEntityForContext(next));

  db.prepare(
    `UPDATE code_entities
     SET kind = ?,
         name = ?,
         qualified_name = ?,
         path = ?,
         signature = ?,
         summary = ?,
         inputs = ?,
         outputs = ?,
         side_effects = ?,
         tags = ?,
         importance = ?,
         content_hash = ?,
         topic_key = ?,
         revision_count = revision_count + 1,
         token_count = ?,
         tokenizer_model = ?,
         updated_at = datetime('now')
     WHERE id = ?`,
  ).run(
    next.kind,
    next.name,
    next.qualified_name,
    next.path,
    next.signature,
    next.summary,
    next.inputs,
    next.outputs,
    next.side_effects,
    JSON.stringify(next.tags),
    next.importance,
    contentHash,
    next.topic_key,
    meta.token_count,
    meta.tokenizer_model,
    id,
  );
}

export function getCodeEntity(id: string) {
  return db.prepare(`SELECT * FROM code_entities WHERE id = ?`).get(id);
}

export function searchCodeEntities(
  query: string,
  project_id?: string,
  limit = 10,
  include_obsolete = false,
) {
  const matchQuery = toFtsQuery(query);
  if (!matchQuery) return [];
  const statusClause = include_obsolete ? "" : "AND c.status = 'active'";
  if (project_id) {
    return db
      .prepare(
        `SELECT c.id, c.project_id, c.kind, c.name, c.qualified_name, c.path, c.signature,
                c.summary, c.inputs, c.outputs, c.side_effects, c.tags, c.status,
                c.importance, c.topic_key, c.revision_count, c.obsolete_reason, c.created_at, c.updated_at
         FROM code_entities_fts f
         JOIN code_entities c ON f.rowid = c.rowid
         WHERE code_entities_fts MATCH ? AND c.project_id = ? ${statusClause}
         ORDER BY rank
         LIMIT ?`,
      )
      .all(matchQuery, project_id, limit);
  }
  return db
    .prepare(
      `SELECT c.id, c.project_id, c.kind, c.name, c.qualified_name, c.path, c.signature,
              c.summary, c.inputs, c.outputs, c.side_effects, c.tags, c.status,
              c.importance, c.topic_key, c.revision_count, c.obsolete_reason, c.created_at, c.updated_at
       FROM code_entities_fts f
       JOIN code_entities c ON f.rowid = c.rowid
       WHERE code_entities_fts MATCH ? ${statusClause}
       ORDER BY rank
       LIMIT ?`,
    )
    .all(matchQuery, limit);
}

export function getCodeEntityContext(
  project_id: string,
  query: string,
  limit = 10,
) {
  const code_entities = searchCodeEntities(query, project_id, limit, false);
  return { project_id, query, code_entities };
}

// ─── Search ──────────────────────────────────────────────────────────────────

type SearchAllResult = {
  type: "note" | "decision" | "artifact" | "code_entity";
  id: string;
  project_id: string;
  title: string;
  summary: string;
  status: string;
  importance: number;
  created_at: string;
  updated_at: string | null;
  rank: number;
  payload: unknown;
};

export function searchAll(
  query: string,
  project_id?: string,
  limit = 10,
  include_obsolete = false,
) {
  const matchQuery = toFtsQuery(query);
  if (!matchQuery) {
    return { query, project_id: project_id ?? null, results: [] };
  }

  const limited = Math.max(1, Math.min(Math.trunc(limit), 50));
  const params = project_id ? [matchQuery, project_id, limited] : [matchQuery, limited];

  const notes = db
    .prepare(
      `SELECT 'note' AS type, n.id, n.project_id, n.content AS title, n.content AS summary,
              n.status, n.importance, n.created_at, n.updated_at, rank,
              n.content, n.tags, n.topic_key, n.revision_count, n.obsolete_reason
       FROM notes_fts f
       JOIN notes n ON f.rowid = n.rowid
       WHERE notes_fts MATCH ? ${project_id ? "AND n.project_id = ?" : ""} ${include_obsolete ? "" : "AND n.status = 'active'"}
       ORDER BY rank
       LIMIT ?`,
    )
    .all(...params) as SearchAllResult[];

  const decisions = db
    .prepare(
      `SELECT 'decision' AS type, d.id, d.project_id, d.decision AS title, d.reasoning AS summary,
              d.status, d.importance, d.created_at, d.updated_at, rank,
              d.decision, d.reasoning, d.topic_key, d.revision_count, d.obsolete_reason
       FROM decisions_fts f
       JOIN decisions d ON f.rowid = d.rowid
       WHERE decisions_fts MATCH ? ${project_id ? "AND d.project_id = ?" : ""} ${include_obsolete ? "" : "AND d.status = 'active'"}
       ORDER BY rank
       LIMIT ?`,
    )
    .all(...params) as SearchAllResult[];

  const artifacts = db
    .prepare(
      `SELECT 'artifact' AS type, a.id, a.project_id, a.type AS title, a.content AS summary,
              a.status, a.importance, a.created_at, a.updated_at, rank,
              a.type AS artifact_type, a.content, a.topic_key, a.revision_count, a.obsolete_reason
       FROM artifacts_fts f
       JOIN artifacts a ON f.rowid = a.rowid
       WHERE artifacts_fts MATCH ? ${project_id ? "AND a.project_id = ?" : ""} ${include_obsolete ? "" : "AND a.status = 'active'"}
       ORDER BY rank
       LIMIT ?`,
    )
    .all(...params) as SearchAllResult[];

  const codeEntities = db
    .prepare(
      `SELECT 'code_entity' AS type, c.id, c.project_id, c.name AS title, c.summary,
              c.status, c.importance, c.created_at, c.updated_at, rank,
              c.kind, c.name, c.qualified_name, c.path, c.signature,
              c.inputs, c.outputs, c.side_effects, c.tags, c.topic_key, c.revision_count, c.obsolete_reason
       FROM code_entities_fts f
       JOIN code_entities c ON f.rowid = c.rowid
       WHERE code_entities_fts MATCH ? ${project_id ? "AND c.project_id = ?" : ""} ${include_obsolete ? "" : "AND c.status = 'active'"}
       ORDER BY rank
       LIMIT ?`,
    )
    .all(...params) as SearchAllResult[];

  const results = [...notes, ...decisions, ...artifacts, ...codeEntities]
    .sort((a, b) => a.rank - b.rank || b.importance - a.importance)
    .slice(0, limited);

  return {
    query,
    project_id: project_id ?? null,
    include_obsolete,
    limit: limited,
    results,
  };
}

// ─── Obsolescence ─────────────────────────────────────────────────────────────

const OBSOLETE_TABLES: Record<string, string> = {
  note: "notes",
  decision: "decisions",
  artifact: "artifacts",
  code_entity: "code_entities",
};

export function markObsolete(
  type: "note" | "decision" | "artifact" | "code_entity",
  id: string,
  reason: string,
) {
  const table = OBSOLETE_TABLES[type];
  if (!table) throw new Error(`Invalid type: ${type}`);
  db.prepare(
    `UPDATE ${table}
     SET status = 'obsolete', obsolete_reason = ?, updated_at = datetime('now')
     WHERE id = ?`,
  ).run(reason, id);
}

export function auditStale(days = 30, project_id?: string) {
  const cutoff = `-${days} days`;
  const projectClause = project_id ? "AND project_id = ?" : "";
  const params: unknown[] = [cutoff];
  if (project_id) params.push(project_id);

  const notes = db
    .prepare(
      `SELECT id, project_id, content, importance, created_at, updated_at
     FROM notes
     WHERE status = 'active'
       AND COALESCE(updated_at, created_at) < datetime('now', ?)
       ${projectClause}
     ORDER BY COALESCE(updated_at, created_at) ASC
     LIMIT 50`,
    )
    .all(...params);

  const decisions = db
    .prepare(
      `SELECT id, project_id, decision, importance, created_at, updated_at
     FROM decisions
     WHERE status = 'active'
       AND COALESCE(updated_at, created_at) < datetime('now', ?)
       ${projectClause}
     ORDER BY COALESCE(updated_at, created_at) ASC
     LIMIT 50`,
    )
    .all(...params);

  const artifacts = db
    .prepare(
      `SELECT id, project_id, type, importance, created_at, updated_at
     FROM artifacts
     WHERE status = 'active'
       AND COALESCE(updated_at, created_at) < datetime('now', ?)
       ${projectClause}
     ORDER BY COALESCE(updated_at, created_at) ASC
     LIMIT 50`,
    )
    .all(...params);

  const code_entities = tableExists("code_entities")
    ? db
        .prepare(
          `SELECT id, project_id, kind, name, qualified_name, path, importance, created_at, updated_at
           FROM code_entities
           WHERE status = 'active'
             AND COALESCE(updated_at, created_at) < datetime('now', ?)
             ${projectClause}
           ORDER BY COALESCE(updated_at, created_at) ASC
           LIMIT 50`,
        )
        .all(...params)
    : [];

  return { notes, decisions, artifacts, code_entities };
}

// ─── Links ────────────────────────────────────────────────────────────────────

export function addLink(
  from_type: string,
  from_id: string,
  to_type: string,
  to_id: string,
) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO links (id, from_type, from_id, to_type, to_id) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, from_type, from_id, to_type, to_id);
  return id;
}

// ─── Working State ───────────────────────────────────────────────────────────

export function setWorkingState(
  session_id: string,
  focus: string,
  open_threads: string[],
  pinned_ids: string[],
) {
  db.prepare(
    `INSERT INTO working_state (session_id, focus, open_threads, pinned_ids, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(session_id) DO UPDATE SET
       focus = excluded.focus,
       open_threads = excluded.open_threads,
       pinned_ids = excluded.pinned_ids,
       updated_at = datetime('now')`,
  ).run(
    session_id,
    focus,
    JSON.stringify(open_threads),
    JSON.stringify(pinned_ids),
  );
}

export function getWorkingState(session_id: string) {
  const row = db
    .prepare(
      `SELECT session_id, focus, open_threads, pinned_ids, updated_at FROM working_state WHERE session_id = ?`,
    )
    .get(session_id) as
    | {
        session_id: string;
        focus: string;
        open_threads: string;
        pinned_ids: string;
        updated_at: string;
      }
    | undefined;

  if (!row) return null;
  return {
    ...row,
    open_threads: parseJsonArray(row.open_threads),
    pinned_ids: parseJsonArray(row.pinned_ids),
  };
}

export function updateProjectContextSummary(
  project_id: string,
  context_summary: string,
) {
  db.prepare(
    `UPDATE projects SET context_summary = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(context_summary, project_id);
}

// ─── Context ──────────────────────────────────────────────────────────────────

type ContextItem = {
  type: "note" | "decision" | "artifact" | "code_entity";
  id: string;
  project_id: string;
  importance: number;
  status: string;
  obsolete_reason: string | null;
  created_at: string;
  updated_at: string | null;
  token_count: number;
  tokenizer_model: string;
  topic_key: string | null;
  revision_count: number;
  sort_ts: string;
  content?: string;
  tags?: string;
  decision?: string;
  reasoning?: string;
  artifact_type?: string;
  kind?: CodeEntityKind;
  name?: string;
  qualified_name?: string;
  path?: string;
  signature?: string;
  summary?: string;
  inputs?: string;
  outputs?: string;
  side_effects?: string;
};

function getPinnedIds(session_id?: string) {
  const rows = session_id
    ? (db
        .prepare(`SELECT pinned_ids FROM working_state WHERE session_id = ?`)
        .all(session_id) as { pinned_ids: string }[])
    : (db
        .prepare(`SELECT pinned_ids FROM working_state ORDER BY updated_at DESC`)
        .all() as { pinned_ids: string }[]);
  const pinned = new Set<string>();
  for (const row of rows) {
    for (const id of parseJsonArray(row.pinned_ids)) pinned.add(id);
  }
  return pinned;
}

function isPinned(item: ContextItem, pinned: Set<string>) {
  return pinned.has(item.id) || pinned.has(`${item.type}:${item.id}`);
}

export function buildContext(
  project_id: string,
  token_budget: number,
  session_id?: string,
) {
  const effective_budget = Math.max(
    0,
    Math.trunc(token_budget) - CONTEXT_WRAPPER_TOKEN_MARGIN,
  );
  const pinned = getPinnedIds(session_id);

  const notes = db
    .prepare(
      `SELECT 'note' AS type, id, project_id, content, tags, status, importance, obsolete_reason,
              created_at, updated_at, token_count, tokenizer_model, topic_key, revision_count,
              COALESCE(updated_at, created_at) AS sort_ts
       FROM notes
       WHERE project_id = ? AND status = 'active'`,
    )
    .all(project_id) as ContextItem[];

  const decisions = db
    .prepare(
      `SELECT 'decision' AS type, id, project_id, decision, reasoning, status, importance, obsolete_reason,
              created_at, updated_at, token_count, tokenizer_model, topic_key, revision_count,
              COALESCE(updated_at, created_at) AS sort_ts
       FROM decisions
       WHERE project_id = ? AND status = 'active'`,
    )
    .all(project_id) as ContextItem[];

  const artifacts = db
    .prepare(
      `SELECT 'artifact' AS type, id, project_id, type AS artifact_type, content, status, importance, obsolete_reason,
              created_at, updated_at, token_count, tokenizer_model, topic_key, revision_count,
              COALESCE(updated_at, created_at) AS sort_ts
       FROM artifacts
       WHERE project_id = ? AND status = 'active'`,
    )
    .all(project_id) as ContextItem[];

  const codeEntities = db
    .prepare(
      `SELECT 'code_entity' AS type, id, project_id, kind, name, qualified_name, path, signature,
              summary, inputs, outputs, side_effects, tags, status, importance, obsolete_reason,
              created_at, updated_at, token_count, tokenizer_model, topic_key, revision_count,
              COALESCE(updated_at, created_at) AS sort_ts
       FROM code_entities
       WHERE project_id = ? AND status = 'active'`,
    )
    .all(project_id) as ContextItem[];

  const allCandidates = [...notes, ...decisions, ...artifacts, ...codeEntities];

  const acceptedRelations =
    allCandidates.length > 0
      ? getAcceptedRelationsForIds(allCandidates.map((c) => c.id))
      : [];

  const conflictMap = new Map<string, Set<string>>();
  for (const rel of acceptedRelations) {
    if (rel.relation !== "conflicts_with") continue;
    if (!conflictMap.has(rel.source_id)) conflictMap.set(rel.source_id, new Set());
    if (!conflictMap.has(rel.target_id)) conflictMap.set(rel.target_id, new Set());
    conflictMap.get(rel.source_id)!.add(rel.target_id);
    conflictMap.get(rel.target_id)!.add(rel.source_id);
  }

  const sorted = allCandidates.sort((a, b) => {
    const pinDiff = Number(isPinned(b, pinned)) - Number(isPinned(a, pinned));
    if (pinDiff !== 0) return pinDiff;
    const importanceDiff = b.importance - a.importance;
    if (importanceDiff !== 0) return importanceDiff;
    return b.sort_ts.localeCompare(a.sort_ts);
  });

  const excluded = new Set<string>();
  const bundle: ContextItem[] = [];
  for (const item of sorted) {
    if (excluded.has(item.id)) continue;
    bundle.push(item);
    for (const conflictId of conflictMap.get(item.id) ?? []) {
      excluded.add(conflictId);
    }
  }

  const expansionBudget = Math.floor(effective_budget * 0.15);
  const mainBudget = effective_budget - expansionBudget;

  const items: ContextItem[] = [];
  const omitted: ContextItem[] = [];
  let used_tokens = 0;

  for (const item of bundle) {
    if (used_tokens + item.token_count <= mainBudget) {
      items.push(item);
      used_tokens += item.token_count;
    } else {
      omitted.push(item);
    }
  }

  const inBundle = new Set(items.map((i) => i.id));
  const expansionRelated = new Set<string>();
  for (const rel of acceptedRelations) {
    if (rel.relation === "conflicts_with") continue;
    if (inBundle.has(rel.source_id) && !inBundle.has(rel.target_id))
      expansionRelated.add(rel.target_id);
    if (inBundle.has(rel.target_id) && !inBundle.has(rel.source_id))
      expansionRelated.add(rel.source_id);
  }

  let expansion_tokens = 0;
  let graph_expansions = 0;
  for (const item of omitted) {
    if (!expansionRelated.has(item.id)) continue;
    if (expansion_tokens + item.token_count <= expansionBudget) {
      items.push(item);
      expansion_tokens += item.token_count;
      used_tokens += item.token_count;
      graph_expansions++;
    }
  }

  return {
    project_id,
    session_id: session_id ?? null,
    token_budget,
    effective_budget,
    used_tokens,
    omitted_count: allCandidates.length - items.length,
    conflict_exclusions: excluded.size,
    graph_expansions,
    items,
  };
}

type CheckpointOptions = {
  session_summary?: string;
  context_summary?: string;
  token_budget?: number;
};

function summarizeContextItem(item: ContextItem) {
  if (item.type === "note") return `note:${item.id} ${item.content ?? ""}`;
  if (item.type === "decision") {
    return `decision:${item.id} ${item.decision ?? ""}`;
  }
  if (item.type === "artifact") {
    return `artifact:${item.id} ${item.artifact_type ?? ""} ${item.content ?? ""}`;
  }
  return `code_entity:${item.id} ${item.kind ?? ""} ${item.qualified_name || item.name || ""} ${item.summary ?? ""}`;
}

function generateCheckpointContextSummary(
  session: { summary: string } | undefined,
  workingState: ReturnType<typeof getWorkingState>,
  context: ReturnType<typeof buildContext>,
) {
  const parts: string[] = [];
  if (session?.summary) parts.push(`Session: ${session.summary}`);
  if (workingState?.focus) parts.push(`Focus: ${workingState.focus}`);
  if (workingState?.open_threads.length) {
    parts.push(`Open threads: ${workingState.open_threads.join(", ")}`);
  }
  if (workingState?.pinned_ids.length) {
    parts.push(`Pinned: ${workingState.pinned_ids.join(", ")}`);
  }
  const items = context.items.slice(0, 8).map(summarizeContextItem);
  if (items.length) parts.push(`Context: ${items.join(" | ")}`);
  return parts.join("\n").slice(0, 4000);
}

export function checkpoint(
  session_id: string,
  project_id: string,
  options: CheckpointOptions = {},
) {
  const sessionBefore = getSession(session_id) as
    | {
        id: string;
        title: string;
        summary: string;
        project_id: string | null;
        created_at: string;
        updated_at: string;
      }
    | undefined;
  const tokenBudget = options.token_budget ?? 4000;
  const context = buildContext(project_id, tokenBudget, session_id);
  const workingState = getWorkingState(session_id);

  updateSessionCheckpoint(session_id, project_id, options.session_summary);

  const sessionForSummary = {
    summary: options.session_summary ?? sessionBefore?.summary ?? "",
  };
  const contextSummary =
    options.context_summary ??
    generateCheckpointContextSummary(sessionForSummary, workingState, context);
  updateProjectContextSummary(project_id, contextSummary);

  return {
    session_id,
    project_id,
    updated_session: true,
    updated_project_context_summary: true,
    used_generated_context_summary: options.context_summary === undefined,
    context,
  };
}

export function getProjectContext(
  project_id: string,
  limit = 5,
  include_obsolete = false,
) {
  const statusClause = include_obsolete ? "" : "AND status = 'active'";

  const notes = db
    .prepare(
      `SELECT id, content, tags, topic_key, revision_count, status, importance, obsolete_reason, created_at, updated_at FROM notes
       WHERE project_id = ? ${statusClause}
       ORDER BY importance DESC, COALESCE(updated_at, created_at) DESC LIMIT ?`,
    )
    .all(project_id, limit);

  const decisions = db
    .prepare(
      `SELECT id, decision, reasoning, topic_key, revision_count, status, importance, obsolete_reason, created_at, updated_at FROM decisions
       WHERE project_id = ? ${statusClause}
       ORDER BY importance DESC, COALESCE(updated_at, created_at) DESC LIMIT ?`,
    )
    .all(project_id, limit);

  const artifacts = db
    .prepare(
      `SELECT id, type, content, topic_key, revision_count, status, importance, obsolete_reason, created_at, updated_at FROM artifacts
       WHERE project_id = ? ${statusClause}
       ORDER BY importance DESC, COALESCE(updated_at, created_at) DESC LIMIT ?`,
    )
    .all(project_id, limit);

  return { notes, decisions, artifacts };
}

// ─── Graph And Audit ─────────────────────────────────────────────────────────

type LinkRow = {
  id: string;
  from_type: string;
  from_id: string;
  to_type: string;
  to_id: string;
  created_at: string;
};

const ENTITY_TABLES: Record<string, string> = {
  note: "notes",
  decision: "decisions",
  artifact: "artifacts",
  code_entity: "code_entities",
  project: "projects",
  session: "sessions",
};

function entityKey(type: string, id: string) {
  return `${type}:${id}`;
}

function resolveEntity(type: string, id: string) {
  const table = ENTITY_TABLES[type];
  if (!table) return null;
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) ?? null;
}

export function getRelated(entity_type: string, entity_id: string, depth = 1) {
  const maxDepth = Math.max(0, Math.trunc(depth));
  const visited = new Set<string>([entityKey(entity_type, entity_id)]);
  const seenLinks = new Set<string>();
  const links: LinkRow[] = [];
  const entities = new Map<string, unknown>();

  entities.set(entityKey(entity_type, entity_id), {
    type: entity_type,
    entity: resolveEntity(entity_type, entity_id),
  });

  let frontier = [{ type: entity_type, id: entity_id }];
  const linkQuery = db.prepare(
    `SELECT id, from_type, from_id, to_type, to_id, created_at
     FROM links
     WHERE (from_type = ? AND from_id = ?) OR (to_type = ? AND to_id = ?)
     ORDER BY created_at ASC`,
  );

  for (let currentDepth = 0; currentDepth < maxDepth; currentDepth += 1) {
    const nextFrontier: { type: string; id: string }[] = [];
    for (const node of frontier) {
      const rows = linkQuery.all(
        node.type,
        node.id,
        node.type,
        node.id,
      ) as LinkRow[];
      for (const link of rows) {
        if (!seenLinks.has(link.id)) {
          seenLinks.add(link.id);
          links.push(link);
        }

        const neighbor =
          link.from_type === node.type && link.from_id === node.id
            ? { type: link.to_type, id: link.to_id }
            : { type: link.from_type, id: link.from_id };
        const key = entityKey(neighbor.type, neighbor.id);
        if (visited.has(key)) continue;

        visited.add(key);
        entities.set(key, {
          type: neighbor.type,
          entity: resolveEntity(neighbor.type, neighbor.id),
        });
        nextFrontier.push(neighbor);
      }
    }
    frontier = nextFrontier;
    if (frontier.length === 0) break;
  }

  return {
    root: { type: entity_type, id: entity_id },
    depth: maxDepth,
    links,
    entities: Array.from(entities.entries()).map(([key, value]) => ({
      key,
      ...(value as object),
    })),
  };
}

export function getAuditTrail(entity_type: string, entity_id: string) {
  const rows = db
    .prepare(
      `SELECT id, entity_type, entity_id, op, payload_before, payload_after, ts
       FROM events
       WHERE entity_type = ? AND entity_id = ?
       ORDER BY ts ASC`,
    )
    .all(entity_type, entity_id) as {
    id: string;
    entity_type: string;
    entity_id: string;
    op: string;
    payload_before: string | null;
    payload_after: string | null;
    ts: string;
  }[];

  return rows.map((row) => ({
    ...row,
    payload_before: row.payload_before ? JSON.parse(row.payload_before) : null,
    payload_after: row.payload_after ? JSON.parse(row.payload_after) : null,
  }));
}

// ─── Relations ────────────────────────────────────────────────────────────────

export const RELATION_TYPES = [
  "implements",
  "depends_on",
  "conflicts_with",
  "replaces",
  "references",
  "structural_sibling",
  "topically_related",
  "variant_of",
  "semantically_related",
] as const;

export type RelationType = (typeof RELATION_TYPES)[number];

type AcceptedRelation = {
  source_id: string;
  target_id: string;
  relation: string;
  confidence: number;
};

const SYMMETRIC_RELATIONS = new Set([
  "structural_sibling",
  "topically_related",
  "semantically_related",
  "variant_of",
  "conflicts_with",
]);

function computeRelationSyncId(
  source_type: string,
  source_id: string,
  target_type: string,
  target_id: string,
  relation: string,
): string {
  let a = `${source_type}:${source_id}`;
  let b = `${target_type}:${target_id}`;
  if (SYMMETRIC_RELATIONS.has(relation) && a > b) [a, b] = [b, a];
  return createHash("sha256")
    .update(`${a}|${b}|${relation}`)
    .digest("hex")
    .slice(0, 32);
}

type RelationUpsertParams = {
  sync_id?: string;
  source_type: string;
  source_id: string;
  target_type: string;
  target_id: string;
  relation: string;
  reason?: string;
  evidence?: string;
  confidence?: number;
  judgment_status?: "pending" | "accepted" | "rejected";
  marked_by_actor?: string;
  marked_by_kind?: string;
  marked_by_model?: string;
  session_id?: string;
};

function upsertRelationInternal(p: RelationUpsertParams): string {
  const sync_id =
    p.sync_id ??
    computeRelationSyncId(
      p.source_type,
      p.source_id,
      p.target_type,
      p.target_id,
      p.relation,
    );
  db.prepare(`
    INSERT INTO memory_relations
      (sync_id, source_type, source_id, target_type, target_id, relation, reason, evidence,
       confidence, judgment_status, marked_by_actor, marked_by_kind, marked_by_model,
       session_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(sync_id) DO UPDATE SET
      source_type      = excluded.source_type,
      source_id        = excluded.source_id,
      target_type      = excluded.target_type,
      target_id        = excluded.target_id,
      relation         = excluded.relation,
      reason           = excluded.reason,
      evidence         = excluded.evidence,
      confidence       = excluded.confidence,
      judgment_status  = CASE WHEN memory_relations.judgment_status = 'rejected'
                              THEN memory_relations.judgment_status
                              ELSE excluded.judgment_status END,
      marked_by_actor  = excluded.marked_by_actor,
      marked_by_kind   = excluded.marked_by_kind,
      marked_by_model  = excluded.marked_by_model,
      session_id       = excluded.session_id,
      updated_at       = datetime('now')
  `).run(
    sync_id,
    p.source_type,
    p.source_id,
    p.target_type,
    p.target_id,
    p.relation,
    p.reason ?? "",
    p.evidence ?? "",
    p.confidence ?? 0.5,
    p.judgment_status ?? "pending",
    p.marked_by_actor ?? "",
    p.marked_by_kind ?? "auto",
    p.marked_by_model ?? "",
    p.session_id ?? null,
  );
  return sync_id;
}

export function upsertRelation(p: RelationUpsertParams): string {
  return upsertRelationInternal(p);
}

export function judgeRelation(
  sync_id: string,
  judgment_status: "accepted" | "rejected",
  marked_by_actor = "",
  marked_by_kind = "human",
  marked_by_model = "",
) {
  db.prepare(`
    UPDATE memory_relations
    SET judgment_status = ?, marked_by_actor = ?, marked_by_kind = ?, marked_by_model = ?,
        updated_at = datetime('now')
    WHERE sync_id = ?
  `).run(judgment_status, marked_by_actor, marked_by_kind, marked_by_model, sync_id);
}

export function getRelationsForEntity(
  entity_type: string,
  entity_id: string,
  options: { judgment_status?: string; relation?: string; limit?: number } = {},
) {
  const conditions: string[] = [
    "((source_type = ? AND source_id = ?) OR (target_type = ? AND target_id = ?))",
  ];
  const params: unknown[] = [entity_type, entity_id, entity_type, entity_id];
  if (options.judgment_status) {
    conditions.push("judgment_status = ?");
    params.push(options.judgment_status);
  }
  if (options.relation) {
    conditions.push("relation = ?");
    params.push(options.relation);
  }
  params.push(options.limit ?? 50);
  return db
    .prepare(
      `SELECT sync_id, source_type, source_id, target_type, target_id, relation,
              reason, evidence, confidence, judgment_status,
              marked_by_actor, marked_by_kind, marked_by_model,
              session_id, created_at, updated_at
       FROM memory_relations
       WHERE ${conditions.join(" AND ")}
       ORDER BY confidence DESC, updated_at DESC
       LIMIT ?`,
    )
    .all(...params);
}

export function getPendingJudgments(project_id?: string, limit = 20) {
  if (project_id) {
    return db
      .prepare(
        `SELECT r.sync_id, r.source_type, r.source_id, r.target_type, r.target_id,
                r.relation, r.reason, r.evidence, r.confidence,
                r.judgment_status, r.marked_by_actor, r.marked_by_kind, r.marked_by_model,
                r.session_id, r.created_at, r.updated_at
         FROM memory_relations r
         WHERE r.judgment_status = 'pending'
           AND (
             (r.source_type = 'note'        AND r.source_id IN (SELECT id FROM notes        WHERE project_id = ?))
             OR (r.source_type = 'decision'  AND r.source_id IN (SELECT id FROM decisions    WHERE project_id = ?))
             OR (r.source_type = 'artifact'  AND r.source_id IN (SELECT id FROM artifacts    WHERE project_id = ?))
             OR (r.source_type = 'code_entity' AND r.source_id IN (SELECT id FROM code_entities WHERE project_id = ?))
           )
         ORDER BY r.confidence DESC, r.created_at DESC
         LIMIT ?`,
      )
      .all(project_id, project_id, project_id, project_id, limit);
  }
  return db
    .prepare(
      `SELECT * FROM memory_relations
       WHERE judgment_status = 'pending'
       ORDER BY confidence DESC, created_at DESC
       LIMIT ?`,
    )
    .all(limit);
}

function getAcceptedRelationsForIds(ids: string[]): AcceptedRelation[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT source_type, source_id, target_type, target_id, relation, confidence
       FROM memory_relations
       WHERE judgment_status = 'accepted'
         AND (source_id IN (${placeholders}) OR target_id IN (${placeholders}))`,
    )
    .all(...ids, ...ids) as AcceptedRelation[];
}

type EntityTypeName = "note" | "decision" | "artifact" | "code_entity";

function getEntityAutoLinkInfo(
  type: EntityTypeName,
  id: string,
): { query: string; tags: string[]; path?: string; topic_key?: string | null } | null {
  if (type === "note") {
    const row = db
      .prepare("SELECT content, tags, topic_key FROM notes WHERE id = ?")
      .get(id) as { content: string; tags: string; topic_key: string | null } | undefined;
    if (!row) return null;
    return {
      query: row.topic_key ?? row.content.slice(0, 150),
      tags: parseJsonArray(row.tags),
      topic_key: row.topic_key,
    };
  }
  if (type === "decision") {
    const row = db
      .prepare("SELECT decision, tags, topic_key FROM decisions WHERE id = ?")
      .get(id) as { decision: string; tags: string; topic_key: string | null } | undefined;
    if (!row) return null;
    return {
      query: row.topic_key ?? row.decision.slice(0, 150),
      tags: parseJsonArray(row.tags),
      topic_key: row.topic_key,
    };
  }
  if (type === "artifact") {
    const row = db
      .prepare("SELECT type, content, tags, topic_key FROM artifacts WHERE id = ?")
      .get(id) as {
      type: string;
      content: string;
      tags: string;
      topic_key: string | null;
    } | undefined;
    if (!row) return null;
    return {
      query: row.topic_key ?? `${row.type} ${row.content.slice(0, 100)}`,
      tags: parseJsonArray(row.tags),
      topic_key: row.topic_key,
    };
  }
  if (type === "code_entity") {
    const row = db
      .prepare(
        "SELECT name, qualified_name, summary, tags, topic_key, path FROM code_entities WHERE id = ?",
      )
      .get(id) as {
      name: string;
      qualified_name: string;
      summary: string;
      tags: string;
      topic_key: string | null;
      path: string;
    } | undefined;
    if (!row) return null;
    return {
      query: row.topic_key ?? `${row.qualified_name || row.name} ${row.summary}`.slice(0, 150),
      tags: parseJsonArray(row.tags),
      topic_key: row.topic_key,
      path: row.path,
    };
  }
  return null;
}

function runAutoLinkRules(id: string, type: EntityTypeName, project_id: string): void {
  const info = getEntityAutoLinkInfo(type, id);
  if (!info) return;

  // Rule 1: structural_sibling — code_entities sharing the same file path
  if (type === "code_entity" && info.path) {
    const siblings = db
      .prepare(
        `SELECT id FROM code_entities
         WHERE project_id = ? AND path = ? AND id != ? AND status = 'active'`,
      )
      .all(project_id, info.path, id) as { id: string }[];
    for (const sib of siblings) {
      upsertRelationInternal({
        source_type: type,
        source_id: id,
        target_type: "code_entity",
        target_id: sib.id,
        relation: "structural_sibling",
        reason: `Both defined in ${info.path}`,
        evidence: `path = ${info.path}`,
        confidence: 0.9,
        judgment_status: "accepted",
        marked_by_kind: "auto-rule",
        marked_by_actor: "mcp-memory",
      });
    }
  }

  // Rule 2: topically_related — entities sharing >= 2 tags in same project
  if (info.tags.length >= 2) {
    const tableTargets: Array<{ table: string; type: EntityTypeName }> = [
      { table: "notes", type: "note" },
      { table: "decisions", type: "decision" },
      { table: "artifacts", type: "artifact" },
      { table: "code_entities", type: "code_entity" },
    ];
    for (const target of tableTargets) {
      const candidates = db
        .prepare(
          `SELECT id, tags FROM ${target.table}
           WHERE project_id = ? AND id != ? AND status = 'active' AND tags != '[]'`,
        )
        .all(project_id, id) as { id: string; tags: string }[];
      for (const candidate of candidates) {
        const candidateTags = parseJsonArray(candidate.tags);
        const shared = info.tags.filter((t) => candidateTags.includes(t));
        if (shared.length >= 2) {
          upsertRelationInternal({
            source_type: type,
            source_id: id,
            target_type: target.type,
            target_id: candidate.id,
            relation: "topically_related",
            reason: `Shared tags: ${shared.join(", ")}`,
            evidence: `${shared.length} common tags`,
            confidence: Math.min(0.9, 0.5 + shared.length * 0.1),
            judgment_status: "pending",
            marked_by_kind: "auto-rule",
            marked_by_actor: "mcp-memory",
          });
        }
      }
    }
  }

  // Rule 3: variant_of — same entity type with topic_key sharing a prefix >= 6 chars
  if (info.topic_key && info.topic_key.length >= 6) {
    const tableName =
      type === "note"
        ? "notes"
        : type === "decision"
          ? "decisions"
          : type === "artifact"
            ? "artifacts"
            : "code_entities";
    const prefix = info.topic_key.slice(0, Math.min(info.topic_key.length - 1, 20));
    const variants = db
      .prepare(
        `SELECT id, topic_key FROM ${tableName}
         WHERE project_id = ? AND id != ? AND status = 'active'
           AND topic_key LIKE ? AND topic_key != ?`,
      )
      .all(project_id, id, `${prefix}%`, info.topic_key) as {
      id: string;
      topic_key: string;
    }[];
    for (const v of variants) {
      upsertRelationInternal({
        source_type: type,
        source_id: id,
        target_type: type,
        target_id: v.id,
        relation: "variant_of",
        reason: `Shared topic key prefix: ${prefix}`,
        evidence: `topic_keys: ${info.topic_key} / ${v.topic_key}`,
        confidence: 0.8,
        judgment_status: "accepted",
        marked_by_kind: "auto-rule",
        marked_by_actor: "mcp-memory",
      });
    }
  }

  // Rule 4: semantically_related — FTS5 top matches in same project
  const ftsQuery = toFtsQuery(info.query);
  if (!ftsQuery) return;

  const ftsTargets: Array<{ ftsTable: string; dataTable: string; type: EntityTypeName }> = [
    { ftsTable: "notes_fts", dataTable: "notes", type: "note" },
    { ftsTable: "decisions_fts", dataTable: "decisions", type: "decision" },
    { ftsTable: "artifacts_fts", dataTable: "artifacts", type: "artifact" },
    { ftsTable: "code_entities_fts", dataTable: "code_entities", type: "code_entity" },
  ];
  const confidenceTiers = [0.75, 0.65, 0.55];

  for (const target of ftsTargets) {
    const rows = (
      db
        .prepare(
          `SELECT d.id, rank
           FROM ${target.ftsTable} f
           JOIN ${target.dataTable} d ON f.rowid = d.rowid
           WHERE ${target.ftsTable} MATCH ? AND d.project_id = ? AND d.status = 'active'
           ORDER BY rank
           LIMIT 4`,
        )
        .all(ftsQuery, project_id) as { id: string; rank: number }[]
    )
      .filter((r) => r.id !== id && r.rank >= -8)
      .slice(0, 3);

    for (let i = 0; i < rows.length; i++) {
      upsertRelationInternal({
        source_type: type,
        source_id: id,
        target_type: target.type,
        target_id: rows[i].id,
        relation: "semantically_related",
        reason: "FTS5 content similarity",
        evidence: `rank: ${rows[i].rank.toFixed(3)}, position: ${i + 1}`,
        confidence: confidenceTiers[i] ?? 0.55,
        judgment_status: "pending",
        marked_by_kind: "auto-rule",
        marked_by_actor: "mcp-memory",
      });
    }
  }
}
