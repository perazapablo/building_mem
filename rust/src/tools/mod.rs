//! MCP service exposing the repo layer over stdio.
//!
//! Each domain (`sessions`, `projects`, …) defines its own
//! `#[tool_router(router = X_router)]` block on `MemoryService` in a
//! separate file. `MemoryService::new` combines them with `+`.

use std::sync::Arc;

use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{CallToolResult, Content, ServerCapabilities, ServerInfo},
    schemars, tool, tool_handler, tool_router, ErrorData, ServerHandler,
};
use serde::Serialize;

use crate::repo::Db;

pub mod code;
pub mod context;
pub mod flex_int;
pub mod graph;
pub mod harness;
pub mod knowledge;
pub mod mutations;
pub mod projects;
pub mod relations;
pub mod search;
pub mod sessions;
pub mod threads;

#[derive(Clone)]
pub struct MemoryService {
    pub(crate) db: Arc<Db>,
    tool_router: ToolRouter<Self>,
}

impl MemoryService {
    pub fn new(db: Arc<Db>) -> Self {
        let router = Self::ping_router()
            + Self::sessions_router()
            + Self::projects_router()
            + Self::knowledge_router()
            + Self::code_router()
            + Self::mutations_router()
            + Self::relations_router()
            + Self::graph_router()
            + Self::context_router()
            + Self::search_router()
            + Self::threads_router()
            + Self::harness_router();
        Self { db, tool_router: router }
    }
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct PingArgs {}

#[tool_router(router = ping_router)]
impl MemoryService {
    #[tool(description = "Health check. Returns 'pong'.")]
    async fn ping(&self, _args: Parameters<PingArgs>) -> String {
        "pong".to_string()
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for MemoryService {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_instructions(
                "Persistent memory MCP server (Rust port). Same protocol as the original \
                 TypeScript implementation.",
            )
    }
}

// ─── helpers shared across tool modules ─────────────────────────────────────

pub(crate) fn json_result<T: Serialize>(value: &T) -> Result<CallToolResult, ErrorData> {
    let text = serde_json::to_string(value).map_err(|e| {
        ErrorData::internal_error(format!("serialize result: {}", e), None)
    })?;
    Ok(CallToolResult::success(vec![Content::text(text)]))
}

pub(crate) fn repo_error(err: anyhow::Error) -> ErrorData {
    ErrorData::internal_error(format!("{:#}", err), None)
}
