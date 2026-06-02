//! Canonical JSON serialization of context items.
//!
//! Byte-for-byte equivalent to `serialize{Note,Decision,Artifact,CodeEntity}ForContext`
//! in `src/db.ts` L213-274. This output feeds the tokenizer (`tokenMetadata`)
//! and must match the TS implementation EXACTLY — otherwise the recorded
//! `token_count` will silently disagree with what the JS server stored, and
//! since the recompute trigger is `tokenizer_model != ?`, no self-heal would
//! fire.
//!
//! Key invariants:
//! - keys appear in the exact order they do in TS (needs `serde_json`'s
//!   `preserve_order` feature — enabled in Cargo.toml)
//! - `topic_key` is `null` when None (matches `?? null` in TS)
//! - `revision_count` defaults to 1 when 0 (matches `?? 1` in TS)
//! - `tags` is the parsed array, never the JSON string

use serde_json::{json, Value};

pub struct NoteCtx<'a> {
    pub id: &'a str,
    pub importance: i64,
    pub topic_key: Option<&'a str>,
    pub revision_count: i64,
    pub tags: &'a [String],
    pub content: &'a str,
}

pub struct DecisionCtx<'a> {
    pub id: &'a str,
    pub importance: i64,
    pub topic_key: Option<&'a str>,
    pub revision_count: i64,
    pub decision: &'a str,
    pub reasoning: &'a str,
}

pub struct ArtifactCtx<'a> {
    pub id: &'a str,
    pub importance: i64,
    pub topic_key: Option<&'a str>,
    pub revision_count: i64,
    pub artifact_type: &'a str,
    pub content: &'a str,
}

pub struct CodeEntityCtx<'a> {
    pub id: &'a str,
    pub importance: i64,
    pub topic_key: Option<&'a str>,
    pub revision_count: i64,
    pub kind: &'a str,
    pub name: &'a str,
    pub qualified_name: &'a str,
    pub path: &'a str,
    pub signature: &'a str,
    pub summary: &'a str,
    pub inputs: &'a str,
    pub outputs: &'a str,
    pub side_effects: &'a str,
    pub tags: &'a [String],
}

fn topic_key_value(v: Option<&str>) -> Value {
    match v {
        Some(s) => Value::String(s.to_string()),
        None => Value::Null,
    }
}

fn revision_count_value(n: i64) -> Value {
    if n == 0 { json!(1) } else { json!(n) }
}

pub fn serialize_note(ctx: &NoteCtx<'_>) -> String {
    let value = json!({
        "type": "note",
        "id": ctx.id,
        "importance": ctx.importance,
        "topic_key": topic_key_value(ctx.topic_key),
        "revision_count": revision_count_value(ctx.revision_count),
        "tags": ctx.tags,
        "content": ctx.content,
    });
    serde_json::to_string(&value).expect("serializing note must not fail")
}

pub fn serialize_decision(ctx: &DecisionCtx<'_>) -> String {
    let value = json!({
        "type": "decision",
        "id": ctx.id,
        "importance": ctx.importance,
        "topic_key": topic_key_value(ctx.topic_key),
        "revision_count": revision_count_value(ctx.revision_count),
        "decision": ctx.decision,
        "reasoning": ctx.reasoning,
    });
    serde_json::to_string(&value).expect("serializing decision must not fail")
}

pub fn serialize_artifact(ctx: &ArtifactCtx<'_>) -> String {
    let value = json!({
        "type": "artifact",
        "id": ctx.id,
        "importance": ctx.importance,
        "topic_key": topic_key_value(ctx.topic_key),
        "revision_count": revision_count_value(ctx.revision_count),
        "artifact_type": ctx.artifact_type,
        "content": ctx.content,
    });
    serde_json::to_string(&value).expect("serializing artifact must not fail")
}

