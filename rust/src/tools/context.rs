//! Context tools. Mirrors `src/tools/context.ts`.

use rmcp::{
    handler::server::wrapper::Parameters,
    model::CallToolResult,
    schemars, tool, tool_router, ErrorData,
};
use serde::Deserialize;

use crate::repo::{context as repo_context, projects, session_focus, working_state};
use crate::summary::{ContextSummary, SessionSummary};

use super::{json_result, repo_error, MemoryService};

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SetWorkingStateArgs {
    pub session_id: String,
    pub focus: String,
    /// Pinned IDs. May use raw id or type:id, for example code_entity:abc.
    pub pinned_ids: Vec<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GetWorkingStateArgs {
    pub session_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SetFocusArgs {
    pub session_id: String,
    pub project_id: String,
    /// Non-empty description of what the session is working on right now.
    pub focus: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GetFocusArgs {
    pub session_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GetLatestFocusForProjectArgs {
    pub project_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct UpdateProjectContextSummaryArgs {
    pub project_id: String,
    pub context_summary: ContextSummary,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct BuildContextArgs {
    pub project_id: String,
    #[serde(deserialize_with = "super::flex_int::deserialize")]
    pub token_budget: i64,
    #[serde(default)]
    pub session_id: Option<String>,
    /// Tokenizer model for accurate budget accounting. Supported: 'anthropic:claude', \
    /// 'openai:o200k_base', 'openai:cl100k_base'.
    #[serde(default)]
    pub tokenizer_model: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct CheckpointArgs {
    pub session_id: String,
    pub project_id: String,
    #[serde(default)]
    pub session_summary: Option<SessionSummary>,
    #[serde(default)]
    pub context_summary: Option<ContextSummary>,
    /// Budget for the associated build_context call (default: 4000).
    #[serde(default, deserialize_with = "super::flex_int::opt::deserialize")]
    pub token_budget: Option<i64>,
}

#[tool_router(router = context_router, vis = "pub(crate)")]
impl MemoryService {
    #[tool(
        description = "Stores focus + pinned_ids for one session. `open_threads` was removed — \
            use `open_thread` / `close_thread` for lifecycle-tracked threads instead. Focus set \
            here is mirrored to `session_focus` when `set_focus` is used explicitly."
    )]
    pub async fn set_working_state(
        &self,
        Parameters(args): Parameters<SetWorkingStateArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        working_state::set(&self.db, &args.session_id, &args.focus, &args.pinned_ids)
            .map_err(repo_error)?;
        json_result(&serde_json::json!({ "ok": true }))
    }

    #[tool(
        description = "Upsert the current focus of a session, scoped to a project. Atomic and \
            small — preferred over set_working_state when you only want to change focus. \
            The harness may require this to be set before persistent actions."
    )]
    pub async fn set_focus(
        &self,
        Parameters(args): Parameters<SetFocusArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let row = session_focus::set(&self.db, &args.session_id, &args.project_id, &args.focus)
            .map_err(repo_error)?;
        // Mirror to working_state so build_context and legacy consumers see it.
        let _ = working_state::set(&self.db, &args.session_id, &args.focus, &[]);
        json_result(&row)
    }

    #[tool(description = "Returns the focus record for one session, or null.")]
    pub async fn get_focus(
        &self,
        Parameters(args): Parameters<GetFocusArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let row = session_focus::get(&self.db, &args.session_id).map_err(repo_error)?;
        json_result(&row)
    }

    #[tool(
        description = "Returns the most recently updated focus for a project across all its \
            sessions, or null. Cheap read the harness uses to compute `stats.last_focus`."
    )]
    pub async fn get_latest_focus_for_project(
        &self,
        Parameters(args): Parameters<GetLatestFocusForProjectArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let row = session_focus::get_latest_for_project(&self.db, &args.project_id)
            .map_err(repo_error)?;
        json_result(&row)
    }

    #[tool(description = "Returns focus and pinned memory for one session.")]
    pub async fn get_working_state(
        &self,
        Parameters(args): Parameters<GetWorkingStateArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let ws = working_state::get(&self.db, &args.session_id).map_err(repo_error)?;
        json_result(&ws)
    }

    #[tool(description = "Updates the STRUCTURED project-level context summary.")]
    pub async fn update_project_context_summary(
        &self,
        Parameters(args): Parameters<UpdateProjectContextSummaryArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        projects::update_context_summary(&self.db, &args.project_id, &args.context_summary)
            .map_err(repo_error)?;
        json_result(&serde_json::json!({ "ok": true }))
    }

    #[tool(
        description = "Builds a token-aware context bundle from persistent DB memory. \
            Use after identifying the project and before answering project-specific tasks."
    )]
    pub async fn build_context(
        &self,
        Parameters(args): Parameters<BuildContextArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let r = repo_context::build_context(
            &self.db,
            &args.project_id,
            args.token_budget,
            args.session_id.as_deref(),
            args.tokenizer_model.as_deref(),
        )
        .map_err(repo_error)?;
        json_result(&r)
    }

    #[tool(
        description = "Consolidates a session or work stage into persistent memory with STRUCTURED summaries. \
            If context_summary is omitted, MCP merges previous project context with current session pending."
    )]
    pub async fn checkpoint(
        &self,
        Parameters(args): Parameters<CheckpointArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let options = repo_context::CheckpointOptions {
            session_summary: args.session_summary,
            context_summary: args.context_summary,
            token_budget: args.token_budget,
        };
        let r = repo_context::checkpoint(&self.db, &args.session_id, &args.project_id, &options)
            .map_err(repo_error)?;
        json_result(&r)
    }
}
