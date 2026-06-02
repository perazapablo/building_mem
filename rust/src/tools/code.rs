//! Code-entity tools. Mirrors `src/tools/code.ts`.

use rmcp::{
    handler::server::wrapper::Parameters,
    model::CallToolResult,
    schemars, tool, tool_router, ErrorData,
};
use serde::Deserialize;

use crate::repo::code_entities::{
    self, AddCodeEntity as RepoAdd, UpdateCodeEntity as RepoUpdate,
};

use super::{json_result, repo_error, MemoryService};

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CodeEntityKind {
    Module,
    File,
    Function,
    Class,
    Method,
    Endpoint,
    Config,
    Schema,
}

impl CodeEntityKind {
    fn as_str(&self) -> &'static str {
        match self {
            CodeEntityKind::Module => "module",
            CodeEntityKind::File => "file",
            CodeEntityKind::Function => "function",
            CodeEntityKind::Class => "class",
            CodeEntityKind::Method => "method",
            CodeEntityKind::Endpoint => "endpoint",
            CodeEntityKind::Config => "config",
            CodeEntityKind::Schema => "schema",
        }
    }
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct AddCodeEntityArgs {
    pub project_id: String,
    pub kind: CodeEntityKind,
    pub name: String,
    #[serde(default)]
    pub qualified_name: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub signature: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub inputs: Option<String>,
    #[serde(default)]
    pub outputs: Option<String>,
    #[serde(default)]
    pub side_effects: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub importance: Option<i64>,
    #[serde(default)]
    pub topic_key: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct UpdateCodeEntityArgs {
    pub id: String,
    #[serde(default)]
    pub kind: Option<CodeEntityKind>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub qualified_name: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub signature: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub inputs: Option<String>,
    #[serde(default)]
    pub outputs: Option<String>,
    #[serde(default)]
    pub side_effects: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub importance: Option<i64>,
    #[serde(default)]
    pub topic_key: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GetCodeEntityArgs {
    pub id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SearchCodeEntitiesArgs {
    pub query: String,
    #[serde(default)]
    pub project_id: Option<String>,
    /// Max results (default: 10, max: 20).
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub include_obsolete: Option<bool>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GetCodeEntityContextArgs {
    pub project_id: String,
    pub query: String,
    /// Max results (default: 10, max: 20).
    #[serde(default)]
    pub limit: Option<i64>,
}

#[tool_router(router = code_router, vis = "pub(crate)")]
impl MemoryService {
    #[tool(
        description = "Stores structured memory about code: module, file, function, class, method, \
            endpoint, config, or schema. Enables questions like 'what does the XML parser do?'"
    )]
    pub async fn add_code_entity(
        &self,
        Parameters(args): Parameters<AddCodeEntityArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let tags_default: Vec<String> = args.tags.unwrap_or_default();
        let qn = args.qualified_name.unwrap_or_default();
        let path = args.path.unwrap_or_default();
        let sig = args.signature.unwrap_or_default();
        let summary = args.summary.unwrap_or_default();
        let inputs = args.inputs.unwrap_or_default();
        let outputs = args.outputs.unwrap_or_default();
        let side_effects = args.side_effects.unwrap_or_default();
        let id = code_entities::add(
            &self.db,
            &RepoAdd {
                project_id: &args.project_id,
                kind: args.kind.as_str(),
                name: &args.name,
                qualified_name: &qn,
                path: &path,
                signature: &sig,
                summary: &summary,
                inputs: &inputs,
                outputs: &outputs,
                side_effects: &side_effects,
                tags: &tags_default,
                importance: args.importance,
                topic_key: args.topic_key.as_deref(),
            },
        )
        .map_err(repo_error)?;
        json_result(&serde_json::json!({ "id": id }))
    }

    #[tool(description = "Updates structured memory for an existing code entity.")]
    pub async fn update_code_entity(
        &self,
        Parameters(args): Parameters<UpdateCodeEntityArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let kind_owned = args.kind.as_ref().map(|k| k.as_str());
        let tags_owned = args.tags;
        let updates = RepoUpdate {
            kind: kind_owned,
            name: args.name.as_deref(),
            qualified_name: args.qualified_name.as_deref(),
            path: args.path.as_deref(),
            signature: args.signature.as_deref(),
            summary: args.summary.as_deref(),
            inputs: args.inputs.as_deref(),
            outputs: args.outputs.as_deref(),
            side_effects: args.side_effects.as_deref(),
            tags: tags_owned.as_deref(),
            importance: args.importance,
            topic_key: args.topic_key.as_deref(),
        };
        let modified = code_entities::update(&self.db, &args.id, &updates).map_err(repo_error)?;
        json_result(&serde_json::json!({ "modified": modified }))
    }

    #[tool(description = "Returns one code entity by ID.")]
    pub async fn get_code_entity(
        &self,
        Parameters(args): Parameters<GetCodeEntityArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let entity = code_entities::get(&self.db, &args.id).map_err(repo_error)?;
        json_result(&entity)
    }

    #[tool(description = "Searches structured code memory with FTS5.")]
    pub async fn search_code_entities(
        &self,
        Parameters(args): Parameters<SearchCodeEntitiesArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let limit = args.limit.unwrap_or(10).min(20);
        let include_obsolete = args.include_obsolete.unwrap_or(false);
        let rows = code_entities::search(
            &self.db,
            &args.query,
            args.project_id.as_deref(),
            limit,
            include_obsolete,
        )
        .map_err(repo_error)?;
        json_result(&rows)
    }

    #[tool(
        description = "Returns active code memory for a project and query. \
            Use as focused context before answering code-knowledge questions."
    )]
    pub async fn get_code_entity_context(
        &self,
        Parameters(args): Parameters<GetCodeEntityContextArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let limit = args.limit.unwrap_or(10).min(20);
        let ctx = code_entities::get_context(&self.db, &args.project_id, &args.query, limit)
            .map_err(repo_error)?;
        json_result(&ctx)
    }
}
