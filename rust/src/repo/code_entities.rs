//! Code entities: structured memory for code (modules, files, functions,
//! classes, methods, endpoints, configs, schemas). Mirrors `addCodeEntity/
//! updateCodeEntity/getCodeEntity/searchCodeEntities/getCodeEntityContext`
//! in `src/db.ts` L1533-1754.
//!
//! Differences from notes/decisions/artifacts:
//! - Collision lookup uses **only** topic_key (no content_hash path).
//! - UPDATE replaces every field unconditionally; the function reads the
//!   existing row first and merges fields it didn't receive. Don't refactor
//!   this to COALESCE — the TS depends on read-modify-write to recompute
//!   `content_hash`, `token_count`, and the topic_key cascade.
//! - `topic_key` falls back through a cascade and ultimately to
//!   `hash_normalized(name)[..120]` so it's never null.

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::hash::{code_entity_hash_source, hash_normalized, normalize_topic_key};
use crate::tokens::token_metadata;

use super::auto_link;
use super::fts::to_fts_query;
use super::identity::find_active_by_topic;
use super::serialize::{serialize_code_entity, CodeEntityCtx};
use super::{new_uuid, parse_json_array, serialize_json_array, Db};

const TABLE: &str = "code_entities";

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CodeEntity {
    pub id: String,
    pub project_id: String,
    pub kind: String,
    pub name: String,
    pub qualified_name: String,
    pub path: String,
    pub signature: String,
    pub summary: String,
    pub inputs: String,
    pub outputs: String,
    pub side_effects: String,
    pub tags: Vec<String>,
    pub status: String,
    pub importance: i64,
    pub topic_key: Option<String>,
    pub revision_count: i64,
    pub obsolete_reason: Option<String>,
    pub created_at: String,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AddCodeEntity<'a> {
    pub project_id: &'a str,
    pub kind: &'a str,
    pub name: &'a str,
    pub qualified_name: &'a str,
    pub path: &'a str,
    pub signature: &'a str,
    pub summary: &'a str,
    pub inputs: &'a str,
    pub outputs: &'a str,
    pub side_effects: &'a str,
    pub tags: &'a [String],
    pub importance: Option<i64>,
    pub topic_key: Option<&'a str>,
}

#[derive(Debug, Clone, Default)]
pub struct UpdateCodeEntity<'a> {
    pub kind: Option<&'a str>,
    pub name: Option<&'a str>,
    pub qualified_name: Option<&'a str>,
    pub path: Option<&'a str>,
    pub signature: Option<&'a str>,
    pub summary: Option<&'a str>,
    pub inputs: Option<&'a str>,
    pub outputs: Option<&'a str>,
    pub side_effects: Option<&'a str>,
    pub tags: Option<&'a [String]>,
    pub importance: Option<i64>,
    pub topic_key: Option<&'a str>,
}

impl UpdateCodeEntity<'_> {
    fn is_empty(&self) -> bool {
        self.kind.is_none()
            && self.name.is_none()
            && self.qualified_name.is_none()
            && self.path.is_none()
            && self.signature.is_none()
            && self.summary.is_none()
            && self.inputs.is_none()
            && self.outputs.is_none()
            && self.side_effects.is_none()
            && self.tags.is_none()
            && self.importance.is_none()
            && self.topic_key.is_none()
    }
}

fn normalize_importance(value: i64) -> i64 {
    value.clamp(1, 5)
}

/// Compute the `topic_key` for an INSERT. Cascade mirrors TS L1550-1553:
/// `topic_key ?? qualified_name ?? name` → normalize. If normalize fails,
/// retry with `name`. If still fails, fall back to `hash(name)[..120]`.
fn compute_topic_key_for_add(
    topic_key: Option<&str>,
    qualified_name: &str,
    name: &str,
) -> String {
    let first_input: &str = topic_key.unwrap_or(qualified_name);
    if let Some(k) = normalize_topic_key(Some(first_input)) {
        return k;
    }
    if let Some(k) = normalize_topic_key(Some(name)) {
        return k;
    }
    let mut h = hash_normalized(name);
    h.truncate(120);
    h
}

