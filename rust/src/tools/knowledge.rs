//! Knowledge tools: add_note, add_artifact, search_notes.
//! `add_decision` was removed in v12: the `decisions` table is frozen legacy;
//! decisions are recorded via `decision_record` (append-only chains).

use rmcp::{
    handler::server::wrapper::Parameters,
    model::CallToolResult,
    schemars, tool, tool_router, ErrorData,
};
use serde::Deserialize;

use crate::repo::{artifacts, notes};
use crate::sanitize::strip_tool_call_tags;

use super::{json_result, repo_error, MemoryService};

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct AddNoteArgs {
    pub project_id: String,
    pub content: String,
    pub tags: Vec<String>,
    /// Importance from 1 to 5 (default: 3).
    #[serde(default, deserialize_with = "super::flex_int::opt::deserialize")]
    pub importance: Option<i64>,
    /// Stable semantic collision key. Same active topic updates instead of inserting.
    #[serde(default)]
    pub topic_key: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct AddArtifactArgs {
    pub project_id: String,
    /// Artifact type: schema | api | config | design | plan | prompt | etc.
    #[serde(rename = "type")]
    pub artifact_type: String,
    pub content: String,
    #[serde(default, deserialize_with = "super::flex_int::opt::deserialize")]
    pub importance: Option<i64>,
    #[serde(default)]
    pub topic_key: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SearchNotesArgs {
    pub query: String,
    /// Project ID to scope the search to. Required — no cross-project search.
    pub project_id: String,
    /// Max results (default: 5, max: 5).
    #[serde(default, deserialize_with = "super::flex_int::opt::deserialize")]
    pub limit: Option<i64>,
    /// If true, include obsolete notes. Default: false.
    #[serde(default)]
    pub include_obsolete: Option<bool>,
}

#[tool_router(router = knowledge_router, vis = "pub(crate)")]
impl MemoryService {
    #[tool(
        description = "Stores one atomic durable fact in project memory. \
            Store one concept, observation, constraint, or user preference."
    )]
    pub async fn add_note(
        &self,
        Parameters(args): Parameters<AddNoteArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let content = strip_tool_call_tags(&args.content);
        let id = notes::add(
            &self.db,
            &args.project_id,
            &content,
            &args.tags,
            args.importance,
            args.topic_key.as_deref(),
        )
        .map_err(repo_error)?;
        json_result(&serde_json::json!({ "id": id }))
    }

    #[tool(
        description = "Stores a durable structured output such as a schema, API contract, config, \
            design, plan, or prompt."
    )]
    pub async fn add_artifact(
        &self,
        Parameters(args): Parameters<AddArtifactArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let content = strip_tool_call_tags(&args.content);
        let id = artifacts::add(
            &self.db,
            &args.project_id,
            &args.artifact_type,
            &content,
            args.importance,
            args.topic_key.as_deref(),
        )
        .map_err(repo_error)?;
        json_result(&serde_json::json!({ "id": id }))
    }

    #[tool(
        description = "Searches active notes with FTS5. Prefer search_all when the memory type is unknown."
    )]
    pub async fn search_notes(
        &self,
        Parameters(args): Parameters<SearchNotesArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let limit = args.limit.unwrap_or(5).min(5);
        let include_obsolete = args.include_obsolete.unwrap_or(false);
        let rows = notes::search(
            &self.db,
            &args.query,
            Some(&args.project_id),
            limit,
            include_obsolete,
        )
        .map_err(repo_error)?;
        json_result(&rows)
    }
}
