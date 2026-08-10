use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use tracing::{info, warn};

use crate::hash::{
    artifact_hash_source, code_entity_hash_source, decision_hash_source, hash_normalized,
    normalize_topic_key, note_hash_source,
};

pub struct Migration {
    pub version: i64,
    pub name: &'static str,
    pub sql: &'static str,
    pub post: Option<fn(&mut Connection) -> Result<()>>,
}

fn add_column_if_missing(
    conn: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<()> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", table))?;
    let cols: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(|r| r.ok())
        .collect();
    if !cols.iter().any(|c| c == column) {
        conn.execute_batch(&format!("ALTER TABLE {} ADD COLUMN {} {}", table, column, definition))?;
    }
    Ok(())
}

fn run_post_v2(conn: &mut Connection) -> Result<()> {
    for table in ["notes", "decisions", "artifacts"] {
        add_column_if_missing(conn, table, "status", "TEXT NOT NULL DEFAULT 'active'")?;
        add_column_if_missing(conn, table, "updated_at", "TEXT")?;
        add_column_if_missing(conn, table, "obsolete_reason", "TEXT")?;
        add_column_if_missing(
            conn,
            table,
            "importance",
            "INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5)",
        )?;
    }
    Ok(())
}

fn run_post_v5(conn: &mut Connection) -> Result<()> {
    add_column_if_missing(conn, "projects", "context_summary", "TEXT NOT NULL DEFAULT ''")?;
    for table in ["notes", "decisions", "artifacts"] {
        add_column_if_missing(conn, table, "token_count", "INTEGER NOT NULL DEFAULT 0")?;
        add_column_if_missing(conn, table, "tokenizer_model", "TEXT NOT NULL DEFAULT ''")?;
        conn.execute_batch(&format!(
            "CREATE INDEX IF NOT EXISTS {t}_context_rank_idx
             ON {t}(project_id, status, importance, token_count)",
            t = table
        ))?;
    }
    Ok(())
}

fn run_post_v7(conn: &mut Connection) -> Result<()> {
    for table in ["notes", "decisions", "artifacts", "code_entities"] {
        add_column_if_missing(conn, table, "content_hash", "TEXT NOT NULL DEFAULT ''")?;
        add_column_if_missing(conn, table, "topic_key", "TEXT")?;
        add_column_if_missing(conn, table, "revision_count", "INTEGER NOT NULL DEFAULT 1")?;
        conn.execute_batch(&format!(
            "CREATE INDEX IF NOT EXISTS {t}_content_hash_idx
                ON {t}(project_id, content_hash);
             CREATE INDEX IF NOT EXISTS {t}_topic_key_idx
                ON {t}(project_id, topic_key);
             CREATE INDEX IF NOT EXISTS {t}_topic_key_status_idx
                ON {t}(project_id, topic_key, status);",
            t = table
        ))?;
    }

    let tx = conn.transaction()?;
    {
        let mut q = tx.prepare("SELECT id, content FROM notes WHERE content_hash = ''")?;
        let rows: Vec<(String, String)> = q
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .filter_map(Result::ok)
            .collect();
        let mut up = tx.prepare("UPDATE notes SET content_hash = ? WHERE id = ?")?;
        for (id, content) in rows {
            up.execute(params![hash_normalized(&note_hash_source(&content)), id])?;
        }
    }
    {
        let mut q = tx.prepare("SELECT id, decision, reasoning FROM decisions WHERE content_hash = ''")?;
        let rows: Vec<(String, String, String)> = q
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .filter_map(Result::ok)
            .collect();
        let mut up = tx.prepare("UPDATE decisions SET content_hash = ? WHERE id = ?")?;
        for (id, decision, reasoning) in rows {
            up.execute(params![
                hash_normalized(&decision_hash_source(&decision, &reasoning)),
                id
            ])?;
        }
    }
    {
        let mut q = tx.prepare("SELECT id, type, content FROM artifacts WHERE content_hash = ''")?;
        let rows: Vec<(String, String, String)> = q
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .filter_map(Result::ok)
            .collect();
        let mut up = tx.prepare("UPDATE artifacts SET content_hash = ? WHERE id = ?")?;
        for (id, ty, content) in rows {
            up.execute(params![hash_normalized(&artifact_hash_source(&ty, &content)), id])?;
        }
    }
    {
        let mut q = tx.prepare(
            "SELECT id, kind, name, qualified_name, path, signature, summary
             FROM code_entities WHERE content_hash = '' OR topic_key IS NULL",
        )?;
        type Row = (String, String, String, String, String, String, String);
        let rows: Vec<Row> = q
            .query_map([], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                ))
            })?
            .filter_map(Result::ok)
            .collect();
        let mut up = tx.prepare(
            "UPDATE code_entities SET content_hash = ?, topic_key = COALESCE(topic_key, ?) WHERE id = ?",
        )?;
        for (id, kind, name, qn, path, sig, summary) in rows {
            let hash = hash_normalized(&code_entity_hash_source(&kind, &name, &qn, &path, &sig, &summary));
            let topic = normalize_topic_key(Some(if qn.is_empty() { name.as_str() } else { qn.as_str() }));
            up.execute(params![hash, topic, id])?;
        }
    }
    tx.commit()?;

    conn.execute_batch(MIGRATION_7_FTS_REBUILD)?;
    Ok(())
}

