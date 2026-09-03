//! Decision-record tools: append-only ADR chains.
//!
//! Three tools, deliberately narrow: `decision_record` (insert / supersede),
//! `decision_revert`, `context_for_topic`. There is no update and no delete —
//! a tool that does not exist cannot be misused. Immutability and the
//! one-active-tip-per-chain invariant live in the DB (triggers + partial
//! unique index), not in protocol prose.

use rmcp::{
    handler::server::wrapper::Parameters,
    model::CallToolResult,
    schemars, tool, tool_router, ErrorData,
};
use serde::Deserialize;

use crate::repo::decision_records::{
    self, Alternative, Evidence, NewDecisionRecord, RecordOutcome,
};
use crate::sanitize::strip_tool_call_tags;

use super::{json_result, repo_error, MemoryService};

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Origin {
    /// The user stated the decision (or its rationale) in so many words.
    UserExplicit,
    /// Derived from something the user said, but not stated verbatim.
    UserImplicit,
    /// The agent inferred it. The honest default when unsure.
    AgentInferred,
}

impl Origin {
    fn as_str(&self) -> &'static str {
        match self {
            Origin::UserExplicit => "user_explicit",
            Origin::UserImplicit => "user_implicit",
            Origin::AgentInferred => "agent_inferred",
        }
    }
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Confidence {
    Decided,
    Tentative,
}

impl Confidence {
    fn as_str(&self) -> &'static str {
        match self {
            Confidence::Decided => "decided",
            Confidence::Tentative => "tentative",
        }
    }
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Exploration,
    Planning,
    Implementation,
}

impl Phase {
    fn as_str(&self) -> &'static str {
        match self {
            Phase::Exploration => "exploration",
            Phase::Planning => "planning",
            Phase::Implementation => "implementation",
        }
    }
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceKind {
    /// Repo path, optionally with line: "rust/src/repo/decisions.rs:42".
    Path,
    /// Git commit SHA.
    Commit,
    /// Id of another memory entry (note/artifact/decision_record/thread).
    MemoryRef,
    /// Verbatim text copied from the conversation. Copied text, not a pointer.
    Quote,
}

