//! Session tools: `get_sessions`, `save_session`, `update_session`.
//! Mirrors `src/tools/sessions.ts`.

use rmcp::{
    handler::server::wrapper::Parameters,
    model::CallToolResult,
    schemars, tool, tool_router, ErrorData,
};
use serde::Deserialize;

use crate::repo::sessions;
use crate::summary::SessionSummary;

use super::{json_result, repo_error, MemoryService};

const SESSIONS_INDEX_LIMIT: i64 = 5;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GetSessionsArgs {
    /// Project ID to scope the session list to. Required.
    pub project_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SaveSessionArgs {
    /// Descriptive session title.
    pub title: String,
    /// Structured session summary.
    pub summary: SessionSummary,
    /// Project ID this session belongs to.
    #[serde(default)]
    pub project_id: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct UpdateSessionArgs {
    /// Session ID to update.
    pub id: String,
    /// Structured session summary replacing the previous one.
    pub summary: SessionSummary,
}

#[tool_router(router = sessions_router, vis = "pub(crate)")]
impl MemoryService {
    #[tool(
        description = "Returns the 5 most recent sessions for the given project (compact index: \
            id, title, project_id, created_at, updated_at). Requires project_id. \
            Does NOT include the structured summary — fetch a specific session directly \
            when needed. Use to detect continuity within a project; there is no cross-project \
            listing on purpose."
    )]
    pub async fn get_sessions(
        &self,
        Parameters(args): Parameters<GetSessionsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let rows = sessions::list_index(&self.db, &args.project_id, SESSIONS_INDEX_LIMIT)
            .map_err(repo_error)?;
        json_result(&rows)
    }

    #[tool(
        description = "Creates a new session index with a STRUCTURED summary. \
            Use when starting work that should be resumable later. \
            Keep arrays short; reference decisions/artifacts by ID instead of duplicating content."
    )]
    pub async fn save_session(
        &self,
        Parameters(args): Parameters<SaveSessionArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let id = sessions::save(&self.db, &args.title, &args.summary, args.project_id.as_deref())
            .map_err(repo_error)?;
        json_result(&serde_json::json!({ "id": id }))
    }

    #[tool(
        description = "Updates an existing session summary with a STRUCTURED replacement. \
            Replace the full summary object — do not append indefinitely."
    )]
    pub async fn update_session(
        &self,
        Parameters(args): Parameters<UpdateSessionArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        sessions::update(&self.db, &args.id, &args.summary).map_err(repo_error)?;
        json_result(&serde_json::json!({ "ok": true }))
    }
}
