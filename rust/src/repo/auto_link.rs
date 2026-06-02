//! Auto-link rules invoked after `add_*` for any of the 4 entity types.
//! Mirrors `runAutoLinkRules` + `getEntityAutoLinkInfo` in `src/db.ts`
//! L2658-2872.
//!
//! Four rules:
//! 1. **structural_sibling** — code_entities sharing the same file `path`.
//!    Confidence 0.9, auto-accepted.
//! 2. **topically_related** — entities in the same project that share ≥2
//!    tags. Confidence `min(0.9, 0.5 + shared*0.1)`, pending.
//! 3. **variant_of** — same entity type with a `topic_key` sharing a prefix
//!    of ≥6 chars (cap at len-1, max 20). Confidence 0.8, auto-accepted.
//! 4. **semantically_related** — FTS5 top hits in same project, rank ≥ -8,
//!    top 3 only. Confidence tiers 0.75/0.65/0.55, pending.

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};

use super::fts::to_fts_query;
use super::relations::{upsert_in_tx, UpsertRelationParams};
use super::parse_json_array;

#[derive(Debug)]
struct LinkInfo {
    query: String,
    tags: Vec<String>,
    path: Option<String>,
    topic_key: Option<String>,
}

const CONFIDENCE_TIERS: &[f64] = &[0.75, 0.65, 0.55];

const FTS_TARGETS: &[(&str, &str, &str)] = &[
    ("notes_fts", "notes", "note"),
    ("decisions_fts", "decisions", "decision"),
    ("artifacts_fts", "artifacts", "artifact"),
    ("code_entities_fts", "code_entities", "code_entity"),
];

const TAG_TARGETS: &[(&str, &str)] = &[
    ("notes", "note"),
    ("decisions", "decision"),
    ("artifacts", "artifact"),
    ("code_entities", "code_entity"),
];

fn table_for(entity_type: &str) -> Option<&'static str> {
    match entity_type {
        "note" => Some("notes"),
        "decision" => Some("decisions"),
        "artifact" => Some("artifacts"),
        "code_entity" => Some("code_entities"),
        _ => None,
    }
}