impl EvidenceKind {
    fn as_str(&self) -> &'static str {
        match self {
            EvidenceKind::Path => "path",
            EvidenceKind::Commit => "commit",
            EvidenceKind::MemoryRef => "memory_ref",
            EvidenceKind::Quote => "quote",
        }
    }
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct AlternativeArg {
    /// The option that was considered.
    pub option: String,
    /// Why it was rejected. NULL when the reason is genuinely unknown —
    /// NEVER fabricate one to fill the field. A null here is a signal that
    /// the question is still open.
    #[serde(default)]
    pub rejected_because: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct EvidenceArg {
    pub kind: EvidenceKind,
    pub value: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct DecisionRecordArgs {
    pub project_id: String,
    /// Stable chain key, e.g. "openpay.db-schema". Identifies the CHAIN of
    /// records for one topic, not a single row.
    pub topic_key: String,
    /// Session recording this decision (from harness context).
    pub session_id: String,
    /// One imperative sentence: WHAT was decided.
    pub statement: String,
    /// Constraints in force AT THE MOMENT of deciding (business, technical,
    /// data). Snapshot, not standing truth.
    #[serde(default)]
    pub forces: Vec<String>,
    /// Real options considered, each with why it was rejected (or null).
    #[serde(default)]
    pub alternatives: Vec<AlternativeArg>,
    /// What this decision obliges or forecloses going forward.
    #[serde(default)]
    pub consequences: Vec<String>,
    /// Provenance of the rationale. REQUIRED, no default: user_explicit /
    /// user_implicit must be actively affirmed; when unsure, agent_inferred.
    pub origin: Origin,
    /// Verifiable pointers (path/commit/memory_ref) or verbatim quotes.
    #[serde(default)]
    pub evidence: Vec<EvidenceArg>,
    /// decided = the call was made; tentative = provisional, to unblock work.
    pub confidence: Confidence,
    /// Workflow phase when decided. Omit if unknown.
    #[serde(default)]
    pub phase: Option<Phase>,
    /// Id of the current active tip of this chain, when consciously replacing
    /// it. If a tip exists and this is absent (or wrong), the call FAILS and
    /// returns the tip — read what you are replacing, then retry with its id.
    #[serde(default)]
    pub supersedes: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct DecisionRevertArgs {
    /// Id of the active decision_record being reverted.
    pub id: String,
    /// Why it was reverted. Required — a revert without a why is the same
    /// fabrication hole this system exists to close.
    pub reason: String,
    /// Session performing the revert.
    pub session_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ContextForTopicArgs {
    pub project_id: String,
    /// Chain key to load.
    pub topic_key: String,
    /// Max records to return, tip-first (default: full chain).
    #[serde(default, deserialize_with = "super::flex_int::opt::deserialize")]
    pub depth: Option<i64>,
}

fn strip_vec(items: &[String]) -> Vec<String> {
    items.iter().map(|s| strip_tool_call_tags(s)).collect()
}

#[tool_router(router = decision_records_router, vis = "pub(crate)")]
impl MemoryService {
    #[tool(
        description = "Records a decision as an immutable record in an append-only chain \
            (ADR captured in the moment). topic_key identifies the chain; one active tip per \
            chain. If an active tip exists you MUST pass supersedes=<tip_id> — otherwise the \
            call fails and returns the tip so you read what you are replacing. Record at the \
            moment of deciding, not at session close. NEVER invent a rejected_because: pass \
            null and leave the question open. origin is required and must be honest: \
            agent_inferred when you are not sure the user affirmed it."
    )]
    pub async fn decision_record(
        &self,
        Parameters(args): Parameters<DecisionRecordArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let statement = strip_tool_call_tags(&args.statement);
        let forces = strip_vec(&args.forces);
        let consequences = strip_vec(&args.consequences);
        let alternatives: Vec<Alternative> = args
            .alternatives
            .iter()
            .map(|a| Alternative {
                option: strip_tool_call_tags(&a.option),
                rejected_because: a.rejected_because.as_deref().map(strip_tool_call_tags),
            })
            .collect();
        let evidence: Vec<Evidence> = args
            .evidence
            .iter()
            .map(|e| Evidence {
                kind: e.kind.as_str().to_string(),
                value: strip_tool_call_tags(&e.value),
            })
            .collect();

        let outcome = decision_records::record(
            &self.db,
            NewDecisionRecord {
                project_id: &args.project_id,
                topic_key: &args.topic_key,
                session_id: &args.session_id,
                phase: args.phase.as_ref().map(Phase::as_str),
                statement: &statement,
                forces: &forces,
                alternatives: &alternatives,
                consequences: &consequences,
                origin: args.origin.as_str(),
                evidence: &evidence,
                confidence: args.confidence.as_str(),
                supersedes: args.supersedes.as_deref(),
            },
        )
        .map_err(repo_error)?;

        match outcome {
            RecordOutcome::Recorded { record, superseded } => {
                json_result(&serde_json::json!({ "record": record, "superseded": superseded }))
            }
            RecordOutcome::TipConflict { tip_id, tip_statement, tip_created_at } => {
                Err(ErrorData::invalid_params(
                    format!(
                        "chain '{}' already has an active tip. Read it, then retry with \
                         supersedes=\"{}\" if you really mean to replace it. \
                         Tip: [{}] \"{}\" (created {})",
                        args.topic_key, tip_id, tip_id, tip_statement, tip_created_at
                    ),
                    None,
                ))
            }
        }
    }

    #[tool(
        description = "Reverts an active decision_record: the decision was undone without a \
            replacement. Requires a reason. For replacing with a new decision, use \
            decision_record with supersedes instead. Closed records are frozen."
    )]
    pub async fn decision_revert(
        &self,
        Parameters(args): Parameters<DecisionRevertArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let reason = strip_tool_call_tags(&args.reason);
        if reason.trim().is_empty() {
            return Err(ErrorData::invalid_params(
                "reason must be non-empty".to_string(),
                None,
            ));
        }
        let row = decision_records::revert(&self.db, &args.id, &reason, &args.session_id)
            .map_err(repo_error)?;
        json_result(&row)
    }

    #[tool(
        description = "Returns the decision chain for a topic, tip-first (active record, then \
            each superseded predecessor via supersedes). Use when resuming work on a topic to \
            load what is currently decided and how it got there. depth limits how far back."
    )]
    pub async fn context_for_topic(
        &self,
        Parameters(args): Parameters<ContextForTopicArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let rows = decision_records::chain(
            &self.db,
            &args.project_id,
            &args.topic_key,
            args.depth,
        )
        .map_err(repo_error)?;
        json_result(&serde_json::json!({
            "project_id": args.project_id,
            "topic_key": args.topic_key,
            "chain": rows,
        }))
    }
}
