//! Mutation tools: update/delete for note/artifact + mark_obsolete + audit_stale.
//! `update_decision`/`delete_decision` were removed in v12: the `decisions`
//! table is frozen legacy — decisions live in append-only `decision_records`
//! (see tools/decision_records.rs), which has no update/delete by design.

use rmcp::{
    handler::server::wrapper::Parameters,
    model::CallToolResult,
    schemars, tool, tool_router, ErrorData,
};
use serde::Deserialize;

use crate::repo::{artifacts, mutations, notes};
use crate::sanitize::strip_tool_call_tags;

use super::{json_result, repo_error, MemoryService};

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum EntityType {
    Note,
    Decision,
    Artifact,
    CodeEntity,
}

impl EntityType {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            EntityType::Note => "note",
            EntityType::Decision => "decision",
            EntityType::Artifact => "artifact",
            EntityType::CodeEntity => "code_entity",
        }
    }
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct UpdateNoteArgs {
    pub id: String,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default, deserialize_with = "super::flex_int::opt::deserialize")]
    pub importance: Option<i64>,
    #[serde(default)]
    pub topic_key: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct DeleteByIdArgs {
    pub id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct UpdateArtifactArgs {
    pub id: String,
    #[serde(default, rename = "type")]
    pub artifact_type: Option<String>,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default, deserialize_with = "super::flex_int::opt::deserialize")]
    pub importance: Option<i64>,
    #[serde(default)]
    pub topic_key: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct MarkObsoleteArgs {
    #[serde(rename = "type")]
    pub entity_type: EntityType,
    pub id: String,
    /// Concrete reason why it no longer applies.
    pub reason: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct AuditStaleArgs {
    /// Minimum age in days (default: 30).
    #[serde(default, deserialize_with = "super::flex_int::opt::deserialize")]
    pub days: Option<i64>,
    #[serde(default)]
    pub project_id: Option<String>,
}

#[tool_router(router = mutations_router, vis = "pub(crate)")]
impl MemoryService {
    #[tool(description = "Updates an existing note. If the fact no longer applies, use mark_obsolete instead.")]
    pub async fn update_note(
        &self,
        Parameters(args): Parameters<UpdateNoteArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let content = args.content.as_deref().map(strip_tool_call_tags);
        let modified = notes::update(
            &self.db,
            &args.id,
            content.as_deref(),
            args.tags.as_deref(),
            args.importance,
            args.topic_key.as_deref(),
        )
        .map_err(repo_error)?;
        json_result(&serde_json::json!({ "modified": modified }))
    }

    #[tool(description = "Permanently deletes a note. Use only for garbage; prefer mark_obsolete for outdated.")]
    pub async fn delete_note(
        &self,
        Parameters(args): Parameters<DeleteByIdArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        notes::delete(&self.db, &args.id).map_err(repo_error)?;
        json_result(&serde_json::json!({ "ok": true }))
    }

    #[tool(description = "Updates an existing artifact. If no longer valid, use mark_obsolete instead.")]
    pub async fn update_artifact(
        &self,
        Parameters(args): Parameters<UpdateArtifactArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let content = args.content.as_deref().map(strip_tool_call_tags);
        let modified = artifacts::update(
            &self.db,
            &args.id,
            args.artifact_type.as_deref(),
            content.as_deref(),
            args.importance,
            args.topic_key.as_deref(),
        )
        .map_err(repo_error)?;
        json_result(&serde_json::json!({ "modified": modified }))
    }

    #[tool(description = "Permanently deletes an artifact. Prefer mark_obsolete for historical but outdated artifacts.")]
    pub async fn delete_artifact(
        &self,
        Parameters(args): Parameters<DeleteByIdArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        artifacts::delete(&self.db, &args.id).map_err(repo_error)?;
        json_result(&serde_json::json!({ "ok": true }))
    }

    #[tool(description = "Marks an entity obsolete without deleting history. Keeps the DB auditable while excluding it from normal context.")]
    pub async fn mark_obsolete(
        &self,
        Parameters(args): Parameters<MarkObsoleteArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        if matches!(args.entity_type, EntityType::Decision) {
            return Err(ErrorData::invalid_params(
                "the decisions table is frozen legacy: use decision_revert (undone) or \
                 decision_record with supersedes (replaced) on decision_records instead"
                    .to_string(),
                None,
            ));
        }
        let reason = strip_tool_call_tags(&args.reason);
        mutations::mark_obsolete(&self.db, args.entity_type.as_str(), &args.id, &reason)
            .map_err(repo_error)?;
        json_result(&serde_json::json!({ "ok": true }))
    }

    #[tool(description = "Lists active entities not updated in N days (default 30). Use to find memory that may need refresh or mark_obsolete.")]
    pub async fn audit_stale(
        &self,
        Parameters(args): Parameters<AuditStaleArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let days = args.days.unwrap_or(30);
        let result = mutations::audit_stale(&self.db, days, args.project_id.as_deref())
            .map_err(repo_error)?;
        json_result(&result)
    }
}