/// Topic key cascade for UPDATE. Mirrors TS L1650-1660. Candidate order:
/// `updates.topic_key`, `existing.topic_key`, `updates.qualified_name`,
/// `existing.qualified_name`. First non-None wins. Same retry+hash fallback.
fn compute_topic_key_for_update(
    upd_topic: Option<&str>,
    exist_topic: Option<&str>,
    upd_qn: Option<&str>,
    exist_qn: &str,
    final_name: &str,
) -> String {
    let candidate: &str = upd_topic
        .or(exist_topic)
        .or(upd_qn)
        .unwrap_or(exist_qn);
    if let Some(k) = normalize_topic_key(Some(candidate)) {
        return k;
    }
    if let Some(k) = normalize_topic_key(Some(final_name)) {
        return k;
    }
    let mut h = hash_normalized(final_name);
    h.truncate(120);
    h
}

struct ExistingCodeEntity {
    kind: String,
    name: String,
    qualified_name: String,
    path: String,
    signature: String,
    summary: String,
    inputs: String,
    outputs: String,
    side_effects: String,
    tags: Vec<String>,
    importance: i64,
    topic_key: Option<String>,
    revision_count: i64,
}

fn read_existing(conn: &Connection, id: &str) -> Result<Option<ExistingCodeEntity>> {
    let row = conn
        .query_row(
            "SELECT kind, name, qualified_name, path, signature, summary,
                    inputs, outputs, side_effects, tags, importance,
                    topic_key, revision_count
             FROM code_entities WHERE id = ?",
            params![id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, String>(6)?,
                    r.get::<_, String>(7)?,
                    r.get::<_, String>(8)?,
                    r.get::<_, String>(9)?,
                    r.get::<_, i64>(10)?,
                    r.get::<_, Option<String>>(11)?,
                    r.get::<_, i64>(12)?,
                ))
            },
        )
        .optional()?;
    Ok(row.map(
        |(
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
            importance,
            topic_key,
            revision_count,
        )| ExistingCodeEntity {
            kind,
            name,
            qualified_name,
            path,
            signature,
            summary,
            inputs,
            outputs,
            side_effects,
            tags: parse_json_array(&tags),
            importance,
            topic_key,
            revision_count,
        },
    ))
}

fn apply_update(conn: &Connection, id: &str, updates: &UpdateCodeEntity<'_>) -> Result<bool> {
    if updates.is_empty() {
        return Ok(true);
    }
    let Some(existing) = read_existing(conn, id)? else {
        return Ok(false);
    };

    let next_kind = updates.kind.unwrap_or(&existing.kind);
    let next_name = updates.name.unwrap_or(&existing.name);
    let next_qn = updates.qualified_name.unwrap_or(&existing.qualified_name);
    let next_path = updates.path.unwrap_or(&existing.path);
    let next_signature = updates.signature.unwrap_or(&existing.signature);
    let next_summary = updates.summary.unwrap_or(&existing.summary);
    let next_inputs = updates.inputs.unwrap_or(&existing.inputs);
    let next_outputs = updates.outputs.unwrap_or(&existing.outputs);
    let next_side_effects = updates.side_effects.unwrap_or(&existing.side_effects);
    let next_tags: Vec<String> = match updates.tags {
        Some(t) => t.to_vec(),
        None => existing.tags.clone(),
    };
    let next_importance = updates
        .importance
        .map(normalize_importance)
        .unwrap_or(existing.importance);
    let next_revision = existing.revision_count.saturating_add(1);

    let next_topic_key = compute_topic_key_for_update(
        updates.topic_key,
        existing.topic_key.as_deref(),
        updates.qualified_name,
        &existing.qualified_name,
        next_name,
    );

    let content_hash = hash_normalized(&code_entity_hash_source(
        next_kind,
        next_name,
        next_qn,
        next_path,
        next_signature,
        next_summary,
    ));
    let serialized = serialize_code_entity(&CodeEntityCtx {
        id,
        importance: next_importance,
        topic_key: Some(&next_topic_key),
        revision_count: next_revision,
        kind: next_kind,
        name: next_name,
        qualified_name: next_qn,
        path: next_path,
        signature: next_signature,
        summary: next_summary,
        inputs: next_inputs,
        outputs: next_outputs,
        side_effects: next_side_effects,
        tags: &next_tags,
    });
    let (token_count, tokenizer_model) = token_metadata(&serialized);

    conn.execute(
        "UPDATE code_entities
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
         WHERE id = ?",
        params![
            next_kind,
            next_name,
            next_qn,
            next_path,
            next_signature,
            next_summary,
            next_inputs,
            next_outputs,
            next_side_effects,
            serialize_json_array(&next_tags),
            next_importance,
            content_hash,
            next_topic_key,
            token_count,
            tokenizer_model,
            id,
        ],
    )?;
    Ok(true)
}

