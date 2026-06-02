//! Project tools. Mirrors `src/tools/projects.ts`.

use rmcp::{
    handler::server::wrapper::Parameters,
    model::CallToolResult,
    schemars, tool, tool_router, ErrorData,
};
use serde::Deserialize;

use crate::repo::projects;

use super::{json_result, repo_error, MemoryService};

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProjectType {
    Development,
    Research,
    Integration,
    Learning,
    Other,
}

impl ProjectType {
    fn as_str(&self) -> &'static str {
        match self {
            ProjectType::Development => "development",
            ProjectType::Research => "research",
            ProjectType::Integration => "integration",
            ProjectType::Learning => "learning",
            ProjectType::Other => "other",
        }
    }
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct UpsertProjectArgs {
    /// Unique project name in snake_case.
    pub name: String,
    /// Short project description.
    pub description: String,
    /// Project type; guides what memory is relevant to capture.
    pub project_type: ProjectType,
    /// Tags for project categorization.
    pub tags: Vec<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GetProjectArgs {
    pub project_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GetProjectContextArgs {
    pub project_id: String,
    /// Max records per type (default: 5).
    #[serde(default)]
    pub limit: Option<i64>,
    /// If true, include obsolete records. Default: false.
    #[serde(default)]
    pub include_obsolete: Option<bool>,
}

#[tool_router(router = projects_router, vis = "pub(crate)")]
impl MemoryService {
    #[tool(
        description = "Creates a project or updates an existing one. \
            If existed=true, load persistent memory before continuing."
    )]
    pub async fn upsert_project(
        &self,
        Parameters(args): Parameters<UpsertProjectArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let r = projects::upsert(
            &self.db,
            &args.name,
            &args.description,
            args.project_type.as_str(),
            &args.tags,
        )
        .map_err(repo_error)?;
        json_result(&serde_json::json!({
            "id": r.id,
            "existed": r.existed,
            "name": args.name,
            "project_type": args.project_type.as_str(),
        }))
    }

    #[tool(description = "Returns one project by ID, including its compact context_summary when present.")]
    pub async fn get_project(
        &self,
        Parameters(args): Parameters<GetProjectArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let p = projects::get(&self.db, &args.project_id).map_err(repo_error)?;
        json_result(&p)
    }

    #[tool(
        description = "Returns active notes, decisions, and artifacts for quick project context. \
            For normal work prefer build_context (token-aware)."
    )]
    pub async fn get_project_context(
        &self,
        Parameters(args): Parameters<GetProjectContextArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let limit = args.limit.unwrap_or(5);
        let include_obsolete = args.include_obsolete.unwrap_or(false);
        let ctx = projects::get_project_context(&self.db, &args.project_id, limit, include_obsolete)
            .map_err(repo_error)?;
        json_result(&ctx)
    }
}
