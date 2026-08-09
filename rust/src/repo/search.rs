//! Cross-entity FTS5 search.
//!
//! Runs four FTS queries (notes / decisions / artifacts / code_entities)
//! inside a single `db.with` so the snapshot is consistent, merges the
//! results, and sorts by `(rank ASC, importance DESC)`. `limit` is clamped
//! to `[1, 50]`. Content fields are truncated to a ~200 char snippet — the
//! caller fetches the full payload via `get_*` when needed.
//!
//! `project_id` is required: no cross-project search.

use anyhow::Result;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::cmp::Ordering;

use super::fts::to_fts_query;
use super::{parse_json_array, Db};

const SNIPPET_MAX_CHARS: usize = 200;

/// Truncate a string to at most `max` chars, appending an ellipsis when
/// it was cut. Char-based, so it never splits a UTF-8 code point.
fn snippet(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SearchAllResult {
    Note {
        id: String,
        project_id: String,
        title: String,
        summary: String,
        status: String,
        importance: i64,
        created_at: String,
        updated_at: Option<String>,
        rank: f64,
        content: String,
        tags: Vec<String>,
        topic_key: Option<String>,
        revision_count: i64,
        obsolete_reason: Option<String>,
    },
    Decision {
        id: String,
        project_id: String,
        title: String,
        summary: String,
        status: String,
        importance: i64,
        created_at: String,
        updated_at: Option<String>,
        rank: f64,
        decision: String,
        reasoning: String,
        topic_key: Option<String>,
        revision_count: i64,
        obsolete_reason: Option<String>,
    },
    Artifact {
        id: String,
        project_id: String,
        title: String,
        summary: String,
        status: String,
        importance: i64,
        created_at: String,
        updated_at: Option<String>,
        rank: f64,
        artifact_type: String,
        content: String,
        topic_key: Option<String>,
        revision_count: i64,
        obsolete_reason: Option<String>,
    },
    CodeEntity {
        id: String,
        project_id: String,
        title: String,
        summary: String,
        status: String,
        importance: i64,
        created_at: String,
        updated_at: Option<String>,
        rank: f64,
        kind: String,
        name: String,
        qualified_name: String,
        path: String,
        signature: String,
        inputs: String,
        outputs: String,
        side_effects: String,
        tags: Vec<String>,
        topic_key: Option<String>,
        revision_count: i64,
        obsolete_reason: Option<String>,
    },
}

impl SearchAllResult {
    fn rank(&self) -> f64 {
        match self {
            SearchAllResult::Note { rank, .. }
            | SearchAllResult::Decision { rank, .. }
            | SearchAllResult::Artifact { rank, .. }
            | SearchAllResult::CodeEntity { rank, .. } => *rank,
        }
    }

    fn importance(&self) -> i64 {
        match self {
            SearchAllResult::Note { importance, .. }
            | SearchAllResult::Decision { importance, .. }
            | SearchAllResult::Artifact { importance, .. }
            | SearchAllResult::CodeEntity { importance, .. } => *importance,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchAllResponse {
    pub query: String,
    pub project_id: String,
    pub include_obsolete: bool,
    pub limit: i64,
    pub results: Vec<SearchAllResult>,
}

pub fn search_all(
    db: &Db,
    query: &str,
    project_id: &str,
    limit: i64,
    include_obsolete: bool,
) -> Result<SearchAllResponse> {
    let limited = limit.clamp(1, 50);
    let Some(fts) = to_fts_query(query) else {
        return Ok(SearchAllResponse {
            query: query.to_string(),
            project_id: project_id.to_string(),
            include_obsolete,
            limit: limited,
            results: Vec::new(),
        });
    };

    db.with(|conn| {
        let mut results: Vec<SearchAllResult> = Vec::new();
        results.extend(query_notes(conn, &fts, project_id, limited, include_obsolete)?);
        results.extend(query_decisions(conn, &fts, project_id, limited, include_obsolete)?);
        results.extend(query_artifacts(conn, &fts, project_id, limited, include_obsolete)?);
        results.extend(query_code_entities(conn, &fts, project_id, limited, include_obsolete)?);

        results.sort_by(|a, b| {
            a.rank()
                .partial_cmp(&b.rank())
                .unwrap_or(Ordering::Equal)
                .then(b.importance().cmp(&a.importance()))
        });
        results.truncate(limited as usize);

        Ok(SearchAllResponse {
            query: query.to_string(),
            project_id: project_id.to_string(),
            include_obsolete,
            limit: limited,
            results,
        })
    })
}

fn query_notes(
    conn: &Connection,
    fts: &str,
    project_id: &str,
    limit: i64,
    include_obsolete: bool,
) -> Result<Vec<SearchAllResult>> {
    let status_filter = if include_obsolete { "" } else { "AND n.status = 'active'" };
    let sql = format!(
        "SELECT n.id, n.project_id, n.content, n.status, n.importance, n.created_at, n.updated_at, rank,
                n.tags, n.topic_key, n.revision_count, n.obsolete_reason
         FROM notes_fts f
         JOIN notes n ON f.rowid = n.rowid
         WHERE notes_fts MATCH ? AND n.project_id = ? {status_filter}
         ORDER BY rank
         LIMIT ?"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows: Vec<SearchAllResult> = stmt
        .query_map(params![fts, project_id, limit], |r| {
            let content: String = r.get(2)?;
            let snip = snippet(&content, SNIPPET_MAX_CHARS);
            Ok(SearchAllResult::Note {
                id: r.get(0)?,
                project_id: r.get(1)?,
                title: snip.clone(),
                summary: snip.clone(),
                content: snip,
                status: r.get(3)?,
                importance: r.get(4)?,
                created_at: r.get(5)?,
                updated_at: r.get(6)?,
                rank: r.get(7)?,
                tags: parse_json_array(&r.get::<_, String>(8)?),
                topic_key: r.get(9)?,
                revision_count: r.get(10)?,
                obsolete_reason: r.get(11)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn query_decisions(
    conn: &Connection,
    fts: &str,
    project_id: &str,
    limit: i64,
    include_obsolete: bool,
) -> Result<Vec<SearchAllResult>> {
    let status_filter = if include_obsolete { "" } else { "AND d.status = 'active'" };
    let sql = format!(
        "SELECT d.id, d.project_id, d.decision, d.reasoning, d.status, d.importance, d.created_at, d.updated_at, rank,
                d.topic_key, d.revision_count, d.obsolete_reason
         FROM decisions_fts f
         JOIN decisions d ON f.rowid = d.rowid
         WHERE decisions_fts MATCH ? AND d.project_id = ? {status_filter}
         ORDER BY rank
         LIMIT ?"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows: Vec<SearchAllResult> = stmt
        .query_map(params![fts, project_id, limit], |r| {
            let decision: String = r.get(2)?;
            let reasoning: String = r.get(3)?;
            let dec_snip = snippet(&decision, SNIPPET_MAX_CHARS);
            let rea_snip = snippet(&reasoning, SNIPPET_MAX_CHARS);
            Ok(SearchAllResult::Decision {
                id: r.get(0)?,
                project_id: r.get(1)?,
                title: dec_snip.clone(),
                summary: rea_snip.clone(),
                decision: dec_snip,
                reasoning: rea_snip,
                status: r.get(4)?,
                importance: r.get(5)?,
                created_at: r.get(6)?,
                updated_at: r.get(7)?,
                rank: r.get(8)?,
                topic_key: r.get(9)?,
                revision_count: r.get(10)?,
                obsolete_reason: r.get(11)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn query_artifacts(
    conn: &Connection,
    fts: &str,
    project_id: &str,
    limit: i64,
    include_obsolete: bool,
) -> Result<Vec<SearchAllResult>> {
    let status_filter = if include_obsolete { "" } else { "AND a.status = 'active'" };
    let sql = format!(
        "SELECT a.id, a.project_id, a.type, a.content, a.status, a.importance, a.created_at, a.updated_at, rank,
                a.topic_key, a.revision_count, a.obsolete_reason
         FROM artifacts_fts f
         JOIN artifacts a ON f.rowid = a.rowid
         WHERE artifacts_fts MATCH ? AND a.project_id = ? {status_filter}
         ORDER BY rank
         LIMIT ?"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows: Vec<SearchAllResult> = stmt
        .query_map(params![fts, project_id, limit], |r| {
            let ty: String = r.get(2)?;
            let content: String = r.get(3)?;
            let snip = snippet(&content, SNIPPET_MAX_CHARS);
            Ok(SearchAllResult::Artifact {
                id: r.get(0)?,
                project_id: r.get(1)?,
                title: ty.clone(),
                summary: snip.clone(),
                artifact_type: ty,
                content: snip,
                status: r.get(4)?,
                importance: r.get(5)?,
                created_at: r.get(6)?,
                updated_at: r.get(7)?,
                rank: r.get(8)?,
                topic_key: r.get(9)?,
                revision_count: r.get(10)?,
                obsolete_reason: r.get(11)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn query_code_entities(
    conn: &Connection,
    fts: &str,
    project_id: &str,
    limit: i64,
    include_obsolete: bool,
) -> Result<Vec<SearchAllResult>> {
    let status_filter = if include_obsolete { "" } else { "AND c.status = 'active'" };
    let sql = format!(
        "SELECT c.id, c.project_id, c.name, c.summary, c.status, c.importance, c.created_at, c.updated_at, rank,
                c.kind, c.qualified_name, c.path, c.signature, c.inputs, c.outputs, c.side_effects,
                c.tags, c.topic_key, c.revision_count, c.obsolete_reason
         FROM code_entities_fts f
         JOIN code_entities c ON f.rowid = c.rowid
         WHERE code_entities_fts MATCH ? AND c.project_id = ? {status_filter}
         ORDER BY rank
         LIMIT ?"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows: Vec<SearchAllResult> = stmt
        .query_map(params![fts, project_id, limit], |r| {
            let name: String = r.get(2)?;
            let summary: String = r.get(3)?;
            let signature: String = r.get(12)?;
            let inputs: String = r.get(13)?;
            let outputs: String = r.get(14)?;
            let side_effects: String = r.get(15)?;
            let sum_snip = snippet(&summary, SNIPPET_MAX_CHARS);
            Ok(SearchAllResult::CodeEntity {
                id: r.get(0)?,
                project_id: r.get(1)?,
                title: name.clone(),
                summary: sum_snip,
                name,
                status: r.get(4)?,
                importance: r.get(5)?,
                created_at: r.get(6)?,
                updated_at: r.get(7)?,
                rank: r.get(8)?,
                kind: r.get(9)?,
                qualified_name: r.get(10)?,
                path: r.get(11)?,
                signature: snippet(&signature, SNIPPET_MAX_CHARS),
                inputs: snippet(&inputs, SNIPPET_MAX_CHARS),
                outputs: snippet(&outputs, SNIPPET_MAX_CHARS),
                side_effects: snippet(&side_effects, SNIPPET_MAX_CHARS),
                tags: parse_json_array(&r.get::<_, String>(16)?),
                topic_key: r.get(17)?,
                revision_count: r.get(18)?,
                obsolete_reason: r.get(19)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repo::{artifacts, code_entities, decisions, notes, projects};

    fn fresh_with_project() -> (Db, String) {
        let db = Db::new_in_memory().unwrap();
        let p = projects::upsert_force(&db, "p1", "", "development", &[]).unwrap();
        (db, p.id)
    }

    #[test]
    fn snippet_short_string_is_unchanged() {
        assert_eq!(snippet("abc", 200), "abc");
    }

    #[test]
    fn snippet_truncates_and_appends_ellipsis() {
        let long: String = "a".repeat(500);
        let out = snippet(&long, 200);
        assert_eq!(out.chars().count(), 201); // 200 + '…'
        assert!(out.ends_with('…'));
    }

    #[test]
    fn snippet_respects_utf8_boundary() {
        // Multibyte chars: 'á' is 2 bytes but 1 char.
        let s = "á".repeat(300);
        let out = snippet(&s, 200);
        assert_eq!(out.chars().count(), 201);
    }

    #[test]
    fn empty_fts_query_returns_empty() {
        let (db, pid) = fresh_with_project();
        let r = search_all(&db, "\"\"", &pid, 10, false).unwrap();
        assert!(r.results.is_empty());
        assert_eq!(r.limit, 10);
    }

    #[test]
    fn limit_clamps_to_range() {
        let (db, pid) = fresh_with_project();
        let r = search_all(&db, "anything", &pid, 999, false).unwrap();
        assert_eq!(r.limit, 50);
        let r = search_all(&db, "anything", &pid, -3, false).unwrap();
        assert_eq!(r.limit, 1);
    }

    #[test]
    fn merges_four_entity_types() {
        let (db, pid) = fresh_with_project();
        notes::add(&db, &pid, "shared word alpha", &[], Some(3), None).unwrap();
        decisions::add(&db, &pid, "shared decision", "alpha reasoning", Some(3), None).unwrap();
        artifacts::add(&db, &pid, "schema", "alpha artifact content", Some(3), None).unwrap();
        let ce = code_entities::AddCodeEntity {
            project_id: &pid,
            kind: "function",
            name: "alphaFn",
            qualified_name: "",
            path: "",
            signature: "",
            summary: "handles alpha",
            inputs: "",
            outputs: "",
            side_effects: "",
            tags: &[],
            importance: Some(3),
            topic_key: None,
        };
        code_entities::add(&db, &ce).unwrap();

        let r = search_all(&db, "alpha", &pid, 20, false).unwrap();
        assert_eq!(r.results.len(), 4, "expected one hit per entity type");

        // Verify each variant present
        let mut has_note = false;
        let mut has_decision = false;
        let mut has_artifact = false;
        let mut has_code = false;
        for h in &r.results {
            match h {
                SearchAllResult::Note { .. } => has_note = true,
                SearchAllResult::Decision { .. } => has_decision = true,
                SearchAllResult::Artifact { .. } => has_artifact = true,
                SearchAllResult::CodeEntity { .. } => has_code = true,
            }
        }
        assert!(has_note && has_decision && has_artifact && has_code);
    }

    #[test]
    fn excludes_obsolete_by_default() {
        let (db, pid) = fresh_with_project();
        let id = notes::add(&db, &pid, "obsolete alpha", &[], Some(3), None).unwrap();
        db.with(|conn| {
            conn.execute(
                "UPDATE notes SET status = 'obsolete' WHERE id = ?",
                rusqlite::params![id],
            )?;
            Ok(())
        })
        .unwrap();
        let r = search_all(&db, "alpha", &pid, 20, false).unwrap();
        assert_eq!(r.results.len(), 0);
        let r = search_all(&db, "alpha", &pid, 20, true).unwrap();
        assert_eq!(r.results.len(), 1);
    }

    #[test]
    fn project_filter_excludes_other_projects() {
        let db = Db::new_in_memory().unwrap();
        let p1 = projects::upsert_force(&db, "p1", "", "development", &[]).unwrap();
        let p2 = projects::upsert_force(&db, "p2", "", "development", &[]).unwrap();
        notes::add(&db, &p1.id, "alpha in p1", &[], Some(3), None).unwrap();
        notes::add(&db, &p2.id, "alpha in p2", &[], Some(3), None).unwrap();

        let r = search_all(&db, "alpha", &p1.id, 20, false).unwrap();
        assert_eq!(r.results.len(), 1);
        let r = search_all(&db, "alpha", &p2.id, 20, false).unwrap();
        assert_eq!(r.results.len(), 1);
    }

    #[test]
    fn long_note_content_is_snipped() {
        let (db, pid) = fresh_with_project();
        let long = format!("alpha {}", "x".repeat(500));
        notes::add(&db, &pid, &long, &[], Some(3), None).unwrap();
        let r = search_all(&db, "alpha", &pid, 5, false).unwrap();
        assert_eq!(r.results.len(), 1);
        if let SearchAllResult::Note { content, .. } = &r.results[0] {
            assert!(content.ends_with('…'));
            assert!(content.chars().count() <= SNIPPET_MAX_CHARS + 1);
        } else {
            panic!("expected Note variant");
        }
    }
}
