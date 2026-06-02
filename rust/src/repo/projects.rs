//! Projects: identity, upsert by `name`, context summary persistence.

use anyhow::Result;
use rusqlite::{params, OptionalExtension};
use serde::Serialize;

use crate::summary::{parse_context_summary, serialize as serialize_summary, ContextSummary};

use super::{new_uuid, parse_json_array, serialize_json_array, Db};

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub project_type: String,
    pub tags: Vec<String>,
    pub context_summary: Option<ContextSummary>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct UpsertResult {
    pub id: String,
    pub existed: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ProjectContextRow {
    pub id: String,
    pub content: String,
    pub tags: Vec<String>,
    pub topic_key: Option<String>,
    pub revision_count: i64,
    pub status: String,
    pub importance: i64,
    pub obsolete_reason: Option<String>,
    pub created_at: String,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ProjectContext {
    pub notes: Vec<ProjectContextRow>,
    pub decisions: Vec<DecisionContextRow>,
    pub artifacts: Vec<ArtifactContextRow>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DecisionContextRow {
    pub id: String,
    pub decision: String,
    pub reasoning: String,
    pub topic_key: Option<String>,
    pub revision_count: i64,
    pub status: String,
    pub importance: i64,
    pub obsolete_reason: Option<String>,
    pub created_at: String,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ArtifactContextRow {
    pub id: String,
    #[serde(rename = "type")]
    pub artifact_type: String,
    pub content: String,
    pub topic_key: Option<String>,
    pub revision_count: i64,
    pub status: String,
    pub importance: i64,
    pub obsolete_reason: Option<String>,
    pub created_at: String,
    pub updated_at: Option<String>,
}

pub fn upsert(
    db: &Db,
    name: &str,
    description: &str,
    project_type: &str,
    tags: &[String],
) -> Result<UpsertResult> {
    db.with(|conn| {
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM projects WHERE name = ?",
                params![name],
                |r| r.get(0),
            )
            .optional()?;

        if let Some(id) = existing {
            conn.execute(
                "UPDATE projects SET description = ?, project_type = ?, tags = ?, updated_at = datetime('now') WHERE id = ?",
                params![description, project_type, serialize_json_array(tags), id],
            )?;
            return Ok(UpsertResult { id, existed: true });
        }

        let id = new_uuid();
        conn.execute(
            "INSERT INTO projects (id, name, description, project_type, tags) VALUES (?, ?, ?, ?, ?)",
            params![id, name, description, project_type, serialize_json_array(tags)],
        )?;
        Ok(UpsertResult { id, existed: false })
    })
}

pub fn get(db: &Db, project_id: &str) -> Result<Option<Project>> {
    db.with(|conn| {
        let row = conn
            .query_row(
                "SELECT id, name, description, project_type, tags, context_summary, created_at, updated_at
                 FROM projects WHERE id = ?",
                params![project_id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, Option<String>>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, Option<String>>(5)?,
                        r.get::<_, String>(6)?,
                        r.get::<_, String>(7)?,
                    ))
                },
            )
            .optional()?;
        Ok(row.map(|(id, name, description, project_type, tags, context_summary, created_at, updated_at)| Project {
            id,
            name,
            description,
            project_type,
            tags: parse_json_array(&tags),
            context_summary: parse_context_summary(context_summary.as_deref()),
            created_at,
            updated_at,
        }))
    })
}

pub fn update_context_summary(db: &Db, project_id: &str, summary: &ContextSummary) -> Result<()> {
    db.with(|conn| {
        conn.execute(
            "UPDATE projects SET context_summary = ?, updated_at = datetime('now') WHERE id = ?",
            params![serialize_summary(summary), project_id],
        )?;
        Ok(())
    })
}

pub fn get_project_context(
    db: &Db,
    project_id: &str,
    limit: i64,
    include_obsolete: bool,
) -> Result<ProjectContext> {
    let status_clause = if include_obsolete { "" } else { "AND status = 'active'" };
    db.with(|conn| {
        let notes_sql = format!(
            "SELECT id, content, tags, topic_key, revision_count, status, importance, obsolete_reason, created_at, updated_at
             FROM notes WHERE project_id = ? {clause}
             ORDER BY importance DESC, COALESCE(updated_at, created_at) DESC LIMIT ?",
            clause = status_clause
        );
        let mut stmt = conn.prepare(&notes_sql)?;
        let notes: Vec<ProjectContextRow> = stmt
            .query_map(params![project_id, limit], |r| {
                Ok(ProjectContextRow {
                    id: r.get(0)?,
                    content: r.get(1)?,
                    tags: parse_json_array(&r.get::<_, String>(2)?),
                    topic_key: r.get(3)?,
                    revision_count: r.get(4)?,
                    status: r.get(5)?,
                    importance: r.get(6)?,
                    obsolete_reason: r.get(7)?,
                    created_at: r.get(8)?,
                    updated_at: r.get(9)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;

        let decisions_sql = format!(
            "SELECT id, decision, reasoning, topic_key, revision_count, status, importance, obsolete_reason, created_at, updated_at
             FROM decisions WHERE project_id = ? {clause}
             ORDER BY importance DESC, COALESCE(updated_at, created_at) DESC LIMIT ?",
            clause = status_clause
        );
        let mut stmt = conn.prepare(&decisions_sql)?;
        let decisions: Vec<DecisionContextRow> = stmt
            .query_map(params![project_id, limit], |r| {
                Ok(DecisionContextRow {
                    id: r.get(0)?,
                    decision: r.get(1)?,
                    reasoning: r.get(2)?,
                    topic_key: r.get(3)?,
                    revision_count: r.get(4)?,
                    status: r.get(5)?,
                    importance: r.get(6)?,
                    obsolete_reason: r.get(7)?,
                    created_at: r.get(8)?,
                    updated_at: r.get(9)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;

        let artifacts_sql = format!(
            "SELECT id, type, content, topic_key, revision_count, status, importance, obsolete_reason, created_at, updated_at
             FROM artifacts WHERE project_id = ? {clause}
             ORDER BY importance DESC, COALESCE(updated_at, created_at) DESC LIMIT ?",
            clause = status_clause
        );
        let mut stmt = conn.prepare(&artifacts_sql)?;
        let artifacts: Vec<ArtifactContextRow> = stmt
            .query_map(params![project_id, limit], |r| {
                Ok(ArtifactContextRow {
                    id: r.get(0)?,
                    artifact_type: r.get(1)?,
                    content: r.get(2)?,
                    topic_key: r.get(3)?,
                    revision_count: r.get(4)?,
                    status: r.get(5)?,
                    importance: r.get(6)?,
                    obsolete_reason: r.get(7)?,
                    created_at: r.get(8)?,
                    updated_at: r.get(9)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;

        Ok(ProjectContext { notes, decisions, artifacts })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::summary::ContextSummary;

    fn fresh() -> Db {
        Db::new_in_memory().unwrap()
    }

    #[test]
    fn upsert_creates_then_updates() {
        let db = fresh();
        let r1 = upsert(&db, "mcp_memory", "first", "development", &["mcp".into()]).unwrap();
        assert!(!r1.existed);

        let r2 = upsert(&db, "mcp_memory", "second", "development", &["mcp".into(), "rust".into()]).unwrap();
        assert!(r2.existed);
        assert_eq!(r1.id, r2.id);

        let p = get(&db, &r1.id).unwrap().unwrap();
        assert_eq!(p.description.as_deref(), Some("second"));
        assert_eq!(p.tags, vec!["mcp".to_string(), "rust".into()]);
    }

    #[test]
    fn get_missing_returns_none() {
        let db = fresh();
        assert!(get(&db, "no-such-id").unwrap().is_none());
    }

    #[test]
    fn context_summary_roundtrip() {
        let db = fresh();
        let r = upsert(&db, "p1", "", "development", &[]).unwrap();
        let summary = ContextSummary {
            architecture: "rust + sqlite".into(),
            constraints: vec!["single-process".into()],
            ..Default::default()
        };
        update_context_summary(&db, &r.id, &summary).unwrap();
        let p = get(&db, &r.id).unwrap().unwrap();
        assert_eq!(p.context_summary, Some(summary));
    }

    #[test]
    fn get_project_context_returns_empty_for_new_project() {
        let db = fresh();
        let r = upsert(&db, "p1", "", "development", &[]).unwrap();
        let ctx = get_project_context(&db, &r.id, 5, false).unwrap();
        assert!(ctx.notes.is_empty());
        assert!(ctx.decisions.is_empty());
        assert!(ctx.artifacts.is_empty());
    }
}