pub fn add(db: &Db, input: &AddCodeEntity<'_>) -> Result<String> {
    let normalized_importance = normalize_importance(input.importance.unwrap_or(3));
    let final_topic_key =
        compute_topic_key_for_add(input.topic_key, input.qualified_name, input.name);

    db.with_mut(|conn| {
        let tx = conn.transaction()?;

        if let Some(existing_id) =
            find_active_by_topic(&tx, TABLE, input.project_id, &final_topic_key)?
        {
            let updates = UpdateCodeEntity {
                kind: Some(input.kind),
                name: Some(input.name),
                qualified_name: Some(input.qualified_name),
                path: Some(input.path),
                signature: Some(input.signature),
                summary: Some(input.summary),
                inputs: Some(input.inputs),
                outputs: Some(input.outputs),
                side_effects: Some(input.side_effects),
                tags: Some(input.tags),
                importance: Some(normalized_importance),
                topic_key: Some(&final_topic_key),
            };
            apply_update(&tx, &existing_id, &updates)?;
            tx.commit()?;
            return Ok(existing_id);
        }

        let id = new_uuid();
        let content_hash = hash_normalized(&code_entity_hash_source(
            input.kind,
            input.name,
            input.qualified_name,
            input.path,
            input.signature,
            input.summary,
        ));
        let serialized = serialize_code_entity(&CodeEntityCtx {
            id: &id,
            importance: normalized_importance,
            topic_key: Some(&final_topic_key),
            revision_count: 1,
            kind: input.kind,
            name: input.name,
            qualified_name: input.qualified_name,
            path: input.path,
            signature: input.signature,
            summary: input.summary,
            inputs: input.inputs,
            outputs: input.outputs,
            side_effects: input.side_effects,
            tags: input.tags,
        });
        let (token_count, tokenizer_model) = token_metadata(&serialized);

        tx.execute(
            "INSERT INTO code_entities (
               id, project_id, kind, name, qualified_name, path, signature, summary,
               inputs, outputs, side_effects, tags, importance, token_count, tokenizer_model,
               content_hash, topic_key
             )
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                id,
                input.project_id,
                input.kind,
                input.name,
                input.qualified_name,
                input.path,
                input.signature,
                input.summary,
                input.inputs,
                input.outputs,
                input.side_effects,
                serialize_json_array(input.tags),
                normalized_importance,
                token_count,
                tokenizer_model,
                content_hash,
                final_topic_key,
            ],
        )?;
        auto_link::run(&tx, &id, "code_entity", input.project_id)?;
        tx.commit()?;
        Ok(id)
    })
}

pub fn update(db: &Db, id: &str, updates: &UpdateCodeEntity<'_>) -> Result<bool> {
    db.with_mut(|conn| {
        let tx = conn.transaction()?;
        let modified = apply_update(&tx, id, updates)?;
        tx.commit()?;
        Ok(modified)
    })
}

pub fn get(db: &Db, id: &str) -> Result<Option<CodeEntity>> {
    db.with(|conn| {
        let row = conn
            .query_row(
                "SELECT id, project_id, kind, name, qualified_name, path, signature, summary,
                        inputs, outputs, side_effects, tags, status, importance, topic_key,
                        revision_count, obsolete_reason, created_at, updated_at
                 FROM code_entities WHERE id = ?",
                params![id],
                map_full_row,
            )
            .optional()?;
        Ok(row)
    })
}

