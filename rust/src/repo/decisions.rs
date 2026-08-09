//! Decisions: technical/architectural/workflow decisions with reasoning.
//! Mirrors `addDecision/updateDecision/deleteDecision` in `src/db.ts`
//! L1281-1399. No standalone `search_decisions` — only `search_all` queries
//! the FTS table for decisions.

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::hash::{decision_hash_source, hash_normalized, normalize_topic_key};
use crate::tokens::token_metadata;

use super::auto_link;
use super::identity::{find_active_by_hash, find_active_by_topic};
use super::serialize::{serialize_decision, DecisionCtx};
use super::{new_uuid, Db};

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DecisionRow {
    pub id: String,
    pub project_id: String,
    pub decision: String,
    pub reasoning: String,
    pub topic_key: Option<String>,
    pub revision_count: i64,
    pub status: String,
    pub importance: i64,
    pub obsolete_reason: Option<String>,
    pub token_count: Option<i64>,
    pub tokenizer_model: Option<String>,
    pub content_hash: Option<String>,
    pub created_at: String,
    pub updated_at: Option<String>,
}

pub fn list_all(db: &Db, project_id: Option<&str>) -> Result<Vec<DecisionRow>> {
    db.with(|conn| {
        let map = |r: &rusqlite::Row<'_>| -> rusqlite::Result<DecisionRow> {
            Ok(DecisionRow {
                id: r.get(0)?,
                project_id: r.get(1)?,
                decision: r.get(2)?,
                reasoning: r.get(3)?,
                topic_key: r.get(4)?,
                revision_count: r.get(5)?,
                status: r.get(6)?,
                importance: r.get(7)?,
                obsolete_reason: r.get(8)?,
                token_count: r.get(9)?,
                tokenizer_model: r.get(10)?,
                content_hash: r.get(11)?,
                created_at: r.get(12)?,
                updated_at: r.get(13)?,
            })
        };
        let base = "SELECT id, project_id, decision, reasoning, topic_key, revision_count, status, importance, obsolete_reason, token_count, tokenizer_model, content_hash, created_at, updated_at FROM decisions";
        if let Some(pid) = project_id {
            let sql = format!("{base} WHERE project_id = ? ORDER BY COALESCE(updated_at, created_at) DESC");
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(params![pid], map)?.collect::<rusqlite::Result<_>>()?;
            Ok(rows)
        } else {
            let sql = format!("{base} ORDER BY COALESCE(updated_at, created_at) DESC");
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map([], map)?.collect::<rusqlite::Result<_>>()?;
            Ok(rows)
        }
    })
}

const TABLE: &str = "decisions";

fn normalize_importance(value: i64) -> i64 {
    value.clamp(1, 5)
}

struct ExistingDecision {
    decision: String,
    reasoning: String,
    importance: i64,
    topic_key: Option<String>,
    revision_count: i64,
}

fn read_existing(conn: &Connection, id: &str) -> Result<Option<ExistingDecision>> {
    let row = conn
        .query_row(
            "SELECT decision, reasoning, importance, topic_key, revision_count FROM decisions WHERE id = ?",
            params![id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            },
        )
        .optional()?;
    Ok(row.map(|(decision, reasoning, importance, topic_key, revision_count)| ExistingDecision {
        decision,
        reasoning,
        importance,
        topic_key,
        revision_count,
    }))
}

fn apply_update(
    conn: &Connection,
    id: &str,
    decision: Option<&str>,
    reasoning: Option<&str>,
    importance: Option<i64>,
    topic_key: Option<&str>,
) -> Result<bool> {
    if decision.is_none() && reasoning.is_none() && importance.is_none() && topic_key.is_none() {
        return Ok(true);
    }
    let Some(existing) = read_existing(conn, id)? else {
        return Ok(false);
    };

    let next_decision = decision.unwrap_or(&existing.decision);
    let next_reasoning = reasoning.unwrap_or(&existing.reasoning);
    let next_importance = importance
        .map(normalize_importance)
        .unwrap_or(existing.importance);
    let next_topic_key: Option<String> = match topic_key {
        Some(t) => normalize_topic_key(Some(t)),
        None => existing.topic_key.clone(),
    };
    let next_revision = existing.revision_count.saturating_add(1);

    let content_hash = hash_normalized(&decision_hash_source(next_decision, next_reasoning));
    let serialized = serialize_decision(&DecisionCtx {
        id,
        importance: next_importance,
        topic_key: next_topic_key.as_deref(),
        revision_count: next_revision,
        decision: next_decision,
        reasoning: next_reasoning,
    });
    let (token_count, tokenizer_model) = token_metadata(&serialized);

    let importance_param = importance.map(normalize_importance);

    conn.execute(
        "UPDATE decisions
         SET decision = COALESCE(?, decision),
             reasoning = COALESCE(?, reasoning),
             importance = COALESCE(?, importance),
             content_hash = ?,
             topic_key = ?,
             revision_count = revision_count + 1,
             token_count = ?,
             tokenizer_model = ?,
             updated_at = datetime('now')
         WHERE id = ?",
        params![
            decision,
            reasoning,
            importance_param,
            content_hash,
            next_topic_key,
            token_count,
            tokenizer_model,
            id,
        ],
    )?;
    Ok(true)
}

