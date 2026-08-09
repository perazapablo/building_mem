//! Projects: identity, upsert by `name`, context summary persistence.

use anyhow::Result;
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use std::collections::HashSet;

use crate::summary::{parse_context_summary, serialize as serialize_summary, ContextSummary};

use super::{new_uuid, parse_json_array, serialize_json_array, Db};

/// Strict normalization for auto-merge (tier 1).
///
/// Strips ALL non-alphanumeric characters and lowercases. So
/// `Pcoriente-Admin`, `pcoriente_admin`, `pcorienteAdmin` and
/// `pcoriente admin` all collapse to `pcorienteadmin`.
pub fn normalize_name(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// Tokens for fuzzy match (tier 2). Splits on any non-alphanumeric
/// boundary and lowercases. Filters very short tokens (< 4 chars) so
/// generic words like "api", "web", "app" don't cause false positives.
pub fn significant_tokens(name: &str) -> HashSet<String> {
    name.split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.chars().count() >= 4)
        .map(|t| t.to_lowercase())
        .collect()
}

/// Looser tokens used ONLY for prefix matching (tier 2b). Allows tokens
/// down to 3 chars so abbreviations like `"pco"` can match `"pcoriente"`
/// via prefix.
pub fn prefix_tokens(name: &str) -> Vec<String> {
    name.split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.chars().count() >= 3)
        .map(|t| t.to_lowercase())
        .collect()
}

