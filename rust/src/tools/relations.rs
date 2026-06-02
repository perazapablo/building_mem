//! Relation tools. Mirrors `src/tools/relations.ts`.

use rmcp::{
    handler::server::wrapper::Parameters,
    model::CallToolResult,
    schemars, tool, tool_router, ErrorData,
};
use serde::Deserialize;

use crate::repo::relations::{self, RelationFilters, UpsertRelationParams};

use super::mutations::EntityType;
use super::{json_result, repo_error, MemoryService};

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RelationType {
    Implements,
    DependsOn,
    ConflictsWith,
    Replaces,
    References,
    StructuralSibling,
    TopicallyRelated,
    VariantOf,
    SemanticallyRelated,
}

impl RelationType {
    fn as_str(&self) -> &'static str {
        match self {
            RelationType::Implements => "implements",
            RelationType::DependsOn => "depends_on",
            RelationType::ConflictsWith => "conflicts_with",
            RelationType::Replaces => "replaces",
            RelationType::References => "references",
            RelationType::StructuralSibling => "structural_sibling",
            RelationType::TopicallyRelated => "topically_related",
            RelationType::VariantOf => "variant_of",
            RelationType::SemanticallyRelated => "semantically_related",
        }
    }
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum JudgmentStatus {
    Pending,
    Accepted,
    Rejected,
}

impl JudgmentStatus {
    fn as_str(&self) -> &'static str {
        match self {
            JudgmentStatus::Pending => "pending",
            JudgmentStatus::Accepted => "accepted",
            JudgmentStatus::Rejected => "rejected",
        }
    }
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum JudgeStatus {
    Accepted,
    Rejected,
}

impl JudgeStatus {
    fn as_str(&self) -> &'static str {
        match self {
            JudgeStatus::Accepted => "accepted",
            JudgeStatus::Rejected => "rejected",
        }
    }
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct AddRelationArgs {
    pub source_type: EntityType,
    pub source_id: String,
    pub target_type: EntityType,
    pub target_id: String,
    pub relation: RelationType,
    pub reason: String,
    #[serde(default)]
    pub evidence: Option<String>,
    /// Confidence from 0.0 to 1.0 (default: 0.5).
    #[serde(default)]
    pub confidence: Option<f64>,
    #[serde(default)]
    pub judgment_status: Option<JudgmentStatus>,
    #[serde(default)]
    pub session_id: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct JudgeRelationArgs {
    pub sync_id: String,
    pub judgment_status: JudgeStatus,
    #[serde(default)]
    pub marked_by_actor: Option<String>,
    #[serde(default)]
    pub marked_by_model: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GetRelationsArgs {
    pub entity_type: EntityType,
    pub entity_id: String,
    #[serde(default)]
    pub judgment_status: Option<JudgmentStatus>,
    #[serde(default)]
    pub relation: Option<RelationType>,
    /// Maximum results (default: 50).
    #[serde(default)]
    pub limit: Option<i64>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GetPendingJudgmentsArgs {
    #[serde(default)]
    pub project_id: Option<String>,
    /// Maximum results (default: 20).
    #[serde(default)]
    pub limit: Option<i64>,
}

#[tool_router(router = relations_router, vis = "pub(crate)")]
impl MemoryService {
    #[tool(
        description = "Creates or updates a typed relation between two memory entities. \
            For manually detected relations you are confident about, set judgment_status to 'accepted'."
    )]
    pub async fn add_relation(
        &self,
        Parameters(args): Parameters<AddRelationArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let evidence = args.evidence.unwrap_or_default();
        let sync_id = relations::upsert(
            &self.db,
            &UpsertRelationParams {
                source_type: args.source_type.as_str(),
                source_id: &args.source_id,
                target_type: args.target_type.as_str(),
                target_id: &args.target_id,
                relation: args.relation.as_str(),
                reason: &args.reason,
                evidence: &evidence,
                confidence: args.confidence,
                judgment_status: args.judgment_status.as_ref().map(|j| j.as_str()),
                marked_by_actor: "agent",
                marked_by_kind: Some("llm"),
                marked_by_model: "",
                session_id: args.session_id.as_deref(),
                ..Default::default()
            },
        )
        .map_err(repo_error)?;
        json_result(&serde_json::json!({ "sync_id": sync_id }))
    }

    #[tool(description = "Accepts or rejects a pending relation.")]
    pub async fn judge_relation(
        &self,
        Parameters(args): Parameters<JudgeRelationArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let actor = args.marked_by_actor.unwrap_or_default();
        let model = args.marked_by_model.unwrap_or_default();
        relations::judge(&self.db, &args.sync_id, args.judgment_status.as_str(), &actor, "human", &model)
            .map_err(repo_error)?;
        json_result(&serde_json::json!({ "ok": true }))
    }

    #[tool(description = "Returns all relations for a given entity, with optional filters.")]
    pub async fn get_relations(
        &self,
        Parameters(args): Parameters<GetRelationsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let rels = relations::get_for_entity(
            &self.db,
            args.entity_type.as_str(),
            &args.entity_id,
            &RelationFilters {
                judgment_status: args.judgment_status.as_ref().map(|j| j.as_str()),
                relation: args.relation.as_ref().map(|r| r.as_str()),
                limit: args.limit,
            },
        )
        .map_err(repo_error)?;
        json_result(&rels)
    }

    #[tool(description = "Lists pending relations that need review, ordered by confidence descending.")]
    pub async fn get_pending_judgments(
        &self,
        Parameters(args): Parameters<GetPendingJudgmentsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let limit = args.limit.unwrap_or(20);
        let rows = relations::get_pending_judgments(&self.db, args.project_id.as_deref(), limit)
            .map_err(repo_error)?;
        json_result(&rows)
    }
}