pub fn add(
    db: &Db,
    project_id: &str,
    decision: &str,
    reasoning: &str,
    importance: Option<i64>,
    topic_key: Option<&str>,
) -> Result<String> {
    let normalized_importance = normalize_importance(importance.unwrap_or(3));
    let final_topic_key = normalize_topic_key(topic_key);
    let content_hash = hash_normalized(&decision_hash_source(decision, reasoning));

    db.with_mut(|conn| {
        let tx = conn.transaction()?;

        let collision = match final_topic_key.as_deref() {
            Some(key) => find_active_by_topic(&tx, TABLE, project_id, key)?,
            None => find_active_by_hash(&tx, TABLE, project_id, &content_hash)?,
        };

        if let Some(existing_id) = collision {
            apply_update(
                &tx,
                &existing_id,
                Some(decision),
                Some(reasoning),
                Some(normalized_importance),
                topic_key,
            )?;
            tx.commit()?;
            return Ok(existing_id);
        }

        let id = new_uuid();
        let serialized = serialize_decision(&DecisionCtx {
            id: &id,
            importance: normalized_importance,
            topic_key: final_topic_key.as_deref(),
            revision_count: 1,
            decision,
            reasoning,
        });
        let (token_count, tokenizer_model) = token_metadata(&serialized);

        tx.execute(
            "INSERT INTO decisions (id, project_id, decision, reasoning, importance, token_count, tokenizer_model, content_hash, topic_key)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                id,
                project_id,
                decision,
                reasoning,
                normalized_importance,
                token_count,
                tokenizer_model,
                content_hash,
                final_topic_key,
            ],
        )?;
        auto_link::run(&tx, &id, "decision", project_id)?;
        tx.commit()?;
        Ok(id)
    })
}

pub fn update(
    db: &Db,
    id: &str,
    decision: Option<&str>,
    reasoning: Option<&str>,
    importance: Option<i64>,
    topic_key: Option<&str>,
) -> Result<bool> {
    db.with_mut(|conn| {
        let tx = conn.transaction()?;
        let modified = apply_update(&tx, id, decision, reasoning, importance, topic_key)?;
        tx.commit()?;
        Ok(modified)
    })
}

pub fn delete(db: &Db, id: &str) -> Result<()> {
    db.with(|conn| {
        conn.execute("DELETE FROM decisions WHERE id = ?", params![id])?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repo::projects;

    fn fresh_with_project() -> (Db, String) {
        let db = Db::new_in_memory().unwrap();
        let p = projects::upsert_force(&db, "p1", "", "development", &[]).unwrap();
        (db, p.id)
    }

    fn row_revision(db: &Db, id: &str) -> i64 {
        db.with(|conn| {
            Ok(conn
                .query_row(
                    "SELECT revision_count FROM decisions WHERE id = ?",
                    params![id],
                    |r| r.get::<_, i64>(0),
                )?)
        })
        .unwrap()
    }

    #[test]
    fn add_inserts() {
        let (db, pid) = fresh_with_project();
        let id = add(&db, &pid, "use rust", "binding hell", Some(4), None).unwrap();
        assert!(!id.is_empty());
        assert_eq!(row_revision(&db, &id), 1);
    }

    #[test]
    fn add_collides_by_topic_key_normalized() {
        let (db, pid) = fresh_with_project();
        let id1 = add(&db, &pid, "d1", "r1", Some(3), Some("Use Rust")).unwrap();
        let id2 = add(&db, &pid, "d2", "r2", Some(3), Some("use-rust")).unwrap();
        assert_eq!(id1, id2);
        assert_eq!(row_revision(&db, &id1), 2);
    }

    #[test]
    fn add_collides_by_hash_when_no_topic_key() {
        let (db, pid) = fresh_with_project();
        let id1 = add(&db, &pid, "dup", "rsn", Some(3), None).unwrap();
        let id2 = add(&db, &pid, "dup", "rsn", Some(1), None).unwrap();
        assert_eq!(id1, id2);
        assert_eq!(row_revision(&db, &id1), 2);
    }

    #[test]
    fn update_increments_revision() {
        let (db, pid) = fresh_with_project();
        let id = add(&db, &pid, "d", "r", Some(3), None).unwrap();
        update(&db, &id, Some("d2"), None, None, None).unwrap();
        assert_eq!(row_revision(&db, &id), 2);
    }

    #[test]
    fn update_missing_returns_false() {
        let (db, _) = fresh_with_project();
        let modified = update(&db, "missing", Some("x"), None, None, None).unwrap();
        assert!(!modified);
    }

    #[test]
    fn update_clamps_importance() {
        let (db, pid) = fresh_with_project();
        let id = add(&db, &pid, "d", "r", Some(3), None).unwrap();
        update(&db, &id, None, None, Some(-5), None).unwrap();
        let imp: i64 = db
            .with(|conn| {
                Ok(conn
                    .query_row(
                        "SELECT importance FROM decisions WHERE id = ?",
                        params![id],
                        |r| r.get(0),
                    )?)
            })
            .unwrap();
        assert_eq!(imp, 1);
    }

    #[test]
    fn delete_removes_row() {
        let (db, pid) = fresh_with_project();
        let id = add(&db, &pid, "d", "r", Some(3), None).unwrap();
        delete(&db, &id).unwrap();
        let exists: i64 = db
            .with(|conn| {
                Ok(conn.query_row(
                    "SELECT COUNT(*) FROM decisions WHERE id = ?",
                    params![id],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(exists, 0);
    }
}