/// Returns the shorter token when one is prefix of the other (≥3 chars)
/// and they are not equal. `None` for equal tokens (handled by exact match).
fn shared_prefix(a: &str, b: &str) -> Option<String> {
    if a == b {
        return None;
    }
    let (short, long) = if a.len() <= b.len() { (a, b) } else { (b, a) };
    if short.len() >= 3 && long.starts_with(short) {
        Some(short.to_string())
    } else {
        None
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ProjectCandidate {
    pub id: String,
    pub name: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum UpsertOutcome {
    /// Brand-new row inserted.
    Created { id: String, name: String },
    /// Existing row matched (by exact name OR normalized name).
    AutoMerged {
        id: String,
        name: String,
        matched_by: &'static str, // "exact" | "normalized"
        existing_name: String,
    },
    /// One or more existing projects share significant tokens. No write.
    /// Caller must re-invoke with `confirm_new=true` to force insert.
    Ambiguous {
        candidates: Vec<ProjectCandidate>,
        normalized_input: String,
    },
}

impl UpsertOutcome {
    /// Returns the project id when the outcome wrote something. `None` for
    /// `Ambiguous` (the caller is expected to inspect candidates).
    pub fn id(&self) -> Option<&str> {
        match self {
            UpsertOutcome::Created { id, .. } | UpsertOutcome::AutoMerged { id, .. } => Some(id),
            UpsertOutcome::Ambiguous { .. } => None,
        }
    }
}

/// Legacy/internal helper: forces creation regardless of tier 2 fuzzy match.
/// Used by tests and internal code that already knows the project name is
/// stable. Returns `UpsertResult { id, existed }` for backward compatibility.
pub fn upsert_force(
    db: &Db,
    name: &str,
    description: &str,
    project_type: &str,
    tags: &[String],
) -> Result<UpsertResult> {
    let outcome = upsert(db, name, description, project_type, tags, true)?;
    match outcome {
        UpsertOutcome::Created { id, .. } => Ok(UpsertResult { id, existed: false }),
        UpsertOutcome::AutoMerged { id, .. } => Ok(UpsertResult { id, existed: true }),
        UpsertOutcome::Ambiguous { .. } => {
            unreachable!("confirm_new=true bypasses tier 2 ambiguity")
        }
    }
}

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

/// Tier 1 + 2 smart upsert.
///
/// 1. **Exact name match** → update + return AutoMerged.
/// 2. **Normalized match** (`normalize_name` collapse equal) → update + return AutoMerged.
/// 3. **Token-shared candidates** found (`significant_tokens` intersect) →
///    `confirm_new=false` returns `Ambiguous` without writing; `confirm_new=true`
///    bypasses tier 2 and inserts a new row.
/// 4. **No candidates** → insert new row + return Created.
pub fn upsert(
    db: &Db,
    name: &str,
    description: &str,
    project_type: &str,
    tags: &[String],
    confirm_new: bool,
) -> Result<UpsertOutcome> {
    let normalized_input = normalize_name(name);
    let input_tokens = significant_tokens(name);

    db.with(|conn| {
        // Tier 1a: exact name match
        let exact: Option<(String, String)> = conn
            .query_row(
                "SELECT id, name FROM projects WHERE name = ?",
                params![name],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()?;

        if let Some((id, existing_name)) = exact {
            conn.execute(
                "UPDATE projects SET description = ?, project_type = ?, tags = ?, updated_at = datetime('now') WHERE id = ?",
                params![description, project_type, serialize_json_array(tags), id],
            )?;
            return Ok(UpsertOutcome::AutoMerged {
                id,
                name: name.to_string(),
                matched_by: "exact",
                existing_name,
            });
        }

        // Load all existing projects once to run tier 1b + tier 2 in memory.
        let mut stmt = conn.prepare("SELECT id, name FROM projects")?;
        let all: Vec<(String, String)> = stmt
            .query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<_>>()?;
        drop(stmt);

        // Tier 1b: normalized match
        if !normalized_input.is_empty() {
            for (id, existing_name) in &all {
                if normalize_name(existing_name) == normalized_input {
                    conn.execute(
                        "UPDATE projects SET description = ?, project_type = ?, tags = ?, updated_at = datetime('now') WHERE id = ?",
                        params![description, project_type, serialize_json_array(tags), id],
                    )?;
                    return Ok(UpsertOutcome::AutoMerged {
                        id: id.clone(),
                        name: name.to_string(),
                        matched_by: "normalized",
                        existing_name: existing_name.clone(),
                    });
                }
            }
        }

        // Tier 2: candidates by shared significant tokens or prefix overlap.
        if !confirm_new {
            let input_prefix_tokens = prefix_tokens(name);
            let mut candidates: Vec<ProjectCandidate> = Vec::new();
            for (id, existing_name) in &all {
                let existing_tokens = significant_tokens(existing_name);
                let existing_prefix_tokens = prefix_tokens(existing_name);

                // 2a: exact token equality (len >= 4)
                let exact_shared: Vec<String> = input_tokens
                    .intersection(&existing_tokens)
                    .cloned()
                    .collect();

                // 2b: prefix overlap (len >= 3, one starts-with the other)
                let mut prefix_shared: Vec<String> = Vec::new();
                for a in &input_prefix_tokens {
                    for b in &existing_prefix_tokens {
                        if let Some(p) = shared_prefix(a, b) {
                            if !prefix_shared.contains(&p) {
                                prefix_shared.push(p);
                            }
                        }
                    }
                }

                if !exact_shared.is_empty() || !prefix_shared.is_empty() {
                    let mut parts: Vec<String> = Vec::new();
                    if !exact_shared.is_empty() {
                        parts.push(format!("shared token(s): {}", exact_shared.join(", ")));
                    }
                    if !prefix_shared.is_empty() {
                        parts.push(format!("prefix overlap: {}", prefix_shared.join(", ")));
                    }
                    candidates.push(ProjectCandidate {
                        id: id.clone(),
                        name: existing_name.clone(),
                        reason: parts.join("; "),
                    });
                }
            }
            if !candidates.is_empty() {
                return Ok(UpsertOutcome::Ambiguous {
                    candidates,
                    normalized_input,
                });
            }
        }

        // No collisions → insert
        let id = new_uuid();
        conn.execute(
            "INSERT INTO projects (id, name, description, project_type, tags) VALUES (?, ?, ?, ?, ?)",
            params![id, name, description, project_type, serialize_json_array(tags)],
        )?;
        Ok(UpsertOutcome::Created { id, name: name.to_string() })
    })
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ProjectIndexRow {
    pub id: String,
    pub name: String,
    pub project_type: String,
    pub tags: Vec<String>,
    pub updated_at: String,
}

/// Compact project listing for the MCP `list_projects` tool. Excludes
/// `description` and `context_summary` to keep the response small — the
/// caller reaches for `get_project(id)` once the target is identified.
pub fn list_index(db: &Db) -> Result<Vec<ProjectIndexRow>> {
    db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, project_type, tags, updated_at
             FROM projects
             ORDER BY updated_at DESC, created_at DESC",
        )?;
        let rows: Vec<ProjectIndexRow> = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })?
            .map(|res| {
                res.map(|(id, name, project_type, tags, updated_at)| ProjectIndexRow {
                    id,
                    name,
                    project_type,
                    tags: parse_json_array(&tags),
                    updated_at,
                })
            })
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    })
}

