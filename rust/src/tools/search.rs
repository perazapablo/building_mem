//! Search tool: search_all across notes/decisions/artifacts/code_entities.
//! Mirrors `src/tools/search.ts`.

use rmcp::{
    handler::server::wrapper::Parameters,
    model::CallToolResult,
    schemars, tool, tool_router, ErrorData,
};
use serde::Deserialize;

use crate::repo::search;

use super::{json_result, repo_error, MemoryService};

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SearchAllArgs {
    pub query: String,
    #[serde(default)]
    pub project_id: Option<String>,
    /// Maximum total results (default: 10, max: 50).
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub include_obsolete: Option<bool>,
}

#[tool_router(router = search_router, vis = "pub(crate)")]
impl MemoryService {
    #[tool(
        description = "Searches notes, decisions, artifacts, and code_entities in one FTS5 call. \
            Use when the DB should answer a question but the memory type is unknown."
    )]
    pub async fn search_all(
        &self,
        Parameters(args): Parameters<SearchAllArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let limit = args.limit.unwrap_or(10);
        let include_obsolete = args.include_obsolete.unwrap_or(false);
        let r = search::search_all(
            &self.db,
            &args.query,
            args.project_id.as_deref(),
            limit,
            include_obsolete,
        )
        .map_err(repo_error)?;
        json_result(&r)
    }
}
