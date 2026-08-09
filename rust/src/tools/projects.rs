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
    /// If true, bypass tier 2 (fuzzy match by shared tokens) and force
    /// creation. Use only when you have explicitly confirmed it is a
    /// genuinely new project that happens to share tokens with existing ones.
    #[serde(default)]
    pub confirm_new: Option<bool>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ListProjectsArgs {}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GetProjectArgs {
    pub project_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GetProjectContextArgs {
    pub project_id: String,
    /// Max records per type (default: 5).
    #[serde(default, deserialize_with = "super::flex_int::opt::deserialize")]
    pub limit: Option<i64>,
    /// If true, include obsolete records. Default: false.
    #[serde(default)]
    pub include_obsolete: Option<bool>,
}

#[tool_router(router = projects_router, vis = "pub(crate)")]
impl MemoryService {
    #[tool(
        description = "Resolve or create a project. Two-tier dedup:\n\
            • Tier 1 (auto-merge): if the normalized name (lowercase, strip non-alphanumeric) \
              equals an existing project, returns that id with outcome='auto_merged'.\n\
            • Tier 2 (ambiguous): if the name shares any significant token (len>=4) with \
              existing projects, returns outcome='ambiguous' with candidates and writes nothing. \
              Caller must either re-issue with confirm_new=true, or use one of the candidate ids.\n\
            • Otherwise inserts a new row with outcome='created'.\n\
            ALWAYS inspect 'outcome' before continuing."
    )]
    pub async fn upsert_project(
        &self,
        Parameters(args): Parameters<UpsertProjectArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let outcome = projects::upsert(
            &self.db,
            &args.name,
            &args.description,
            args.project_type.as_str(),
            &args.tags,
            args.confirm_new.unwrap_or(false),
        )
        .map_err(repo_error)?;
        json_result(&outcome)
    }

    #[tool(
        description = "Compact index of all projects: id, name, project_type, tags, updated_at. \
            Does NOT include description or context_summary — call get_project(id) once the \
            target project is identified. Use this at session start to detect continuity and \
            before upsert_project to check for existing matches."
    )]
    pub async fn list_projects(
        &self,
        Parameters(_): Parameters<ListProjectsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let rows = projects::list_index(&self.db).map_err(repo_error)?;
        json_result(&rows)
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
