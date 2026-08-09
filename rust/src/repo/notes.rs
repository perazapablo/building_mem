//! Notes: atomic durable facts. Idempotent by `topic_key` (when provided)
//! or by `content_hash` (when absent). Mirrors `addNote/updateNote/deleteNote/searchNotes`
//! in `src/db.ts` L1138-1277.

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::hash::{hash_normalized, normalize_topic_key, note_hash_source};
use crate::tokens::token_metadata;

use super::auto_link;
use super::fts::to_fts_query;
use super::identity::{find_active_by_hash, find_active_by_topic};
use super::serialize::{serialize_note, NoteCtx};
use super::{new_uuid, parse_json_array, serialize_json_array, Db};

const TABLE: &str = "notes";

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct NoteSearchRow {
    pub id: String,
    pub project_id: String,
    pub content: String,
    pub tags: Vec<String>,
    pub topic_key: Option<String>,
    pub revision_count: i64,
    pub status: String,
    pub importance: i64,
    pub created_at: String,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct NoteRow {
    pub id: String,
    pub project_id: String,
    pub content: String,
    pub tags: Vec<String>,
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

pub fn list_all(db: &Db, project_id: Option<&str>) -> Result<Vec<NoteRow>> {
    db.with(|conn| {
        let map = |r: &rusqlite::Row<'_>| -> rusqlite::Result<NoteRow> {
            Ok(NoteRow {
                id: r.get(0)?,
                project_id: r.get(1)?,
                content: r.get(2)?,
                tags: parse_json_array(&r.get::<_, String>(3)?),
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
        let base = "SELECT id, project_id, content, tags, topic_key, revision_count, status, importance, obsolete_reason, token_count, tokenizer_model, content_hash, created_at, updated_at FROM notes";
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

fn normalize_importance(value: i64) -> i64 {
    value.clamp(1, 5)
}

struct ExistingNote {
    content: String,
    tags: Vec<String>,
    importance: i64,
    topic_key: Option<String>,
    revision_count: i64,
}

fn read_existing(conn: &Connection, id: &str) -> Result<Option<ExistingNote>> {
    let row = conn
        .query_row(
            "SELECT content, tags, importance, topic_key, revision_count FROM notes WHERE id = ?",
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
    Ok(row.map(|(content, tags, importance, topic_key, revision_count)| ExistingNote {
        content,
        tags: parse_json_array(&tags),
        importance,
        topic_key,
        revision_count,
    }))
}

/// Apply an UPDATE under an already-held lock. Returns true if a row was
/// modified, false if `id` did not exist. Both `add` (after collision) and
/// the public `update` route through here so the SQL lives in one place.
fn apply_update(
    conn: &Connection,
    id: &str,
    content: Option<&str>,
    tags: Option<&[String]>,
    importance: Option<i64>,
    topic_key: Option<&str>,
) -> Result<bool> {
    if content.is_none() && tags.is_none() && importance.is_none() && topic_key.is_none() {
        return Ok(true);
    }
    let Some(existing) = read_existing(conn, id)? else {
        return Ok(false);
    };

    let next_content = content.unwrap_or(&existing.content);
    let next_tags: Vec<String> = match tags {
        Some(t) => t.to_vec(),
        None => existing.tags.clone(),
    };
    let next_importance = importance
        .map(normalize_importance)
        .unwrap_or(existing.importance);
    let next_topic_key: Option<String> = match topic_key {
        Some(t) => normalize_topic_key(Some(t)),
        None => existing.topic_key.clone(),
    };
    let next_revision = existing.revision_count.saturating_add(1);

    let content_hash = hash_normalized(&note_hash_source(next_content));
    let serialized = serialize_note(&NoteCtx {
        id,
        importance: next_importance,
        topic_key: next_topic_key.as_deref(),
        revision_count: next_revision,
        tags: &next_tags,
        content: next_content,
    });
    let (token_count, tokenizer_model) = token_metadata(&serialized);

    let importance_param = importance.map(normalize_importance);
    let tags_param = tags.map(serialize_json_array);

    conn.execute(
        "UPDATE notes
         SET content = COALESCE(?, content),
             tags = COALESCE(?, tags),
             importance = COALESCE(?, importance),
             content_hash = ?,
             topic_key = ?,
             revision_count = revision_count + 1,
             token_count = ?,
             tokenizer_model = ?,
             updated_at = datetime('now')
         WHERE id = ?",
        params![
            content,
            tags_param,
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
    content: &str,
    tags: &[String],
    importance: Option<i64>,
    topic_key: Option<&str>,
) -> Result<String> {
    let normalized_importance = normalize_importance(importance.unwrap_or(3));
    let final_topic_key = normalize_topic_key(topic_key);
    let content_hash = hash_normalized(&note_hash_source(content));

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
                Some(content),
                Some(tags),
                Some(normalized_importance),
                topic_key,
            )?;
            tx.commit()?;
            return Ok(existing_id);
        }

        let id = new_uuid();
        let serialized = serialize_note(&NoteCtx {
            id: &id,
            importance: normalized_importance,
            topic_key: final_topic_key.as_deref(),
            revision_count: 1,
            tags,
            content,
        });
        let (token_count, tokenizer_model) = token_metadata(&serialized);

        tx.execute(
            "INSERT INTO notes (id, project_id, content, tags, importance, token_count, tokenizer_model, content_hash, topic_key)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                id,
                project_id,
                content,
                serialize_json_array(tags),
                normalized_importance,
                token_count,
                tokenizer_model,
                content_hash,
                final_topic_key,
            ],
        )?;
        auto_link::run(&tx, &id, "note", project_id)?;
        tx.commit()?;
        Ok(id)
    })
}

pub fn update(
    db: &Db,
    id: &str,
    content: Option<&str>,
    tags: Option<&[String]>,
    importance: Option<i64>,
    topic_key: Option<&str>,
) -> Result<bool> {
    db.with_mut(|conn| {
        let tx = conn.transaction()?;
        let modified = apply_update(&tx, id, content, tags, importance, topic_key)?;
        tx.commit()?;
        Ok(modified)
    })
}

pub fn delete(db: &Db, id: &str) -> Result<()> {
    db.with(|conn| {
        conn.execute("DELETE FROM notes WHERE id = ?", params![id])?;
        Ok(())
    })
}

pub fn search(
    db: &Db,
    query: &str,
    project_id: Option<&str>,
    limit: i64,
    include_obsolete: bool,
) -> Result<Vec<NoteSearchRow>> {
    let Some(fts) = to_fts_query(query) else {
        return Ok(Vec::new());
    };
    let status_clause = if include_obsolete { "" } else { "AND n.status = 'active'" };
    db.with(|conn| {
        if let Some(pid) = project_id {
            let sql = format!(
                "SELECT n.id, n.project_id, n.content, n.tags, n.topic_key, n.revision_count, n.status, n.importance, n.created_at, n.updated_at
                 FROM notes_fts f
                 JOIN notes n ON f.rowid = n.rowid
                 WHERE notes_fts MATCH ? AND n.project_id = ? {clause}
                 ORDER BY rank
                 LIMIT ?",
                clause = status_clause
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows: Vec<NoteSearchRow> = stmt
                .query_map(params![fts, pid, limit], map_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        } else {
            let sql = format!(
                "SELECT n.id, n.project_id, n.content, n.tags, n.topic_key, n.revision_count, n.status, n.importance, n.created_at, n.updated_at
                 FROM notes_fts f
                 JOIN notes n ON f.rowid = n.rowid
                 WHERE notes_fts MATCH ? {clause}
                 ORDER BY rank
                 LIMIT ?",
                clause = status_clause
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows: Vec<NoteSearchRow> = stmt
                .query_map(params![fts, limit], map_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        }
    })
}

fn map_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<NoteSearchRow> {
    Ok(NoteSearchRow {
        id: r.get(0)?,
        project_id: r.get(1)?,
        content: r.get(2)?,
        tags: parse_json_array(&r.get::<_, String>(3)?),
        topic_key: r.get(4)?,
        revision_count: r.get(5)?,
        status: r.get(6)?,
        importance: r.get(7)?,
        created_at: r.get(8)?,
        updated_at: r.get(9)?,
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

    #[test]
    fn add_inserts_and_returns_id() {
        let (db, pid) = fresh_with_project();
        let id = add(&db, &pid, "hola", &["greeting".into()], Some(4), None).unwrap();
        assert!(!id.is_empty());

        let rows = search(&db, "hola", Some(&pid), 5, false).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, id);
        assert_eq!(rows[0].importance, 4);
        assert_eq!(rows[0].tags, vec!["greeting".to_string()]);
        assert_eq!(rows[0].revision_count, 1);
    }

    #[test]
    fn add_collides_by_topic_key_normalized() {
        let (db, pid) = fresh_with_project();
        let id1 = add(&db, &pid, "v1", &[], Some(3), Some("Foo Bar")).unwrap();
        let id2 = add(&db, &pid, "v2", &[], Some(3), Some("foo-bar")).unwrap();
        assert_eq!(id1, id2, "normalized topic_key must collide");

        let rows = search(&db, "v2", Some(&pid), 5, false).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].content, "v2");
        assert_eq!(rows[0].revision_count, 2);
    }

    #[test]
    fn add_collides_by_hash_when_no_topic_key() {
        let (db, pid) = fresh_with_project();
        let id1 = add(&db, &pid, "duplicate body", &[], Some(3), None).unwrap();
        let id2 = add(&db, &pid, "duplicate body", &["new".into()], Some(2), None).unwrap();
        assert_eq!(id1, id2);

        let rows = search(&db, "duplicate", Some(&pid), 5, false).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].tags, vec!["new".to_string()]);
        assert_eq!(rows[0].importance, 2);
        assert_eq!(rows[0].revision_count, 2);
    }

    #[test]
    fn update_with_all_none_is_noop_but_existing() {
        let (db, pid) = fresh_with_project();
        let id = add(&db, &pid, "x", &[], Some(3), None).unwrap();
        let modified = update(&db, &id, None, None, None, None).unwrap();
        assert!(modified);
        let rows = search(&db, "x", Some(&pid), 5, false).unwrap();
        assert_eq!(rows[0].revision_count, 1);
    }

    #[test]
    fn update_missing_returns_false() {
        let (db, _) = fresh_with_project();
        let modified = update(&db, "missing", Some("new"), None, None, None).unwrap();
        assert!(!modified);
    }

    #[test]
    fn update_increments_revision_count() {
        let (db, pid) = fresh_with_project();
        let id = add(&db, &pid, "orig", &[], Some(3), None).unwrap();
        update(&db, &id, Some("changed"), None, None, None).unwrap();
        update(&db, &id, Some("changed-again"), None, None, None).unwrap();
        let rows = search(&db, "changed", Some(&pid), 5, false).unwrap();
        assert_eq!(rows[0].revision_count, 3);
    }

    #[test]
    fn update_clamps_importance() {
        let (db, pid) = fresh_with_project();
        let id = add(&db, &pid, "x", &[], Some(3), None).unwrap();
        update(&db, &id, None, None, Some(99), None).unwrap();
        let rows = search(&db, "x", Some(&pid), 5, false).unwrap();
        assert_eq!(rows[0].importance, 5);
    }

    #[test]
    fn delete_removes_row() {
        let (db, pid) = fresh_with_project();
        let id = add(&db, &pid, "kill me", &[], Some(3), None).unwrap();
        delete(&db, &id).unwrap();
        let rows = search(&db, "kill", Some(&pid), 5, false).unwrap();
        assert!(rows.is_empty());
    }

    #[test]
    fn search_empty_fts_query_returns_empty() {
        let (db, pid) = fresh_with_project();
        add(&db, &pid, "hello world", &[], Some(3), None).unwrap();
        let rows = search(&db, "\"\"", Some(&pid), 5, false).unwrap();
        assert!(rows.is_empty());
    }

    #[test]
    fn search_excludes_obsolete_by_default() {
        let (db, pid) = fresh_with_project();
        let id = add(&db, &pid, "obsoleto", &[], Some(3), None).unwrap();
        db.with(|conn| {
            conn.execute("UPDATE notes SET status = 'obsolete' WHERE id = ?", params![id])?;
            Ok(())
        })
        .unwrap();
        let rows = search(&db, "obsoleto", Some(&pid), 5, false).unwrap();
        assert!(rows.is_empty());
        let rows = search(&db, "obsoleto", Some(&pid), 5, true).unwrap();
        assert_eq!(rows.len(), 1);
    }
}