fn get_link_info(conn: &Connection, entity_type: &str, id: &str) -> Result<Option<LinkInfo>> {
    let info = match entity_type {
        "note" => {
            let row: Option<(String, String, Option<String>)> = conn
                .query_row(
                    "SELECT content, tags, topic_key FROM notes WHERE id = ?",
                    params![id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?;
            row.map(|(content, tags, topic_key)| LinkInfo {
                query: topic_key
                    .clone()
                    .unwrap_or_else(|| content.chars().take(150).collect()),
                tags: parse_json_array(&tags),
                path: None,
                topic_key,
            })
        }
        "decision" => {
            let row: Option<(String, String, Option<String>)> = conn
                .query_row(
                    "SELECT decision, tags, topic_key FROM decisions WHERE id = ?",
                    params![id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?;
            row.map(|(decision, tags, topic_key)| LinkInfo {
                query: topic_key
                    .clone()
                    .unwrap_or_else(|| decision.chars().take(150).collect()),
                tags: parse_json_array(&tags),
                path: None,
                topic_key,
            })
        }
        "artifact" => {
            let row: Option<(String, String, String, Option<String>)> = conn
                .query_row(
                    "SELECT type, content, tags, topic_key FROM artifacts WHERE id = ?",
                    params![id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
                .optional()?;
            row.map(|(ty, content, tags, topic_key)| {
                let fallback: String = format!("{} {}", ty, content.chars().take(100).collect::<String>());
                LinkInfo {
                    query: topic_key.clone().unwrap_or(fallback),
                    tags: parse_json_array(&tags),
                    path: None,
                    topic_key,
                }
            })
        }
        "code_entity" => {
            let row: Option<(String, String, String, String, Option<String>, String)> = conn
                .query_row(
                    "SELECT name, qualified_name, summary, tags, topic_key, path FROM code_entities WHERE id = ?",
                    params![id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
                )
                .optional()?;
            row.map(|(name, qn, summary, tags, topic_key, path)| {
                let head = if qn.is_empty() { name.clone() } else { qn.clone() };
                let fallback: String = format!("{} {}", head, summary).chars().take(150).collect();
                LinkInfo {
                    query: topic_key.clone().unwrap_or(fallback),
                    tags: parse_json_array(&tags),
                    path: if path.is_empty() { None } else { Some(path) },
                    topic_key,
                }
            })
        }
        _ => None,
    };
    Ok(info)
}

/// Run all four rules against an entity inside an active transaction. Idempotent
/// thanks to `relations::upsert_in_tx` using `compute_relation_sync_id`.
pub fn run(conn: &Connection, id: &str, entity_type: &str, project_id: &str) -> Result<()> {
    let Some(info) = get_link_info(conn, entity_type, id)? else {
        return Ok(());
    };

    // Rule 1: structural_sibling (code_entities only)
    if entity_type == "code_entity" {
        if let Some(path) = info.path.as_deref() {
            let mut stmt = conn.prepare(
                "SELECT id FROM code_entities
                 WHERE project_id = ? AND path = ? AND id != ? AND status = 'active'",
            )?;
            let siblings: Vec<String> = stmt
                .query_map(params![project_id, path, id], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<_>>()?;
            for sib in siblings {
                upsert_in_tx(
                    conn,
                    &UpsertRelationParams {
                        source_type: entity_type,
                        source_id: id,
                        target_type: "code_entity",
                        target_id: &sib,
                        relation: "structural_sibling",
                        reason: &format!("Both defined in {}", path),
                        evidence: &format!("path = {}", path),
                        confidence: Some(0.9),
                        judgment_status: Some("accepted"),
                        marked_by_actor: "mcp-memory",
                        marked_by_kind: Some("auto-rule"),
                        ..Default::default()
                    },
                )?;
            }
        }
    }

    // Rule 2: topically_related (≥ 2 shared tags)
    if info.tags.len() >= 2 {
        for (table, target_type) in TAG_TARGETS {
            let sql = format!(
                "SELECT id, tags FROM {table}
                 WHERE project_id = ? AND id != ? AND status = 'active' AND tags != '[]'"
            );
            let mut stmt = conn.prepare(&sql)?;
            let rows: Vec<(String, String)> = stmt
                .query_map(params![project_id, id], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })?
                .collect::<rusqlite::Result<_>>()?;
            for (candidate_id, tags_raw) in rows {
                let candidate_tags = parse_json_array(&tags_raw);
                let shared: Vec<&String> = info
                    .tags
                    .iter()
                    .filter(|t| candidate_tags.contains(t))
                    .collect();
                if shared.len() >= 2 {
                    let confidence = (0.5_f64 + shared.len() as f64 * 0.1).min(0.9);
                    let reason = format!(
                        "Shared tags: {}",
                        shared
                            .iter()
                            .map(|s| s.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    );
                    let evidence = format!("{} common tags", shared.len());
                    upsert_in_tx(
                        conn,
                        &UpsertRelationParams {
                            source_type: entity_type,
                            source_id: id,
                            target_type: target_type,
                            target_id: &candidate_id,
                            relation: "topically_related",
                            reason: &reason,
                            evidence: &evidence,
                            confidence: Some(confidence),
                            judgment_status: Some("pending"),
                            marked_by_actor: "mcp-memory",
                            marked_by_kind: Some("auto-rule"),
                            ..Default::default()
                        },
                    )?;
                }
            }
        }
    }

    // Rule 3: variant_of (same type, topic_key prefix ≥ 6 chars)
    if let Some(topic_key) = info.topic_key.as_deref() {
        if topic_key.len() >= 6 {
            if let Some(table) = table_for(entity_type) {
                let cap_end = topic_key.len().saturating_sub(1).min(20);
                let prefix = &topic_key[..cap_end];
                let like = format!("{}%", prefix);
                let sql = format!(
                    "SELECT id, topic_key FROM {table}
                     WHERE project_id = ? AND id != ? AND status = 'active'
                       AND topic_key LIKE ? AND topic_key != ?"
                );
                let mut stmt = conn.prepare(&sql)?;
                let variants: Vec<(String, String)> = stmt
                    .query_map(params![project_id, id, like, topic_key], |r| {
                        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                    })?
                    .collect::<rusqlite::Result<_>>()?;
                for (vid, vtk) in variants {
                    let reason = format!("Shared topic key prefix: {}", prefix);
                    let evidence = format!("topic_keys: {} / {}", topic_key, vtk);
                    upsert_in_tx(
                        conn,
                        &UpsertRelationParams {
                            source_type: entity_type,
                            source_id: id,
                            target_type: entity_type,
                            target_id: &vid,
                            relation: "variant_of",
                            reason: &reason,
                            evidence: &evidence,
                            confidence: Some(0.8),
                            judgment_status: Some("accepted"),
                            marked_by_actor: "mcp-memory",
                            marked_by_kind: Some("auto-rule"),
                            ..Default::default()
                        },
                    )?;
                }
            }
        }
    }

    // Rule 4: semantically_related (FTS5 top 3, rank ≥ -8)
    let Some(fts_query) = to_fts_query(&info.query) else {
        return Ok(());
    };
    for (fts_table, data_table, target_type) in FTS_TARGETS {
        let sql = format!(
            "SELECT d.id, rank
             FROM {fts_table} f
             JOIN {data_table} d ON f.rowid = d.rowid
             WHERE {fts_table} MATCH ? AND d.project_id = ? AND d.status = 'active'
             ORDER BY rank
             LIMIT 4"
        );
        let mut stmt = conn.prepare(&sql)?;
        let candidates: Vec<(String, f64)> = stmt
            .query_map(params![fts_query, project_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?))
            })?
            .collect::<rusqlite::Result<_>>()?;
        let filtered: Vec<(String, f64)> = candidates
            .into_iter()
            .filter(|(rid, rank)| rid != id && *rank >= -8.0)
            .take(3)
            .collect();
        for (i, (tid, rank)) in filtered.iter().enumerate() {
            let confidence = CONFIDENCE_TIERS.get(i).copied().unwrap_or(0.55);
            let evidence = format!("rank: {:.3}, position: {}", rank, i + 1);
            upsert_in_tx(
                conn,
                &UpsertRelationParams {
                    source_type: entity_type,
                    source_id: id,
                    target_type: target_type,
                    target_id: tid,
                    relation: "semantically_related",
                    reason: "FTS5 content similarity",
                    evidence: &evidence,
                    confidence: Some(confidence),
                    judgment_status: Some("pending"),
                    marked_by_actor: "mcp-memory",
                    marked_by_kind: Some("auto-rule"),
                    ..Default::default()
                },
            )?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::repo::{code_entities, notes, projects, Db};

    fn fresh_with_project() -> (Db, String) {
        let db = Db::new_in_memory().unwrap();
        let p = projects::upsert(&db, "p1", "", "development", &[]).unwrap();
        (db, p.id)
    }

    #[test]
    fn structural_sibling_auto_created_for_same_path() {
        let (db, pid) = fresh_with_project();
        let mut a = code_entities::AddCodeEntity {
            project_id: &pid,
            kind: "function",
            name: "fnA",
            qualified_name: "",
            path: "src/mod.rs",
            signature: "",
            summary: "",
            inputs: "",
            outputs: "",
            side_effects: "",
            tags: &[],
            importance: Some(3),
            topic_key: None,
        };
        let id_a = code_entities::add(&db, &a).unwrap();
        a.name = "fnB";
        let id_b = code_entities::add(&db, &a).unwrap();

        let count: i64 = db
            .with(|conn| {
                Ok(conn.query_row(
                    "SELECT COUNT(*) FROM memory_relations
                     WHERE relation = 'structural_sibling' AND judgment_status = 'accepted'",
                    [],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        assert!(count >= 1, "expected ≥1 structural_sibling created");
        let _ = (id_a, id_b);
    }

    #[test]
    fn topically_related_auto_created_for_shared_tags() {
        let (db, pid) = fresh_with_project();
        notes::add(
            &db,
            &pid,
            "first",
            &["x".into(), "y".into(), "z".into()],
            Some(3),
            None,
        )
        .unwrap();
        notes::add(
            &db,
            &pid,
            "second",
            &["x".into(), "y".into()],
            Some(3),
            None,
        )
        .unwrap();

        let count: i64 = db
            .with(|conn| {
                Ok(conn.query_row(
                    "SELECT COUNT(*) FROM memory_relations
                     WHERE relation = 'topically_related'",
                    [],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        assert!(count >= 1, "expected ≥1 topically_related created");
    }

    #[test]
    fn variant_of_auto_created_for_topic_key_prefix() {
        let (db, pid) = fresh_with_project();
        notes::add(&db, &pid, "v1", &[], Some(3), Some("billing-invoice-parser-v1")).unwrap();
        notes::add(&db, &pid, "v2", &[], Some(3), Some("billing-invoice-parser-v2")).unwrap();

        let count: i64 = db
            .with(|conn| {
                Ok(conn.query_row(
                    "SELECT COUNT(*) FROM memory_relations
                     WHERE relation = 'variant_of' AND judgment_status = 'accepted'",
                    [],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        assert!(count >= 1, "expected ≥1 variant_of created");
    }
}
