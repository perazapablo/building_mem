//! Cross-entity FTS5 search.
//!
//! Mirrors `searchAll` in `src/db.ts` L1772-1850. Runs four FTS queries
//! (notes / decisions / artifacts / code_entities) inside a single
//! `db.with` so the snapshot is consistent, merges the results, and sorts by
//! `(rank ASC, importance DESC)`. `limit` is clamped to `[1, 50]`.

use anyhow::Result;
use rusqlite::{params_from_iter, Connection, ToSql};
use serde::Serialize;
use std::cmp::Ordering;

use super::fts::to_fts_query;
use super::{parse_json_array, Db};

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
    pub project_id: Option<String>,
    pub include_obsolete: bool,
    pub limit: i64,
    pub results: Vec<SearchAllResult>,
}

pub fn search_all(
    db: &Db,
    query: &str,
    project_id: Option<&str>,
    limit: i64,
    include_obsolete: bool,
) -> Result<SearchAllResponse> {
    let limited = limit.clamp(1, 50);
    let Some(fts) = to_fts_query(query) else {
        return Ok(SearchAllResponse {
            query: query.to_string(),
            project_id: project_id.map(|s| s.to_string()),
            include_obsolete,
            limit: limited,
            results: Vec::new(),
        });
    };

    let project_clause = if project_id.is_some() {
        match_with_project_clause()
    } else {
        ""
    };
    let status_clause = if include_obsolete { "" } else { "AND status_filter" };
    let _ = status_clause;

    db.with(|conn| {
        let mut results: Vec<SearchAllResult> = Vec::new();
        results.extend(query_notes(conn, &fts, project_id, limited, include_obsolete, project_clause)?);
        results.extend(query_decisions(conn, &fts, project_id, limited, include_obsolete, project_clause)?);
        results.extend(query_artifacts(conn, &fts, project_id, limited, include_obsolete, project_clause)?);
        results.extend(query_code_entities(conn, &fts, project_id, limited, include_obsolete, project_clause)?);

        results.sort_by(|a, b| {
            a.rank()
                .partial_cmp(&b.rank())
                .unwrap_or(Ordering::Equal)
                .then(b.importance().cmp(&a.importance()))
        });
        results.truncate(limited as usize);

        Ok(SearchAllResponse {
            query: query.to_string(),
            project_id: project_id.map(|s| s.to_string()),
            include_obsolete,
            limit: limited,
            results,
        })
    })
}

fn match_with_project_clause() -> &'static str {
    " AND project_id_placeholder"
}

fn build_params<'a>(
    fts: &'a String,
    project_id: Option<&'a str>,
    limit: i64,
) -> Vec<Box<dyn ToSql + 'a>> {
    let mut p: Vec<Box<dyn ToSql + 'a>> = Vec::new();
    p.push(Box::new(fts.as_str()));
    if let Some(pid) = project_id {
        p.push(Box::new(pid));
    }
    p.push(Box::new(limit));
    p
}