pub fn serialize_code_entity(ctx: &CodeEntityCtx<'_>) -> String {
    let value = json!({
        "type": "code_entity",
        "id": ctx.id,
        "importance": ctx.importance,
        "topic_key": topic_key_value(ctx.topic_key),
        "revision_count": revision_count_value(ctx.revision_count),
        "kind": ctx.kind,
        "name": ctx.name,
        "qualified_name": ctx.qualified_name,
        "path": ctx.path,
        "signature": ctx.signature,
        "summary": ctx.summary,
        "inputs": ctx.inputs,
        "outputs": ctx.outputs,
        "side_effects": ctx.side_effects,
        "tags": ctx.tags,
    });
    serde_json::to_string(&value).expect("serializing code_entity must not fail")
}

#[cfg(test)]
mod tests {
    use super::*;

    // The expected strings below are the EXACT output JS `JSON.stringify`
    // produces for the corresponding object literal in db.ts L213-274.
    // Any drift here means token_count divergence vs the JS server — see
    // module docs for why that's catastrophic.

    #[test]
    fn note_serialization_matches_ts_exact_bytes() {
        let tags = vec!["mcp".to_string(), "rust".to_string()];
        let got = serialize_note(&NoteCtx {
            id: "n1",
            importance: 3,
            topic_key: Some("topic-x"),
            revision_count: 2,
            tags: &tags,
            content: "hola",
        });
        let expected = r#"{"type":"note","id":"n1","importance":3,"topic_key":"topic-x","revision_count":2,"tags":["mcp","rust"],"content":"hola"}"#;
        assert_eq!(got, expected);
    }

    #[test]
    fn note_null_topic_and_default_revision() {
        let got = serialize_note(&NoteCtx {
            id: "n2",
            importance: 1,
            topic_key: None,
            revision_count: 0,
            tags: &[],
            content: "",
        });
        let expected = r#"{"type":"note","id":"n2","importance":1,"topic_key":null,"revision_count":1,"tags":[],"content":""}"#;
        assert_eq!(got, expected);
    }

    #[test]
    fn decision_serialization_matches_ts() {
        let got = serialize_decision(&DecisionCtx {
            id: "d1",
            importance: 4,
            topic_key: Some("k"),
            revision_count: 3,
            decision: "use rust",
            reasoning: "binding hell",
        });
        let expected = r#"{"type":"decision","id":"d1","importance":4,"topic_key":"k","revision_count":3,"decision":"use rust","reasoning":"binding hell"}"#;
        assert_eq!(got, expected);
    }

    #[test]
    fn artifact_serialization_matches_ts() {
        let got = serialize_artifact(&ArtifactCtx {
            id: "a1",
            importance: 5,
            topic_key: None,
            revision_count: 1,
            artifact_type: "schema",
            content: "{...}",
        });
        let expected = r#"{"type":"artifact","id":"a1","importance":5,"topic_key":null,"revision_count":1,"artifact_type":"schema","content":"{...}"}"#;
        assert_eq!(got, expected);
    }

    #[test]
    fn code_entity_serialization_matches_ts() {
        let tags = vec!["repo".to_string()];
        let got = serialize_code_entity(&CodeEntityCtx {
            id: "c1",
            importance: 3,
            topic_key: Some("billing-xml-parseinvoicexml"),
            revision_count: 1,
            kind: "function",
            name: "parseInvoiceXml",
            qualified_name: "billing.xml.parseInvoiceXml",
            path: "src/billing/xml.rs",
            signature: "fn parse(input: &str) -> Result<Invoice>",
            summary: "parses XML invoices",
            inputs: "xml string",
            outputs: "Invoice",
            side_effects: "none",
            tags: &tags,
        });
        let expected = r#"{"type":"code_entity","id":"c1","importance":3,"topic_key":"billing-xml-parseinvoicexml","revision_count":1,"kind":"function","name":"parseInvoiceXml","qualified_name":"billing.xml.parseInvoiceXml","path":"src/billing/xml.rs","signature":"fn parse(input: &str) -> Result<Invoice>","summary":"parses XML invoices","inputs":"xml string","outputs":"Invoice","side_effects":"none","tags":["repo"]}"#;
        assert_eq!(got, expected);
    }
}
