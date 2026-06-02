//! Structured session and project context summaries.
//!
//! Mirrors `src/summary.ts`. Persisted as JSON in TEXT columns
//! (`sessions.summary`, `projects.context_summary`). Legacy free-form
//! strings already in the DB are read as `{ notes: <raw> }`.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
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
