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
    /// Project ID to scope the search to. Required — no cross-project search.
    pub project_id: String,
    /// Maximum total results (default: 10, max: 50).
    #[serde(default, deserialize_with = "super::flex_int::opt::deserialize")]
    pub limit: Option<i64>,
    #[serde(default)]
    pub include_obsolete: Option<bool>,
}

#[tool_router(router = search_router, vis = "pub(crate)")]
impl MemoryService {
    #[tool(
        description = "Searches notes, decisions, artifacts, and code_entities in one FTS5 call, \
            scoped to a single project (project_id required). Returns hits with TRUNCATED content \
            (~200 char snippets). Use to answer a question when the memory type is unknown; \
            fetch the full payload via get_note / get_artifact / get_code_entity when needed."
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
            &args.project_id,
            limit,
            include_obsolete,
        )
        .map_err(repo_error)?;
        json_result(&r)
    }
}
