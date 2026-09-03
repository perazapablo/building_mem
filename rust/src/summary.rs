//! Structured session and project context summaries.
//!
//! Mirrors `src/summary.ts`. Persisted as JSON in TEXT columns
//! (`sessions.summary`, `projects.context_summary`). Legacy free-form
//! strings already in the DB are read as `{ notes: <raw> }`.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SessionSummary {
    #[serde(default)]
    pub goal: String,
    #[serde(default)]
    pub outcome: String,
    #[serde(default)]
    pub decisions_ref: Vec<String>,
    #[serde(default)]
    pub artifacts_ref: Vec<String>,
    #[serde(default)]
    pub pending: Vec<String>,
    #[serde(default)]
    pub blockers: Vec<String>,
    /// Project thread ids closed during this session.
    #[serde(default)]
    pub threads_closed: Vec<String>,
    /// Mechanical event-log stats collected by the harness. Never authored
    /// by the model — always derived from tool call / hook telemetry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stats: Option<SessionStats>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct SessionStats {
    /// Wall-clock session duration in minutes (start → end).
    #[serde(default)]
    pub duration_min: i64,
    /// Number of model turns (user + assistant pairs).
    #[serde(default)]
    pub turns: i64,
    /// Git commit hashes created inside the session window.
    #[serde(default)]
    pub commits: Vec<String>,
    /// Files edited (Write/Edit) with edit count per path.
    #[serde(default)]
    pub files_edited: Vec<FileEdit>,
    /// Bash commands with side effects and their exit codes.
    #[serde(default)]
    pub bash_effects: Vec<BashEffect>,
    /// Count of memory-writing MCP tool calls, keyed by tool name.
    #[serde(default)]
    pub memory_writes: BTreeMap<String, i64>,
    /// Ids of code_entities read or updated during the session.
    #[serde(default)]
    pub code_entities_touched: Vec<String>,
    /// Count of tool call errors seen (any tool, any kind).
    #[serde(default)]
    pub tool_errors: i64,
    /// Last `set_focus` value seen inside this session, if any.
    #[serde(default)]
    pub last_focus: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct FileEdit {
    pub path: String,
    pub edits: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct BashEffect {
    pub cmd: String,
    pub exit: i32,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
pub struct ContextSummary {
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub architecture: String,
    #[serde(default)]
    pub constraints: Vec<String>,
    #[serde(default)]
    pub pending_work: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

pub fn serialize<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string())
}

pub fn parse_session_summary(raw: Option<&str>) -> Option<SessionSummary> {
    let raw = raw?;
    if raw.is_empty() {
        return None;
    }
    if let Ok(parsed) = serde_json::from_str::<SessionSummary>(raw) {
        return Some(parsed);
    }
    Some(SessionSummary {
        notes: Some(raw.to_string()),
        ..Default::default()
    })
}

pub fn parse_context_summary(raw: Option<&str>) -> Option<ContextSummary> {
    let raw = raw?;
    if raw.is_empty() {
        return None;
    }
    if let Ok(parsed) = serde_json::from_str::<ContextSummary>(raw) {
        return Some(parsed);
    }
    Some(ContextSummary {
        notes: Some(raw.to_string()),
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_none_and_empty() {
        assert!(parse_session_summary(None).is_none());
        assert!(parse_session_summary(Some("")).is_none());
        assert!(parse_context_summary(None).is_none());
        assert!(parse_context_summary(Some("")).is_none());
    }

    #[test]
    fn parse_valid_json_roundtrips() {
        let original = SessionSummary {
            goal: "ship".into(),
            outcome: "shipped".into(),
            decisions_ref: vec!["d1".into()],
            artifacts_ref: vec!["a1".into()],
            pending: vec!["follow-up".into()],
            blockers: vec![],
            threads_closed: vec![],
            stats: None,
            notes: Some("nuance".into()),
        };
        let json = serialize(&original);
        let parsed = parse_session_summary(Some(&json)).unwrap();
        assert_eq!(original, parsed);
    }

    #[test]
    fn parse_legacy_string_wraps_in_notes() {
        let legacy = "Old free-form session summary";
        let parsed = parse_session_summary(Some(legacy)).unwrap();
        assert_eq!(parsed.notes.as_deref(), Some(legacy));
        assert!(parsed.goal.is_empty());
        assert!(parsed.decisions_ref.is_empty());
    }

    #[test]
    fn parse_partial_json_uses_defaults() {
        let partial = r#"{"goal":"ship"}"#;
        let parsed = parse_session_summary(Some(partial)).unwrap();
        assert_eq!(parsed.goal, "ship");
        assert!(parsed.pending.is_empty());
    }

    #[test]
    fn context_summary_roundtrip() {
        let original = ContextSummary {
            capabilities: vec!["mcp-server".into()],
            architecture: "rust + sqlite".into(),
            constraints: vec!["single-process".into()],
            pending_work: vec!["port repo".into()],
            notes: None,
        };
        let json = serialize(&original);
        let parsed = parse_context_summary(Some(&json)).unwrap();
        assert_eq!(original, parsed);
    }
}