fn query_notes(
    conn: &Connection,
    fts: &String,
    project_id: Option<&str>,
    limit: i64,
    include_obsolete: bool,
    _project_clause: &str,
) -> Result<Vec<SearchAllResult>> {
    let project_filter = if project_id.is_some() { "AND n.project_id = ?" } else { "" };
    let status_filter = if include_obsolete { "" } else { "AND n.status = 'active'" };
    let sql = format!(
        "SELECT n.id, n.project_id, n.content, n.status, n.importance, n.created_at, n.updated_at, rank,
                n.tags, n.topic_key, n.revision_count, n.obsolete_reason
         FROM notes_fts f
         JOIN notes n ON f.rowid = n.rowid
         WHERE notes_fts MATCH ? {project_filter} {status_filter}
         ORDER BY rank
         LIMIT ?"
    );
    let mut stmt = conn.prepare(&sql)?;
    let params = build_params(fts, project_id, limit);
    let param_refs: Vec<&dyn ToSql> = params.iter().map(|b| b.as_ref() as &dyn ToSql).collect();
    let rows: Vec<SearchAllResult> = stmt
        .query_map(params_from_iter(param_refs.iter()), |r| {
            let content: String = r.get(2)?;
            Ok(SearchAllResult::Note {
                id: r.get(0)?,
                project_id: r.get(1)?,
                title: content.clone(),
                summary: content.clone(),
                content,
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
    fts: &String,
    project_id: Option<&str>,
    limit: i64,
    include_obsolete: bool,
    _project_clause: &str,
) -> Result<Vec<SearchAllResult>> {
    let project_filter = if project_id.is_some() { "AND d.project_id = ?" } else { "" };
    let status_filter = if include_obsolete { "" } else { "AND d.status = 'active'" };
    let sql = format!(
        "SELECT d.id, d.project_id, d.decision, d.reasoning, d.status, d.importance, d.created_at, d.updated_at, rank,
                d.topic_key, d.revision_count, d.obsolete_reason
         FROM decisions_fts f
         JOIN decisions d ON f.rowid = d.rowid
         WHERE decisions_fts MATCH ? {project_filter} {status_filter}
         ORDER BY rank
         LIMIT ?"
    );
    let mut stmt = conn.prepare(&sql)?;
    let params = build_params(fts, project_id, limit);
    let param_refs: Vec<&dyn ToSql> = params.iter().map(|b| b.as_ref() as &dyn ToSql).collect();
    let rows: Vec<SearchAllResult> = stmt
        .query_map(params_from_iter(param_refs.iter()), |r| {
            let decision: String = r.get(2)?;
            let reasoning: String = r.get(3)?;
            Ok(SearchAllResult::Decision {
                id: r.get(0)?,
                project_id: r.get(1)?,
                title: decision.clone(),
                summary: reasoning.clone(),
                decision,
                reasoning,
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
    fts: &String,
    project_id: Option<&str>,
    limit: i64,
    include_obsolete: bool,
    _project_clause: &str,
) -> Result<Vec<SearchAllResult>> {
    let project_filter = if project_id.is_some() { "AND a.project_id = ?" } else { "" };
    let status_filter = if include_obsolete { "" } else { "AND a.status = 'active'" };
    let sql = format!(
        "SELECT a.id, a.project_id, a.type, a.content, a.status, a.importance, a.created_at, a.updated_at, rank,
                a.topic_key, a.revision_count, a.obsolete_reason
         FROM artifacts_fts f
         JOIN artifacts a ON f.rowid = a.rowid
         WHERE artifacts_fts MATCH ? {project_filter} {status_filter}
         ORDER BY rank
         LIMIT ?"
    );
    let mut stmt = conn.prepare(&sql)?;
    let params = build_params(fts, project_id, limit);
    let param_refs: Vec<&dyn ToSql> = params.iter().map(|b| b.as_ref() as &dyn ToSql).collect();
    let rows: Vec<SearchAllResult> = stmt
        .query_map(params_from_iter(param_refs.iter()), |r| {
            let ty: String = r.get(2)?;
            let content: String = r.get(3)?;
            Ok(SearchAllResult::Artifact {
                id: r.get(0)?,
                project_id: r.get(1)?,
                title: ty.clone(),
                summary: content.clone(),
                artifact_type: ty,
                content,
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
    fts: &String,
    project_id: Option<&str>,
    limit: i64,
    include_obsolete: bool,
    _project_clause: &str,
) -> Result<Vec<SearchAllResult>> {
    let project_filter = if project_id.is_some() { "AND c.project_id = ?" } else { "" };
    let status_filter = if include_obsolete { "" } else { "AND c.status = 'active'" };
    let sql = format!(
        "SELECT c.id, c.project_id, c.name, c.summary, c.status, c.importance, c.created_at, c.updated_at, rank,
                c.kind, c.qualified_name, c.path, c.signature, c.inputs, c.outputs, c.side_effects,
                c.tags, c.topic_key, c.revision_count, c.obsolete_reason
         FROM code_entities_fts f
         JOIN code_entities c ON f.rowid = c.rowid
         WHERE code_entities_fts MATCH ? {project_filter} {status_filter}
         ORDER BY rank
         LIMIT ?"
    );
    let mut stmt = conn.prepare(&sql)?;
    let params = build_params(fts, project_id, limit);
    let param_refs: Vec<&dyn ToSql> = params.iter().map(|b| b.as_ref() as &dyn ToSql).collect();
    let rows: Vec<SearchAllResult> = stmt
        .query_map(params_from_iter(param_refs.iter()), |r| {
            let name: String = r.get(2)?;
            let summary: String = r.get(3)?;
            Ok(SearchAllResult::CodeEntity {
                id: r.get(0)?,
                project_id: r.get(1)?,
                title: name.clone(),
                summary: summary.clone(),
                name,
                status: r.get(4)?,
                importance: r.get(5)?,
                created_at: r.get(6)?,
                updated_at: r.get(7)?,
                rank: r.get(8)?,
                kind: r.get(9)?,
                qualified_name: r.get(10)?,
                path: r.get(11)?,
                signature: r.get(12)?,
                inputs: r.get(13)?,
                outputs: r.get(14)?,
                side_effects: r.get(15)?,
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
        let p = projects::upsert(&db, "p1", "", "development", &[]).unwrap();
        (db, p.id)
    }

    #[test]
    fn empty_fts_query_returns_empty() {
        let (db, pid) = fresh_with_project();
        let r = search_all(&db, "\"\"", Some(&pid), 10, false).unwrap();
        assert!(r.results.is_empty());
        assert_eq!(r.limit, 10);
    }

    #[test]
    fn limit_clamps_to_range() {
        let (db, _) = fresh_with_project();
        let r = search_all(&db, "anything", None, 999, false).unwrap();
        assert_eq!(r.limit, 50);
        let r = search_all(&db, "anything", None, -3, false).unwrap();
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

        let r = search_all(&db, "alpha", Some(&pid), 20, false).unwrap();
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
        let r = search_all(&db, "alpha", Some(&pid), 20, false).unwrap();
        assert_eq!(r.results.len(), 0);
        let r = search_all(&db, "alpha", Some(&pid), 20, true).unwrap();
        assert_eq!(r.results.len(), 1);
    }

    #[test]
    fn project_filter_excludes_other_projects() {
        let db = Db::new_in_memory().unwrap();
        let p1 = projects::upsert(&db, "p1", "", "development", &[]).unwrap();
        let p2 = projects::upsert(&db, "p2", "", "development", &[]).unwrap();
        notes::add(&db, &p1.id, "alpha in p1", &[], Some(3), None).unwrap();
        notes::add(&db, &p2.id, "alpha in p2", &[], Some(3), None).unwrap();

        let r = search_all(&db, "alpha", Some(&p1.id), 20, false).unwrap();
        assert_eq!(r.results.len(), 1);
        let r = search_all(&db, "alpha", None, 20, false).unwrap();
        assert_eq!(r.results.len(), 2);
    }
}