fn run_post_v9(conn: &mut Connection) -> Result<()> {
    for table in ["decisions", "artifacts"] {
        add_column_if_missing(conn, table, "tags", "TEXT NOT NULL DEFAULT '[]'")?;
        conn.execute_batch(&format!(
            "CREATE INDEX IF NOT EXISTS {t}_tags_idx ON {t}(project_id, tags)",
            t = table
        ))?;
    }
    Ok(())
}

const MIGRATION_1_SQL: &str = include_str!("migrations_sql/001_baseline.sql");
const MIGRATION_3_SQL: &str = include_str!("migrations_sql/003_fts_and_link_indexes.sql");
const MIGRATION_4_SQL: &str = include_str!("migrations_sql/004_events_audit_log.sql");
const MIGRATION_5_SQL: &str = include_str!("migrations_sql/005_context_intelligence.sql");
const MIGRATION_6_SQL: &str = include_str!("migrations_sql/006_code_entities_fts.sql");
const MIGRATION_7_FTS_REBUILD: &str = include_str!("migrations_sql/007_fts_rebuild.sql");
const MIGRATION_8_SQL: &str = include_str!("migrations_sql/008_memory_relations.sql");
const MIGRATION_10_SQL: &str = include_str!("migrations_sql/010_project_paths_and_threads.sql");
const MIGRATION_11_SQL: &str = include_str!("migrations_sql/011_session_focus.sql");

pub fn all() -> Vec<Migration> {
    vec![
        Migration { version: 1, name: "baseline_schema", sql: MIGRATION_1_SQL, post: None },
        Migration { version: 2, name: "status_and_importance", sql: "", post: Some(run_post_v2) },
        Migration { version: 3, name: "decisions_artifacts_fts_and_link_indexes", sql: MIGRATION_3_SQL, post: None },
        Migration { version: 4, name: "events_audit_log", sql: MIGRATION_4_SQL, post: None },
        Migration { version: 5, name: "context_intelligence", sql: MIGRATION_5_SQL, post: Some(run_post_v5) },
        Migration { version: 6, name: "code_entities_fts", sql: MIGRATION_6_SQL, post: None },
        Migration { version: 7, name: "memory_identity_topic_key", sql: "", post: Some(run_post_v7) },
        Migration { version: 8, name: "memory_relations", sql: MIGRATION_8_SQL, post: None },
        Migration { version: 9, name: "decision_artifact_tags", sql: "", post: Some(run_post_v9) },
        Migration { version: 10, name: "project_paths_and_threads", sql: MIGRATION_10_SQL, post: None },
        Migration { version: 11, name: "session_focus", sql: MIGRATION_11_SQL, post: None },
    ]
}

fn migration_checksum(m: &Migration) -> String {
    let mut hasher = Sha256::new();
    hasher.update(m.version.to_string().as_bytes());
    hasher.update(b":");
    hasher.update(m.name.as_bytes());
    hasher.update(b":");
    hasher.update(m.sql.as_bytes());
    hex::encode(hasher.finalize())
}

#[derive(Debug)]
pub struct MigrationReport {
    pub applied_new: Vec<i64>,
    pub already_present: Vec<i64>,
    pub checksums_rewritten: Vec<i64>,
}

pub fn run(conn: &mut Connection) -> Result<MigrationReport> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version    INTEGER PRIMARY KEY,
            name       TEXT NOT NULL,
            checksum   TEXT NOT NULL,
            applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );",
    )?;

    let applied: HashMap<i64, (String, String)> = {
        let mut stmt = conn.prepare("SELECT version, name, checksum FROM schema_migrations")?;
        let collected: HashMap<i64, (String, String)> = stmt
            .query_map([], |r| {
                Ok((r.get::<_, i64>(0)?, (r.get::<_, String>(1)?, r.get::<_, String>(2)?)))
            })?
            .filter_map(Result::ok)
            .collect();
        collected
    };

    let mut report = MigrationReport {
        applied_new: Vec::new(),
        already_present: Vec::new(),
        checksums_rewritten: Vec::new(),
    };

    for m in all() {
        let expected = migration_checksum(&m);
        if let Some((name, stored_checksum)) = applied.get(&m.version) {
            if name != m.name {
                warn!(
                    version = m.version,
                    stored = %name,
                    expected = m.name,
                    "migration name mismatch — keeping stored name"
                );
            }
            if stored_checksum != &expected {
                conn.execute(
                    "UPDATE schema_migrations SET checksum = ? WHERE version = ?",
                    params![expected, m.version],
                )?;
                report.checksums_rewritten.push(m.version);
            }
            report.already_present.push(m.version);
            continue;
        }

        info!(version = m.version, name = m.name, "applying migration");
        let tx = conn.unchecked_transaction()?;
        if !m.sql.is_empty() {
            tx.execute_batch(m.sql)
                .with_context(|| format!("migration {} sql failed", m.version))?;
        }
        tx.commit()?;
        if let Some(post) = m.post {
            post(conn).with_context(|| format!("migration {} post step failed", m.version))?;
        }
        conn.execute(
            "INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)",
            params![m.version, m.name, expected],
        )?;
        report.applied_new.push(m.version);
    }

    Ok(report)
}
