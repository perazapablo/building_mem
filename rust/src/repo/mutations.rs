//! Cross-entity mutations: `mark_obsolete` and `audit_stale`.
//! Mirrors `src/db.ts` L1861-1932.

use anyhow::{anyhow, Result};
use rusqlite::{params, params_from_iter, ToSql};
use serde::Serialize;

use super::Db;

fn obsolete_table_for(entity_type: &str) -> Option<&'static str> {
    match entity_type {
        "note" => Some("notes"),
        "decision" => Some("decisions"),
        "artifact" => Some("artifacts"),
        "code_entity" => Some("code_entities"),
        _ => None,
    }
}

pub fn mark_obsolete(db: &Db, entity_type: &str, id: &str, reason: &str) -> Result<()> {
    let table = obsolete_table_for(entity_type)
        .ok_or_else(|| anyhow!("invalid entity_type for mark_obsolete: {}", entity_type))?;
    let sql = format!(
        "UPDATE {} SET status = 'obsolete', obsolete_reason = ?, updated_at = datetime('now') WHERE id = ?",
        table
    );
    db.with(|conn| {
        conn.execute(&sql, params![reason, id])?;
        Ok(())
    })
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct StaleNote {
    pub id: String,
    pub project_id: String,
    pub content: String,
    pub importance: i64,
    pub created_at: String,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct StaleDecision {
    pub id: String,
    pub project_id: String,
    pub decision: String,
    pub importance: i64,
    pub created_at: String,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct StaleArtifact {
    pub id: String,
    pub project_id: String,
    #[serde(rename = "type")]
    pub artifact_type: String,
    pub importance: i64,
    pub created_at: String,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct StaleCodeEntity {
    pub id: String,
    pub project_id: String,
    pub kind: String,
    pub name: String,
    pub qualified_name: String,
    pub path: String,
    pub importance: i64,
    pub created_at: String,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AuditStaleResponse {
    pub notes: Vec<StaleNote>,
    pub decisions: Vec<StaleDecision>,
    pub artifacts: Vec<StaleArtifact>,
    pub code_entities: Vec<StaleCodeEntity>,
}

fn build_filter(project_id: Option<&str>) -> (&'static str, Vec<Box<dyn ToSql>>) {
    let mut params: Vec<Box<dyn ToSql>> = Vec::new();
    if let Some(pid) = project_id {
        params.push(Box::new(pid.to_string()));
        ("AND project_id = ?", params)
    } else {
        ("", params)
    }
}

pub fn audit_stale(db: &Db, days: i64, project_id: Option<&str>) -> Result<AuditStaleResponse> {
    let cutoff = format!("-{} days", days);
    db.with(|conn| {
        let (project_clause, _) = build_filter(project_id);

        let mk_params = |cutoff: &str| -> Vec<Box<dyn ToSql>> {
            let mut p: Vec<Box<dyn ToSql>> = Vec::new();
            p.push(Box::new(cutoff.to_string()));
            if let Some(pid) = project_id {
                p.push(Box::new(pid.to_string()));
            }
            p
        };

        let notes_sql = format!(
            "SELECT id, project_id, content, importance, created_at, updated_at
             FROM notes
             WHERE status = 'active'
               AND COALESCE(updated_at, created_at) < datetime('now', ?)
               {clause}
             ORDER BY COALESCE(updated_at, created_at) ASC
             LIMIT 50",
            clause = project_clause
        );
        let mut stmt = conn.prepare(&notes_sql)?;
        let p = mk_params(&cutoff);
        let refs: Vec<&dyn ToSql> = p.iter().map(|b| b.as_ref() as &dyn ToSql).collect();
        let notes: Vec<StaleNote> = stmt
            .query_map(params_from_iter(refs.iter()), |r| {
                Ok(StaleNote {
                    id: r.get(0)?,
                    project_id: r.get(1)?,
                    content: r.get(2)?,
                    importance: r.get(3)?,
                    created_at: r.get(4)?,
                    updated_at: r.get(5)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;

        let decisions_sql = format!(
            "SELECT id, project_id, decision, importance, created_at, updated_at
             FROM decisions
             WHERE status = 'active'
               AND COALESCE(updated_at, created_at) < datetime('now', ?)
               {clause}
             ORDER BY COALESCE(updated_at, created_at) ASC
             LIMIT 50",
            clause = project_clause
        );
        let mut stmt = conn.prepare(&decisions_sql)?;
        let p = mk_params(&cutoff);
        let refs: Vec<&dyn ToSql> = p.iter().map(|b| b.as_ref() as &dyn ToSql).collect();
        let decisions: Vec<StaleDecision> = stmt
            .query_map(params_from_iter(refs.iter()), |r| {
                Ok(StaleDecision {
                    id: r.get(0)?,
                    project_id: r.get(1)?,
                    decision: r.get(2)?,
                    importance: r.get(3)?,
                    created_at: r.get(4)?,
                    updated_at: r.get(5)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;

        let artifacts_sql = format!(
            "SELECT id, project_id, type, importance, created_at, updated_at
             FROM artifacts
             WHERE status = 'active'
               AND COALESCE(updated_at, created_at) < datetime('now', ?)
               {clause}
             ORDER BY COALESCE(updated_at, created_at) ASC
             LIMIT 50",
            clause = project_clause
        );
        let mut stmt = conn.prepare(&artifacts_sql)?;
        let p = mk_params(&cutoff);
        let refs: Vec<&dyn ToSql> = p.iter().map(|b| b.as_ref() as &dyn ToSql).collect();
        let artifacts: Vec<StaleArtifact> = stmt
            .query_map(params_from_iter(refs.iter()), |r| {
                Ok(StaleArtifact {
                    id: r.get(0)?,
                    project_id: r.get(1)?,
                    artifact_type: r.get(2)?,
                    importance: r.get(3)?,
                    created_at: r.get(4)?,
                    updated_at: r.get(5)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;

        let code_sql = format!(
            "SELECT id, project_id, kind, name, qualified_name, path, importance, created_at, updated_at
             FROM code_entities
             WHERE status = 'active'
               AND COALESCE(updated_at, created_at) < datetime('now', ?)
               {clause}
             ORDER BY COALESCE(updated_at, created_at) ASC
             LIMIT 50",
            clause = project_clause
        );
        let mut stmt = conn.prepare(&code_sql)?;
        let p = mk_params(&cutoff);
        let refs: Vec<&dyn ToSql> = p.iter().map(|b| b.as_ref() as &dyn ToSql).collect();
        let code_entities: Vec<StaleCodeEntity> = stmt
            .query_map(params_from_iter(refs.iter()), |r| {
                Ok(StaleCodeEntity {
                    id: r.get(0)?,
                    project_id: r.get(1)?,
                    kind: r.get(2)?,
                    name: r.get(3)?,
                    qualified_name: r.get(4)?,
                    path: r.get(5)?,
                    importance: r.get(6)?,
                    created_at: r.get(7)?,
                    updated_at: r.get(8)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;

        Ok(AuditStaleResponse {
            notes,
            decisions,
            artifacts,
            code_entities,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repo::{notes, projects};

    fn fresh_with_project() -> (Db, String) {
        let db = Db::new_in_memory().unwrap();
        let p = projects::upsert(&db, "p1", "", "development", &[]).unwrap();
        (db, p.id)
    }

    #[test]
    fn mark_obsolete_excludes_from_searches() {
        let (db, pid) = fresh_with_project();
        let id = notes::add(&db, &pid, "stale content", &[], Some(3), None).unwrap();
        mark_obsolete(&db, "note", &id, "no longer relevant").unwrap();
        let rows = notes::search(&db, "stale", Some(&pid), 10, false).unwrap();
        assert!(rows.is_empty(), "obsolete must not appear in search");
        let rows = notes::search(&db, "stale", Some(&pid), 10, true).unwrap();
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn mark_obsolete_invalid_type_errors() {
        let (db, _) = fresh_with_project();
        let r = mark_obsolete(&db, "unknown", "x", "y");
        assert!(r.is_err());
    }

    fn backdate_note(db: &Db, id: &str, days_ago: i64) {
        let sql = format!(
            "UPDATE notes SET created_at = datetime('now', '-{} days'), updated_at = NULL WHERE id = ?",
            days_ago
        );
        db.with(|conn| {
            conn.execute(&sql, params![id])?;
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn audit_stale_returns_rows_older_than_cutoff() {
        let (db, pid) = fresh_with_project();
        let old = notes::add(&db, &pid, "ancient", &[], Some(3), None).unwrap();
        let fresh = notes::add(&db, &pid, "fresh", &[], Some(3), None).unwrap();
        backdate_note(&db, &old, 60);

        let r = audit_stale(&db, 30, Some(&pid)).unwrap();
        assert_eq!(r.notes.len(), 1);
        assert_eq!(r.notes[0].id, old);
        let _ = fresh;
    }

    #[test]
    fn audit_stale_high_days_returns_nothing_for_fresh_rows() {
        let (db, pid) = fresh_with_project();
        notes::add(&db, &pid, "still fresh", &[], Some(3), None).unwrap();
        let r = audit_stale(&db, 30, Some(&pid)).unwrap();
        assert!(r.notes.is_empty());
    }

    #[test]
    fn audit_stale_filters_by_project_id() {
        let db = Db::new_in_memory().unwrap();
        let p1 = projects::upsert(&db, "p1", "", "development", &[]).unwrap();
        let p2 = projects::upsert(&db, "p2", "", "development", &[]).unwrap();
        let n1 = notes::add(&db, &p1.id, "in p1", &[], Some(3), None).unwrap();
        let n2 = notes::add(&db, &p2.id, "in p2", &[], Some(3), None).unwrap();
        backdate_note(&db, &n1, 60);
        backdate_note(&db, &n2, 60);
        let r1 = audit_stale(&db, 30, Some(&p1.id)).unwrap();
        assert_eq!(r1.notes.len(), 1);
        assert_eq!(r1.notes[0].project_id, p1.id);
        let r_all = audit_stale(&db, 30, None).unwrap();
        assert_eq!(r_all.notes.len(), 2);
    }
}
