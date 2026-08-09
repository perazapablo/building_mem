//! Graph tools: add_link, get_related, get_audit_trail. Mirrors `src/tools/graph.ts`.

use rmcp::{
    handler::server::wrapper::Parameters,
    model::CallToolResult,
    schemars, tool, tool_router, ErrorData,
};
use serde::Deserialize;

use crate::repo::links;

use super::mutations::EntityType;
use super::{json_result, repo_error, MemoryService};

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AuditEntityType {
    Session,
    Project,
    Note,
    Decision,
    Artifact,
    Link,
    CodeEntity,
}

impl AuditEntityType {
    fn as_str(&self) -> &'static str {
        match self {
            AuditEntityType::Session => "session",
            AuditEntityType::Project => "project",
            AuditEntityType::Note => "note",
            AuditEntityType::Decision => "decision",
            AuditEntityType::Artifact => "artifact",
            AuditEntityType::Link => "link",
            AuditEntityType::CodeEntity => "code_entity",
        }
    }
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct AddLinkArgs {
    pub from_type: EntityType,
    pub from_id: String,
    pub to_type: EntityType,
    pub to_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GetRelatedArgs {
    pub entity_type: EntityType,
    pub entity_id: String,
    /// Traversal depth (default: 1).
    #[serde(default, deserialize_with = "super::flex_int::opt::deserialize")]
    pub depth: Option<i64>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GetAuditTrailArgs {
    pub entity_type: AuditEntityType,
    pub entity_id: String,
}

#[tool_router(router = graph_router, vis = "pub(crate)")]
impl MemoryService {
    #[tool(
        description = "Connects two memory entities in the graph. Links make get_related able to \
            retrieve connected context later."
    )]
    pub async fn add_link(
        &self,
        Parameters(args): Parameters<AddLinkArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let id = links::add_link(
            &self.db,
            args.from_type.as_str(),
            &args.from_id,
            args.to_type.as_str(),
            &args.to_id,
        )
        .map_err(repo_error)?;
        json_result(&serde_json::json!({ "id": id }))
    }

    #[tool(description = "Returns bidirectional graph relationships and resolved neighbor entities up to depth.")]
    pub async fn get_related(
        &self,
        Parameters(args): Parameters<GetRelatedArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let depth = args.depth.unwrap_or(1);
        let r = links::get_related(&self.db, args.entity_type.as_str(), &args.entity_id, depth)
            .map_err(repo_error)?;
        json_result(&r)
    }

    #[tool(description = "Returns the auditable insert/update/delete history for one entity.")]
    pub async fn get_audit_trail(
        &self,
        Parameters(args): Parameters<GetAuditTrailArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let events = links::get_audit_trail(&self.db, args.entity_type.as_str(), &args.entity_id)
            .map_err(repo_error)?;
        json_result(&events)
    }
}
