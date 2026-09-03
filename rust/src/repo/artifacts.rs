//! Artifacts: durable structured outputs (schemas, APIs, configs, designs,
//! plans, prompts). Mirrors `addArtifact/updateArtifact/deleteArtifact` in
//! `src/db.ts` L1403-1511. No standalone `search_artifacts` — only
//! `search_all` queries the FTS table.

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::hash::{artifact_hash_source, hash_normalized, normalize_topic_key};
use crate::tokens::token_metadata;

use super::auto_link;
use super::identity::{find_active_by_hash, find_active_by_topic};
use super::serialize::{serialize_artifact, ArtifactCtx};
use super::{new_uuid, Db};

const TABLE: &str = "artifacts";

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ArtifactRow {
    pub id: String,
    pub project_id: String,
    #[serde(rename = "type")]
    pub artifact_type: String,
    pub content: String,
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

pub fn list_all(db: &Db, project_id: Option<&str>) -> Result<Vec<ArtifactRow>> {
    db.with(|conn| {
        let map = |r: &rusqlite::Row<'_>| -> rusqlite::Result<ArtifactRow> {
            Ok(ArtifactRow {
                id: r.get(0)?,
                project_id: r.get(1)?,
                artifact_type: r.get(2)?,
                content: r.get(3)?,
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
        let base = "SELECT id, project_id, type, content, topic_key, revision_count, status, importance, obsolete_reason, token_count, tokenizer_model, content_hash, created_at, updated_at FROM artifacts";
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

pub fn get(db: &Db, id: &str) -> Result<Option<ArtifactRow>> {
    db.with(|conn| {
        let row = conn
            .query_row(
                "SELECT id, project_id, type, content, topic_key, revision_count, status, importance, obsolete_reason, token_count, tokenizer_model, content_hash, created_at, updated_at FROM artifacts WHERE id = ?",
                params![id],
                |r| {
                    Ok(ArtifactRow {
                        id: r.get(0)?,
                        project_id: r.get(1)?,
                        artifact_type: r.get(2)?,
                        content: r.get(3)?,
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
                },
            )
            .optional()?;
        Ok(row)
    })
}

fn normalize_importance(value: i64) -> i64 {
    value.clamp(1, 5)
}

struct ExistingArtifact {
    artifact_type: String,
    content: String,
    importance: i64,
    topic_key: Option<String>,
    revision_count: i64,
}

fn read_existing(conn: &Connection, id: &str) -> Result<Option<ExistingArtifact>> {
    let row = conn
        .query_row(
            "SELECT type, content, importance, topic_key, revision_count FROM artifacts WHERE id = ?",
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
    Ok(row.map(|(artifact_type, content, importance, topic_key, revision_count)| ExistingArtifact {
        artifact_type,
        content,
        importance,
        topic_key,
        revision_count,
    }))
}

fn apply_update(
    conn: &Connection,
    id: &str,
    artifact_type: Option<&str>,
    content: Option<&str>,
    importance: Option<i64>,
    topic_key: Option<&str>,
) -> Result<bool> {
    if artifact_type.is_none() && content.is_none() && importance.is_none() && topic_key.is_none() {
        return Ok(true);
    }
    let Some(existing) = read_existing(conn, id)? else {
        return Ok(false);
    };

    let next_type = artifact_type.unwrap_or(&existing.artifact_type);
    let next_content = content.unwrap_or(&existing.content);
    let next_importance = importance
        .map(normalize_importance)
        .unwrap_or(existing.importance);
    let next_topic_key: Option<String> = match topic_key {
        Some(t) => normalize_topic_key(Some(t)),
        None => existing.topic_key.clone(),
    };
    let next_revision = existing.revision_count.saturating_add(1);

    let content_hash = hash_normalized(&artifact_hash_source(next_type, next_content));
    let serialized = serialize_artifact(&ArtifactCtx {
        id,
        importance: next_importance,
        topic_key: next_topic_key.as_deref(),
        revision_count: next_revision,
        artifact_type: next_type,
        content: next_content,
    });
    let (token_count, tokenizer_model) = token_metadata(&serialized);

    let importance_param = importance.map(normalize_importance);

    conn.execute(
        "UPDATE artifacts
         SET type = COALESCE(?, type),
             content = COALESCE(?, content),
             importance = COALESCE(?, importance),
             content_hash = ?,
             topic_key = ?,
             revision_count = revision_count + 1,
             token_count = ?,
             tokenizer_model = ?,
             updated_at = datetime('now')
         WHERE id = ?",
        params![
            artifact_type,
            content,
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
    artifact_type: &str,
    content: &str,
    importance: Option<i64>,
    topic_key: Option<&str>,
) -> Result<String> {
    let normalized_importance = normalize_importance(importance.unwrap_or(3));
    let final_topic_key = normalize_topic_key(topic_key);
    let content_hash = hash_normalized(&artifact_hash_source(artifact_type, content));

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
                Some(artifact_type),
                Some(content),
                Some(normalized_importance),
                topic_key,
            )?;
            tx.commit()?;
            return Ok(existing_id);
        }

        let id = new_uuid();
        let serialized = serialize_artifact(&ArtifactCtx {
            id: &id,
            importance: normalized_importance,
            topic_key: final_topic_key.as_deref(),
            revision_count: 1,
            artifact_type,
            content,
        });
        let (token_count, tokenizer_model) = token_metadata(&serialized);

        tx.execute(
            "INSERT INTO artifacts (id, project_id, type, content, importance, token_count, tokenizer_model, content_hash, topic_key)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                id,
                project_id,
                artifact_type,
                content,
                normalized_importance,
                token_count,
                tokenizer_model,
                content_hash,
                final_topic_key,
            ],
        )?;
        auto_link::run(&tx, &id, "artifact", project_id)?;
        tx.commit()?;
        Ok(id)
    })
}

pub fn update(
    db: &Db,
    id: &str,
    artifact_type: Option<&str>,
    content: Option<&str>,
    importance: Option<i64>,
    topic_key: Option<&str>,
) -> Result<bool> {
    db.with_mut(|conn| {
        let tx = conn.transaction()?;
        let modified = apply_update(&tx, id, artifact_type, content, importance, topic_key)?;
        tx.commit()?;
        Ok(modified)
    })
}

pub fn delete(db: &Db, id: &str) -> Result<()> {
    db.with(|conn| {
        conn.execute("DELETE FROM artifacts WHERE id = ?", params![id])?;
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
                    "SELECT revision_count FROM artifacts WHERE id = ?",
                    params![id],
                    |r| r.get::<_, i64>(0),
                )?)
        })
        .unwrap()
    }

    #[test]
    fn add_inserts() {
        let (db, pid) = fresh_with_project();
        let id = add(&db, &pid, "schema", "{...}", Some(4), None).unwrap();
        assert_eq!(row_revision(&db, &id), 1);
    }

    #[test]
    fn add_collides_by_topic_key_normalized() {
        let (db, pid) = fresh_with_project();
        let id1 = add(&db, &pid, "schema", "v1", Some(3), Some("Invoice Schema")).unwrap();
        let id2 = add(&db, &pid, "schema", "v2", Some(3), Some("invoice-schema")).unwrap();
        assert_eq!(id1, id2);
        assert_eq!(row_revision(&db, &id1), 2);
    }

    #[test]
    fn add_collides_by_hash_when_no_topic_key() {
        let (db, pid) = fresh_with_project();
        let id1 = add(&db, &pid, "config", "settings", Some(3), None).unwrap();
        let id2 = add(&db, &pid, "config", "settings", Some(2), None).unwrap();
        assert_eq!(id1, id2);
        assert_eq!(row_revision(&db, &id1), 2);
    }

    #[test]
    fn update_increments_revision() {
        let (db, pid) = fresh_with_project();
        let id = add(&db, &pid, "config", "v1", Some(3), None).unwrap();
        update(&db, &id, None, Some("v2"), None, None).unwrap();
        assert_eq!(row_revision(&db, &id), 2);
    }

    #[test]
    fn update_missing_returns_false() {
        let (db, _) = fresh_with_project();
        let modified = update(&db, "missing", Some("x"), None, None, None).unwrap();
        assert!(!modified);
    }

    #[test]
    fn delete_removes_row() {
        let (db, pid) = fresh_with_project();
        let id = add(&db, &pid, "tmp", "trash", Some(3), None).unwrap();
        delete(&db, &id).unwrap();
        let exists: i64 = db
            .with(|conn| {
                Ok(conn.query_row(
                    "SELECT COUNT(*) FROM artifacts WHERE id = ?",
                    params![id],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(exists, 0);
    }
}
