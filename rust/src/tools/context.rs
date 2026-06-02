//! Context tools. Mirrors `src/tools/context.ts`.

use rmcp::{
    handler::server::wrapper::Parameters,
    model::CallToolResult,
    schemars, tool, tool_router, ErrorData,
};
use serde::Deserialize;

use crate::repo::{context as repo_context, projects, working_state};
use crate::summary::{ContextSummary, SessionSummary};

use super::{json_result, repo_error, MemoryService};

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SetWorkingStateArgs {
    pub session_id: String,
    pub focus: String,
    pub open_threads: Vec<String>,
    /// Pinned IDs. May use raw id or type:id, for example code_entity:abc.
    pub pinned_ids: Vec<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GetWorkingStateArgs {
    pub session_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct UpdateProjectContextSummaryArgs {
    pub project_id: String,
    pub context_summary: ContextSummary,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct BuildContextArgs {
    pub project_id: String,
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
    #[serde(default)]
    pub token_budget: Option<i64>,
}

#[tool_router(router = context_router, vis = "pub(crate)")]
impl MemoryService {
    #[tool(description = "Stores the active working state for one session. Used by build_context for prioritization.")]
    pub async fn set_working_state(
        &self,
        Parameters(args): Parameters<SetWorkingStateArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        working_state::set(
            &self.db,
            &args.session_id,
            &args.focus,
            &args.open_threads,
            &args.pinned_ids,
        )
        .map_err(repo_error)?;
        json_result(&serde_json::json!({ "ok": true }))
    }

    #[tool(description = "Returns active focus, open threads, and pinned memory for one session.")]
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