pub fn list_all(db: &Db) -> Result<Vec<Project>> {
    db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, description, project_type, tags, context_summary, created_at, updated_at
             FROM projects
             ORDER BY updated_at DESC, created_at DESC",
        )?;
        let rows: Vec<Project> = stmt
            .query_map([], |r| {
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
            })?
            .map(|res| {
                res.map(|(id, name, description, project_type, tags, context_summary, created_at, updated_at)| Project {
                    id,
                    name,
                    description,
                    project_type,
                    tags: parse_json_array(&tags),
                    context_summary: parse_context_summary(context_summary.as_deref()),
                    created_at,
                    updated_at,
                })
            })
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
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

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DeleteProjectCounts {
    pub project_id: String,
    pub project_name: String,
    pub notes: usize,
    pub decisions: usize,
    pub artifacts: usize,
    pub code_entities: usize,
    pub sessions: usize,
    pub working_states: usize,
    pub links: usize,
    pub memory_relations: usize,
}

/// Hard-delete a project and every row that references it.
///
/// Not exposed as an MCP tool — only callable from the viewer. Performs:
/// 1. `memory_relations` and `links` rows whose source/target points at the
///    project or any of its notes/decisions/artifacts/code_entities/sessions.
/// 2. `working_state` for the project's sessions.
/// 3. `sessions` rows.
/// 4. `projects` row (CASCADE deletes notes/decisions/artifacts/code_entities).
///
/// All inside a single transaction. Returns the counts deleted per table.
pub fn delete_project_cascade(db: &Db, project_id: &str) -> Result<DeleteProjectCounts> {
    db.with_mut(|conn| {
        let tx = conn.transaction()?;

        let (existing_id, project_name): (String, String) = match tx
            .query_row(
                "SELECT id, name FROM projects WHERE id = ?",
                params![project_id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()?
        {
            Some(row) => row,
            None => {
                anyhow::bail!("project_id not found: {project_id}");
            }
        };

        let collect_ids = |sql: &str| -> rusqlite::Result<Vec<String>> {
            let mut stmt = tx.prepare(sql)?;
            let rows = stmt
                .query_map(params![existing_id], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        };

        let note_ids = collect_ids("SELECT id FROM notes WHERE project_id = ?")?;
        let decision_ids = collect_ids("SELECT id FROM decisions WHERE project_id = ?")?;
        let artifact_ids = collect_ids("SELECT id FROM artifacts WHERE project_id = ?")?;
        let code_entity_ids = collect_ids("SELECT id FROM code_entities WHERE project_id = ?")?;
        let session_ids = collect_ids("SELECT id FROM sessions WHERE project_id = ?")?;

        let affected: Vec<(&str, &[String])> = vec![
            ("project", std::slice::from_ref(&existing_id)),
            ("note", &note_ids),
            ("decision", &decision_ids),
            ("artifact", &artifact_ids),
            ("code_entity", &code_entity_ids),
            ("session", &session_ids),
        ];

        let mut links_deleted: usize = 0;
        let mut relations_deleted: usize = 0;

        for (kind, ids) in &affected {
            for id in ids.iter() {
                links_deleted += tx.execute(
                    "DELETE FROM links WHERE (from_type = ?1 AND from_id = ?2) OR (to_type = ?1 AND to_id = ?2)",
                    params![kind, id],
                )?;
                relations_deleted += tx.execute(
                    "DELETE FROM memory_relations WHERE (source_type = ?1 AND source_id = ?2) OR (target_type = ?1 AND target_id = ?2)",
                    params![kind, id],
                )?;
            }
        }

        let mut working_states_deleted: usize = 0;
        for sid in &session_ids {
            working_states_deleted +=
                tx.execute("DELETE FROM working_state WHERE session_id = ?", params![sid])?;
        }

        let sessions_deleted =
            tx.execute("DELETE FROM sessions WHERE project_id = ?", params![existing_id])?;

        let project_deleted =
            tx.execute("DELETE FROM projects WHERE id = ?", params![existing_id])?;

        if project_deleted != 1 {
            anyhow::bail!("project row not deleted (got {project_deleted})");
        }

        let counts = DeleteProjectCounts {
            project_id: existing_id,
            project_name,
            notes: note_ids.len(),
            decisions: decision_ids.len(),
            artifacts: artifact_ids.len(),
            code_entities: code_entity_ids.len(),
            sessions: sessions_deleted,
            working_states: working_states_deleted,
            links: links_deleted,
            memory_relations: relations_deleted,
        };

        tx.commit()?;
        Ok(counts)
    })
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct MergeProjectCounts {
    pub source_id: String,
    pub source_name: String,
    pub target_id: String,
    pub target_name: String,
    pub notes: usize,
    pub decisions: usize,
    pub artifacts: usize,
    pub code_entities: usize,
    pub sessions: usize,
    pub links: usize,
    pub memory_relations: usize,
}

/// Merge `source_id` into `target_id`: re-parents every child row and then
/// deletes the source project. Viewer-only — not exposed as MCP tool.
///
/// 1. UPDATE notes/decisions/artifacts/code_entities/sessions SET project_id = target.
/// 2. UPDATE links and memory_relations rows that point at the source project
///    (type='project') to point at the target.
/// 3. DELETE source project row.
///
/// Children of the source already have `project_id` swapped, so the trailing
/// DELETE leaves them attached to the target. All in one transaction.
pub fn merge_project_into(
    db: &Db,
    source_id: &str,
    target_id: &str,
) -> Result<MergeProjectCounts> {
    if source_id == target_id {
        anyhow::bail!("source and target are the same project");
    }
    db.with_mut(|conn| {
        let tx = conn.transaction()?;

        let (src_id, src_name): (String, String) = tx
            .query_row(
                "SELECT id, name FROM projects WHERE id = ?",
                params![source_id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()?
            .ok_or_else(|| anyhow::anyhow!("source project not found: {source_id}"))?;

        let (tgt_id, tgt_name): (String, String) = tx
            .query_row(
                "SELECT id, name FROM projects WHERE id = ?",
                params![target_id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .optional()?
            .ok_or_else(|| anyhow::anyhow!("target project not found: {target_id}"))?;

        let notes = tx.execute(
            "UPDATE notes SET project_id = ? WHERE project_id = ?",
            params![tgt_id, src_id],
        )?;
        let decisions = tx.execute(
            "UPDATE decisions SET project_id = ? WHERE project_id = ?",
            params![tgt_id, src_id],
        )?;
        let artifacts = tx.execute(
            "UPDATE artifacts SET project_id = ? WHERE project_id = ?",
            params![tgt_id, src_id],
        )?;
        let code_entities = tx.execute(
            "UPDATE code_entities SET project_id = ? WHERE project_id = ?",
            params![tgt_id, src_id],
        )?;
        let sessions = tx.execute(
            "UPDATE sessions SET project_id = ? WHERE project_id = ?",
            params![tgt_id, src_id],
        )?;

        let links_from = tx.execute(
            "UPDATE links SET from_id = ? WHERE from_type = 'project' AND from_id = ?",
            params![tgt_id, src_id],
        )?;
        let links_to = tx.execute(
            "UPDATE links SET to_id = ? WHERE to_type = 'project' AND to_id = ?",
            params![tgt_id, src_id],
        )?;

        let rel_src = tx.execute(
            "UPDATE memory_relations SET source_id = ? WHERE source_type = 'project' AND source_id = ?",
            params![tgt_id, src_id],
        )?;
        let rel_tgt = tx.execute(
            "UPDATE memory_relations SET target_id = ? WHERE target_type = 'project' AND target_id = ?",
            params![tgt_id, src_id],
        )?;

        let deleted = tx.execute("DELETE FROM projects WHERE id = ?", params![src_id])?;
        if deleted != 1 {
            anyhow::bail!("source project row not deleted (got {deleted})");
        }

        let counts = MergeProjectCounts {
            source_id: src_id,
            source_name: src_name,
            target_id: tgt_id,
            target_name: tgt_name,
            notes,
            decisions,
            artifacts,
            code_entities,
            sessions,
            links: links_from + links_to,
            memory_relations: rel_src + rel_tgt,
        };

        tx.commit()?;
        Ok(counts)
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
        let r1 = upsert_force(&db, "mcp_memory", "first", "development", &["mcp".into()]).unwrap();
        assert!(!r1.existed);

        let r2 = upsert_force(&db, "mcp_memory", "second", "development", &["mcp".into(), "rust".into()]).unwrap();
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
        let r = upsert_force(&db, "p1", "", "development", &[]).unwrap();
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
        let r = upsert_force(&db, "p1", "", "development", &[]).unwrap();
        let ctx = get_project_context(&db, &r.id, 5, false).unwrap();
        assert!(ctx.notes.is_empty());
        assert!(ctx.decisions.is_empty());
        assert!(ctx.artifacts.is_empty());
    }

    #[test]
    fn normalize_collapses_separators_and_case() {
        assert_eq!(normalize_name("Pcoriente-Admin"), "pcorienteadmin");
        assert_eq!(normalize_name("pcoriente_admin"), "pcorienteadmin");
        assert_eq!(normalize_name("Pcoriente Admin"), "pcorienteadmin");
        assert_eq!(normalize_name("pcorienteAdmin"), "pcorienteadmin");
    }

    #[test]
    fn tier1_auto_merges_normalized_variants() {
        let db = fresh();
        let first =
            upsert(&db, "pcoriente-admin", "v1", "development", &[], false).unwrap();
        let id1 = first.id().unwrap().to_string();
        assert!(matches!(first, UpsertOutcome::Created { .. }));

        let second =
            upsert(&db, "Pcoriente_Admin", "v2", "development", &[], false).unwrap();
        match second {
            UpsertOutcome::AutoMerged { id, matched_by, .. } => {
                assert_eq!(id, id1);
                assert_eq!(matched_by, "normalized");
            }
            other => panic!("expected AutoMerged, got {:?}", other),
        }
    }

    #[test]
    fn tier2_returns_ambiguous_for_token_overlap() {
        let db = fresh();
        upsert(&db, "pcoriente-admin", "", "development", &[], false).unwrap();

        // "pcoriente" shares the "pcoriente" token but normalizes differently.
        let out =
            upsert(&db, "pcoriente", "sistema", "development", &[], false).unwrap();
        match out {
            UpsertOutcome::Ambiguous { candidates, .. } => {
                assert_eq!(candidates.len(), 1);
                assert_eq!(candidates[0].name, "pcoriente-admin");
                assert!(candidates[0].reason.contains("pcoriente"));
            }
            other => panic!("expected Ambiguous, got {:?}", other),
        }
    }

    #[test]
    fn tier2_can_be_bypassed_with_confirm_new() {
        let db = fresh();
        upsert(&db, "pcoriente-admin", "", "development", &[], false).unwrap();

        let out =
            upsert(&db, "pcoriente", "sistema", "development", &[], true).unwrap();
        assert!(matches!(out, UpsertOutcome::Created { .. }));
    }

    #[test]
    fn tier2b_prefix_match_catches_abbreviation() {
        let db = fresh();
        upsert(&db, "pcoriente-admin", "", "development", &[], false).unwrap();

        // "pco" (len 3) is prefix of "pcoriente" (len 9) → should flag.
        let out =
            upsert(&db, "pco_backup", "", "development", &[], false).unwrap();
        match out {
            UpsertOutcome::Ambiguous { candidates, .. } => {
                assert_eq!(candidates.len(), 1);
                assert_eq!(candidates[0].name, "pcoriente-admin");
                assert!(candidates[0].reason.contains("prefix overlap"));
                assert!(candidates[0].reason.contains("pco"));
            }
            other => panic!("expected Ambiguous, got {:?}", other),
        }
    }

    #[test]
    fn tier2b_prefix_does_not_match_below_3_chars() {
        let db = fresh();
        upsert(&db, "pcoriente-admin", "", "development", &[], false).unwrap();

        // "pc" is len 2 → filtered out by prefix_tokens.
        let out = upsert(&db, "pc_backup", "", "development", &[], false).unwrap();
        assert!(matches!(out, UpsertOutcome::Created { .. }));
    }

    #[test]
    fn delete_project_cascade_removes_dependents() {
        let db = fresh();
        let r = upsert_force(&db, "to_delete", "", "development", &[]).unwrap();
        let other = upsert_force(&db, "keep_me", "", "development", &[]).unwrap();

        db.with(|conn| {
            conn.execute(
                "INSERT INTO notes (id, project_id, content, tags) VALUES ('n1', ?, 'x', '[]')",
                params![r.id],
            )?;
            conn.execute(
                "INSERT INTO sessions (id, title, summary, project_id) VALUES ('s1', 't', '{}', ?)",
                params![r.id],
            )?;
            conn.execute(
                "INSERT INTO working_state (session_id, focus) VALUES ('s1', 'f')",
                [],
            )?;
            conn.execute(
                "INSERT INTO links (id, from_type, from_id, to_type, to_id) VALUES ('l1', 'note', 'n1', 'project', ?)",
                params![r.id],
            )?;
            // keep_me note must survive
            conn.execute(
                "INSERT INTO notes (id, project_id, content, tags) VALUES ('n2', ?, 'y', '[]')",
                params![other.id],
            )?;
            Ok(())
        })
        .unwrap();

        let counts = delete_project_cascade(&db, &r.id).unwrap();
        assert_eq!(counts.notes, 1);
        assert_eq!(counts.sessions, 1);
        assert_eq!(counts.working_states, 1);
        assert_eq!(counts.links, 1);

        assert!(get(&db, &r.id).unwrap().is_none());
        assert!(get(&db, &other.id).unwrap().is_some());

        db.with(|conn| {
            let n: i64 = conn.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0))?;
            assert_eq!(n, 1);
            let s: i64 = conn.query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))?;
            assert_eq!(s, 0);
            let w: i64 = conn.query_row("SELECT COUNT(*) FROM working_state", [], |r| r.get(0))?;
            assert_eq!(w, 0);
            let l: i64 = conn.query_row("SELECT COUNT(*) FROM links", [], |r| r.get(0))?;
            assert_eq!(l, 0);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn merge_project_into_reparents_children_and_deletes_source() {
        let db = fresh();
        let src = upsert_force(&db, "src", "", "development", &[]).unwrap();
        let dst = upsert_force(&db, "dst", "", "development", &[]).unwrap();

        db.with(|conn| {
            conn.execute(
                "INSERT INTO notes (id, project_id, content, tags) VALUES ('n1', ?, 'x', '[]')",
                params![src.id],
            )?;
            conn.execute(
                "INSERT INTO sessions (id, title, summary, project_id) VALUES ('s1', 't', '{}', ?)",
                params![src.id],
            )?;
            conn.execute(
                "INSERT INTO links (id, from_type, from_id, to_type, to_id) VALUES ('l1', 'note', 'n1', 'project', ?)",
                params![src.id],
            )?;
            Ok(())
        })
        .unwrap();

        let counts = merge_project_into(&db, &src.id, &dst.id).unwrap();
        assert_eq!(counts.notes, 1);
        assert_eq!(counts.sessions, 1);
        assert_eq!(counts.links, 1);

        assert!(get(&db, &src.id).unwrap().is_none());
        assert!(get(&db, &dst.id).unwrap().is_some());

        db.with(|conn| {
            let n: String = conn.query_row(
                "SELECT project_id FROM notes WHERE id='n1'",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(n, dst.id);
            let s: String = conn.query_row(
                "SELECT project_id FROM sessions WHERE id='s1'",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(s, dst.id);
            let l: String = conn.query_row(
                "SELECT to_id FROM links WHERE id='l1'",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(l, dst.id);
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn merge_project_same_src_dst_fails() {
        let db = fresh();
        let p = upsert_force(&db, "p", "", "development", &[]).unwrap();
        assert!(merge_project_into(&db, &p.id, &p.id).is_err());
    }

    #[test]
    fn merge_project_missing_src_fails() {
        let db = fresh();
        let p = upsert_force(&db, "p", "", "development", &[]).unwrap();
        assert!(merge_project_into(&db, "missing", &p.id).is_err());
    }

    #[test]
    fn delete_project_missing_fails() {
        let db = fresh();
        assert!(delete_project_cascade(&db, "no-such-id").is_err());
    }

    #[test]
    fn tier2_does_not_trigger_for_unrelated_names() {
        let db = fresh();
        upsert(&db, "purifreze_movil", "", "development", &[], false).unwrap();

        let out =
            upsert(&db, "blogcms", "", "development", &[], false).unwrap();
        assert!(matches!(out, UpsertOutcome::Created { .. }));
    }
}
