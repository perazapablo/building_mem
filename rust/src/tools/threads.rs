//! Project-scoped thread lifecycle tools.

use rmcp::{
    handler::server::wrapper::Parameters,
    model::CallToolResult,
    schemars, tool, tool_router, ErrorData,
};
use serde::Deserialize;

use crate::repo::project_threads;

use super::{json_result, repo_error, MemoryService};

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct OpenThreadArgs {
    pub project_id: String,
    /// Short human-readable description of the open work item.
    pub thread: String,
    /// Session that is opening the thread.
    pub session_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CloseStatus {
    Done,
    Dropped,
}

impl CloseStatus {
    fn as_str(&self) -> &'static str {
        match self {
            CloseStatus::Done => "done",
            CloseStatus::Dropped => "dropped",
        }
    }
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct CloseThreadArgs {
    pub thread_id: String,
    /// 'done' when the work was completed; 'dropped' when abandoned.
    pub status: CloseStatus,
    /// Optional explanation stored with the closure.
    #[serde(default)]
    pub reason: Option<String>,
    /// Session that is closing the thread.
    pub session_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct TouchThreadArgs {
    pub thread_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ListOpenThreadsArgs {
    pub project_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ListProjectThreadsArgs {
    pub project_id: String,
    /// Optional status filter: 'open', 'done', 'dropped', 'stale'.
    /// Omit to list all.
    #[serde(default)]
    pub status: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct MarkStaleArgs {
    pub project_id: String,
    /// Threads with `status='open'` untouched for more than `days` days
    /// are moved to `status='stale'`.
    #[serde(deserialize_with = "super::flex_int::deserialize")]
    pub days: i64,
}

#[tool_router(router = threads_router, vis = "pub(crate)")]
impl MemoryService {
    #[tool(
        description = "Open a new thread on a project. Threads live at project scope: they survive \
            across sessions until closed explicitly. Use this the moment a real TODO appears in \
            the work — not for speculative ideas."
    )]
    pub async fn open_thread(
        &self,
        Parameters(args): Parameters<OpenThreadArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let t = project_threads::open(&self.db, &args.project_id, &args.thread, &args.session_id)
            .map_err(repo_error)?;
        json_result(&t)
    }

    #[tool(
        description = "Close an open thread with status='done' or 'dropped'. Errors if already \
            closed. Records which session closed it plus an optional reason. Preferred over \
            leaving a thread quiet — visibility of open work depends on explicit closure."
    )]
    pub async fn close_thread(
        &self,
        Parameters(args): Parameters<CloseThreadArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let t = project_threads::close(
            &self.db,
            &args.thread_id,
            args.status.as_str(),
            args.reason.as_deref(),
            &args.session_id,
        )
        .map_err(repo_error)?;
        json_result(&t)
    }

    #[tool(
        description = "Bump `updated_at` on an open thread without changing its status. Used to \
            signal that a decision/artifact in this session relates to the thread. Returns \
            {touched: bool}."
    )]
    pub async fn touch_thread(
        &self,
        Parameters(args): Parameters<TouchThreadArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let touched = project_threads::touch(&self.db, &args.thread_id).map_err(repo_error)?;
        json_result(&serde_json::json!({ "touched": touched }))
    }

    #[tool(
        description = "List threads currently open on a project, ordered by most-recently updated. \
            The harness reads this at session start to inject the real state of pending work."
    )]
    pub async fn list_open_threads(
        &self,
        Parameters(args): Parameters<ListOpenThreadsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let rows = project_threads::list_by_project(&self.db, &args.project_id, Some("open"))
            .map_err(repo_error)?;
        json_result(&rows)
    }

    #[tool(
        description = "List threads on a project with optional status filter ('open', 'done', \
            'dropped', 'stale'). Omit `status` for the full history."
    )]
    pub async fn list_project_threads(
        &self,
        Parameters(args): Parameters<ListProjectThreadsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let rows = project_threads::list_by_project(
            &self.db,
            &args.project_id,
            args.status.as_deref(),
        )
        .map_err(repo_error)?;
        json_result(&rows)
    }

    #[tool(
        description = "Mark open threads older than `days` as 'stale'. Non-destructive: the row \
            stays and can be re-opened or closed later. Called by the harness on a schedule to \
            surface neglected work instead of letting it rot silently."
    )]
    pub async fn mark_stale_threads(
        &self,
        Parameters(args): Parameters<MarkStaleArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let n = project_threads::mark_stale_older_than(&self.db, &args.project_id, args.days)
            .map_err(repo_error)?;
        json_result(&serde_json::json!({ "marked_stale": n }))
    }
}