pub fn search(
    db: &Db,
    query: &str,
    project_id: Option<&str>,
    limit: i64,
    include_obsolete: bool,
) -> Result<Vec<CodeEntity>> {
    let Some(fts) = to_fts_query(query) else {
        return Ok(Vec::new());
    };
    let status_clause = if include_obsolete { "" } else { "AND c.status = 'active'" };
    db.with(|conn| {
        if let Some(pid) = project_id {
            let sql = format!(
                "SELECT c.id, c.project_id, c.kind, c.name, c.qualified_name, c.path, c.signature,
                        c.summary, c.inputs, c.outputs, c.side_effects, c.tags, c.status,
                        c.importance, c.topic_key, c.revision_count, c.obsolete_reason, c.created_at, c.updated_at
                 FROM code_entities_fts f
                 JOIN code_entities c ON f.rowid = c.rowid
                 WHERE code_entities_fts MATCH ? AND c.project_id = ? {clause}
                 ORDER BY rank
                 LIMIT ?",
                clause = status_clause
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows: Vec<CodeEntity> = stmt
                .query_map(params![fts, pid, limit], map_full_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        } else {
            let sql = format!(
                "SELECT c.id, c.project_id, c.kind, c.name, c.qualified_name, c.path, c.signature,
                        c.summary, c.inputs, c.outputs, c.side_effects, c.tags, c.status,
                        c.importance, c.topic_key, c.revision_count, c.obsolete_reason, c.created_at, c.updated_at
                 FROM code_entities_fts f
                 JOIN code_entities c ON f.rowid = c.rowid
                 WHERE code_entities_fts MATCH ? {clause}
                 ORDER BY rank
                 LIMIT ?",
                clause = status_clause
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows: Vec<CodeEntity> = stmt
                .query_map(params![fts, limit], map_full_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        }
    })
}

pub fn delete(db: &Db, id: &str) -> Result<()> {
    db.with(|conn| {
        conn.execute("DELETE FROM code_entities WHERE id = ?", params![id])?;
        Ok(())
    })
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CodeEntityContext {
    pub project_id: String,
    pub query: String,
    pub code_entities: Vec<CodeEntity>,
}

pub fn get_context(db: &Db, project_id: &str, query: &str, limit: i64) -> Result<CodeEntityContext> {
    let code_entities = search(db, query, Some(project_id), limit, false)?;
    Ok(CodeEntityContext {
        project_id: project_id.to_string(),
        query: query.to_string(),
        code_entities,
    })
}

fn map_full_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<CodeEntity> {
    Ok(CodeEntity {
        id: r.get(0)?,
        project_id: r.get(1)?,
        kind: r.get(2)?,
        name: r.get(3)?,
        qualified_name: r.get(4)?,
        path: r.get(5)?,
        signature: r.get(6)?,
        summary: r.get(7)?,
        inputs: r.get(8)?,
        outputs: r.get(9)?,
        side_effects: r.get(10)?,
        tags: parse_json_array(&r.get::<_, String>(11)?),
        status: r.get(12)?,
        importance: r.get(13)?,
        topic_key: r.get(14)?,
        revision_count: r.get(15)?,
        obsolete_reason: r.get(16)?,
        created_at: r.get(17)?,
        updated_at: r.get(18)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repo::projects;

    fn fresh_with_project() -> (Db, String) {
        let db = Db::new_in_memory().unwrap();
        let p = projects::upsert(&db, "p1", "", "development", &[]).unwrap();
        (db, p.id)
    }

    fn base_add<'a>(pid: &'a str, name: &'a str) -> AddCodeEntity<'a> {
        AddCodeEntity {
            project_id: pid,
            kind: "function",
            name,
            qualified_name: "",
            path: "",
            signature: "",
            summary: "",
            inputs: "",
            outputs: "",
            side_effects: "",
            tags: &[],
            importance: Some(3),
            topic_key: None,
        }
    }

    #[test]
    fn add_inserts_and_get_returns() {
        let (db, pid) = fresh_with_project();
        let id = add(&db, &base_add(&pid, "parseInvoiceXml")).unwrap();
        let e = get(&db, &id).unwrap().unwrap();
        assert_eq!(e.name, "parseInvoiceXml");
        assert_eq!(e.kind, "function");
        assert_eq!(e.revision_count, 1);
        // topic_key derived from name
        assert_eq!(e.topic_key.as_deref(), Some("parseinvoicexml"));
    }

    #[test]
    fn add_collides_only_by_topic_key() {
        let (db, pid) = fresh_with_project();
        let mut a = base_add(&pid, "Foo");
        a.qualified_name = "billing.foo";
        let id1 = add(&db, &a).unwrap();

        // Different name + qualified_name but same explicit topic_key → collide.
        let mut b = base_add(&pid, "Bar");
        b.topic_key = Some("billing-foo");
        let id2 = add(&db, &b).unwrap();
        assert_eq!(id1, id2);
        let e = get(&db, &id1).unwrap().unwrap();
        assert_eq!(e.name, "Bar");
        assert_eq!(e.revision_count, 2);
    }

    #[test]
    fn topic_key_falls_back_to_hash_when_name_has_no_alphanumeric() {
        let (db, pid) = fresh_with_project();
        let id = add(&db, &base_add(&pid, "!!!")).unwrap();
        let e = get(&db, &id).unwrap().unwrap();
        let tk = e.topic_key.expect("topic_key must never be null");
        assert!(!tk.is_empty());
        assert!(tk.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(tk.len() <= 120);
    }

    #[test]
    fn update_preserves_unspecified_fields() {
        let (db, pid) = fresh_with_project();
        let mut a = base_add(&pid, "Original");
        a.qualified_name = "mod.Original";
        a.path = "src/mod.rs";
        a.summary = "does something";
        a.tags = &[];
        let owned_tags = vec!["a".to_string()];
        let a = AddCodeEntity { tags: &owned_tags, ..a };
        let id = add(&db, &a).unwrap();

        // Update only `summary`. Everything else must be preserved.
        let updates = UpdateCodeEntity {
            summary: Some("updated summary"),
            ..Default::default()
        };
        update(&db, &id, &updates).unwrap();
        let e = get(&db, &id).unwrap().unwrap();
        assert_eq!(e.summary, "updated summary");
        assert_eq!(e.name, "Original");
        assert_eq!(e.qualified_name, "mod.Original");
        assert_eq!(e.path, "src/mod.rs");
        assert_eq!(e.tags, vec!["a".to_string()]);
        assert_eq!(e.revision_count, 2);
    }

    #[test]
    fn update_empty_is_noop_but_returns_true_when_exists() {
        let (db, pid) = fresh_with_project();
        let id = add(&db, &base_add(&pid, "Same")).unwrap();
        let modified = update(&db, &id, &UpdateCodeEntity::default()).unwrap();
        assert!(modified);
        let e = get(&db, &id).unwrap().unwrap();
        assert_eq!(e.revision_count, 1);
    }

    #[test]
    fn update_missing_returns_false() {
        let (db, _) = fresh_with_project();
        let modified = update(
            &db,
            "no-such-id",
            &UpdateCodeEntity { name: Some("x"), ..Default::default() },
        )
        .unwrap();
        assert!(!modified);
    }

    #[test]
    fn search_returns_match_in_project() {
        let (db, pid) = fresh_with_project();
        let mut a = base_add(&pid, "parseInvoiceXml");
        a.summary = "parses XML invoices";
        add(&db, &a).unwrap();

        let rows = search(&db, "invoices", Some(&pid), 10, false).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].name, "parseInvoiceXml");
    }

    #[test]
    fn search_empty_fts_returns_empty() {
        let (db, pid) = fresh_with_project();
        let rows = search(&db, "\"\"", Some(&pid), 10, false).unwrap();
        assert!(rows.is_empty());
    }

    #[test]
    fn delete_removes_row() {
        let (db, pid) = fresh_with_project();
        let id = add(&db, &base_add(&pid, "Trash")).unwrap();
        delete(&db, &id).unwrap();
        assert!(get(&db, &id).unwrap().is_none());
    }
}
