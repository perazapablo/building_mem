//! Token-aware context builder and checkpoint. The corona.
//!
//! Mirrors `buildContext`, `itemTokenCount`, `isPinned`,
//! `generateCheckpointContextSummary` and `checkpoint` in `src/db.ts`
//! L2052-2289.
//!
//! Algorithm:
//! 1. Load active candidates from notes / decisions / artifacts / code_entities.
//! 2. Fetch accepted relations touching those IDs to drive conflict
//!    exclusion and graph expansion.
//! 3. Sort by `(pinned DESC, importance DESC, sort_ts DESC)`.
//! 4. Iterate; skip excluded; each accepted item drags its `conflicts_with`
//!    neighbours into `excluded`.
//! 5. Split budget 85/15 (main vs expansion).
//! 6. Fill main bundle by accumulating per-item token cost. Items whose
//!    stored `tokenizer_model` differs from the requested one are recounted
//!    on-the-fly using `serialize::*` + `tokens::count`.
//! 7. Use 15% expansion budget for accepted-related omitted items.

use anyhow::Result;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

use crate::summary::{
    serialize as serialize_summary_value, ContextSummary, SessionSummary,
};
use crate::tokens;

use super::decision_records::Alternative;
use super::relations::get_accepted_relations_for_ids;
use super::serialize::{
    serialize_artifact, serialize_code_entity, serialize_decision, serialize_note,
    ArtifactCtx, CodeEntityCtx, DecisionCtx, NoteCtx,
};
use super::{parse_json_array, projects, sessions, working_state, Db};


const CONTEXT_WRAPPER_TOKEN_MARGIN: i64 = 128;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContextItem {
    Note {
        id: String,
        project_id: String,
        content: String,
        tags: Vec<String>,
        status: String,
        importance: i64,
        obsolete_reason: Option<String>,
        created_at: String,
        updated_at: Option<String>,
        token_count: i64,
        tokenizer_model: String,
        topic_key: Option<String>,
        revision_count: i64,
        sort_ts: String,
    },
    Decision {
        id: String,
        project_id: String,
        decision: String,
        reasoning: String,
        status: String,
        importance: i64,
        obsolete_reason: Option<String>,
        created_at: String,
        updated_at: Option<String>,
        token_count: i64,
        tokenizer_model: String,
        topic_key: Option<String>,
        revision_count: i64,
        sort_ts: String,
    },
    /// Tip activo de una cadena de decision_records (v12). Sin importance
    /// almacenada: se deriva de confidence. Sin token_count almacenado: se
    /// recuenta on-the-fly siempre.
    DecisionRecord {
        id: String,
        project_id: String,
        topic_key: String,
        statement: String,
        forces: Vec<String>,
        alternatives: Vec<Alternative>,
        consequences: Vec<String>,
        origin: String,
        confidence: String,
        status: String,
        created_at: String,
        sort_ts: String,
    },
    Artifact {
        id: String,
        project_id: String,
        artifact_type: String,
        content: String,
        status: String,
        importance: i64,
        obsolete_reason: Option<String>,
        created_at: String,
        updated_at: Option<String>,
        token_count: i64,
        tokenizer_model: String,
        topic_key: Option<String>,
        revision_count: i64,
        sort_ts: String,
    },
    CodeEntity {
        id: String,
        project_id: String,
        kind: String,
        name: String,
        qualified_name: String,
        path: String,
        signature: String,
        summary: String,
        inputs: String,
        outputs: String,
        side_effects: String,
        tags: Vec<String>,
        status: String,
        importance: i64,
        obsolete_reason: Option<String>,
        created_at: String,
        updated_at: Option<String>,
        token_count: i64,
        tokenizer_model: String,
        topic_key: Option<String>,
        revision_count: i64,
        sort_ts: String,
    },
}

impl ContextItem {
    fn id(&self) -> &str {
        match self {
            ContextItem::Note { id, .. }
            | ContextItem::Decision { id, .. }
            | ContextItem::DecisionRecord { id, .. }
            | ContextItem::Artifact { id, .. }
            | ContextItem::CodeEntity { id, .. } => id,
        }
    }

    fn type_str(&self) -> &'static str {
        match self {
            ContextItem::Note { .. } => "note",
            ContextItem::Decision { .. } => "decision",
            ContextItem::DecisionRecord { .. } => "decision_record",
            ContextItem::Artifact { .. } => "artifact",
            ContextItem::CodeEntity { .. } => "code_entity",
        }
    }

    fn importance(&self) -> i64 {
        match self {
            ContextItem::Note { importance, .. }
            | ContextItem::Decision { importance, .. }
            | ContextItem::Artifact { importance, .. }
            | ContextItem::CodeEntity { importance, .. } => *importance,
            // Los tips vienen curados (uno por topic, verdad vigente): una
            // decisión firme rankea sobre la nota default; una provisoria no.
            ContextItem::DecisionRecord { confidence, .. } => {
                if confidence == "decided" {
                    4
                } else {
                    3
                }
            }
        }
    }

    fn sort_ts(&self) -> &str {
        match self {
            ContextItem::Note { sort_ts, .. }
            | ContextItem::Decision { sort_ts, .. }
            | ContextItem::DecisionRecord { sort_ts, .. }
            | ContextItem::Artifact { sort_ts, .. }
            | ContextItem::CodeEntity { sort_ts, .. } => sort_ts,
        }
    }

    fn stored_tokenizer_model(&self) -> &str {
        match self {
            ContextItem::Note { tokenizer_model, .. }
            | ContextItem::Decision { tokenizer_model, .. }
            | ContextItem::Artifact { tokenizer_model, .. }
            | ContextItem::CodeEntity { tokenizer_model, .. } => tokenizer_model,
            // Sin token_count almacenado: fuerza el recuento on-the-fly.
            ContextItem::DecisionRecord { .. } => "",
        }
    }

    fn stored_token_count(&self) -> i64 {
        match self {
            ContextItem::Note { token_count, .. }
            | ContextItem::Decision { token_count, .. }
            | ContextItem::Artifact { token_count, .. }
            | ContextItem::CodeEntity { token_count, .. } => *token_count,
            ContextItem::DecisionRecord { .. } => 0,
        }
    }
}

/// Render compacto de un tip para el conteo de tokens — el mismo texto que
/// el consumidor del contexto va a leer.
fn render_decision_record(
    id: &str,
    topic_key: &str,
    statement: &str,
    forces: &[String],
    alternatives: &[Alternative],
    consequences: &[String],
) -> String {
    let mut out = format!("[decision_record {id}] ({topic_key}) {statement}");
    if !forces.is_empty() {
        out.push_str(&format!("\nforces: {}", forces.join("; ")));
    }
    if !alternatives.is_empty() {
        let alts: Vec<String> = alternatives
            .iter()
            .map(|a| match &a.rejected_because {
                Some(r) => format!("{} — rechazada: {}", a.option, r),
                None => format!("{} — rechazada: (razón no registrada)", a.option),
            })
            .collect();
        out.push_str(&format!("\nalternativas: {}", alts.join("; ")));
    }
    if !consequences.is_empty() {
        out.push_str(&format!("\nconsecuencias: {}", consequences.join("; ")));
    }
    out
}

fn is_pinned(item: &ContextItem, pinned: &HashSet<String>) -> bool {
    pinned.contains(item.id()) || pinned.contains(&format!("{}:{}", item.type_str(), item.id()))
}

fn item_token_count(item: &ContextItem, model: &str) -> i64 {
    if item.stored_tokenizer_model() == model {
        return item.stored_token_count();
    }
    let serialized = match item {
        ContextItem::Note { id, importance, topic_key, revision_count, tags, content, .. } => {
            serialize_note(&NoteCtx {
                id,
                importance: *importance,
                topic_key: topic_key.as_deref(),
                revision_count: *revision_count,
                tags,
                content,
            })
        }
        ContextItem::Decision { id, importance, topic_key, revision_count, decision, reasoning, .. } => {
            serialize_decision(&DecisionCtx {
                id,
                importance: *importance,
                topic_key: topic_key.as_deref(),
                revision_count: *revision_count,
                decision,
                reasoning,
            })
        }
        ContextItem::DecisionRecord {
            id, topic_key, statement, forces, alternatives, consequences, ..
        } => render_decision_record(id, topic_key, statement, forces, alternatives, consequences),
        ContextItem::Artifact { id, importance, topic_key, revision_count, artifact_type, content, .. } => {
            serialize_artifact(&ArtifactCtx {
                id,
                importance: *importance,
                topic_key: topic_key.as_deref(),
                revision_count: *revision_count,
                artifact_type,
                content,
            })
        }
        ContextItem::CodeEntity {
            id, importance, topic_key, revision_count, kind, name, qualified_name, path,
            signature, summary, inputs, outputs, side_effects, tags, ..
        } => serialize_code_entity(&CodeEntityCtx {
            id,
            importance: *importance,
            topic_key: topic_key.as_deref(),
            revision_count: *revision_count,
            kind,
            name,
            qualified_name,
            path,
            signature,
            summary,
            inputs,
            outputs,
            side_effects,
            tags,
        }),
    };
    tokens::count(&serialized, model) as i64
}

#[derive(Debug, Clone, Serialize)]
pub struct BuildContextResponse {
    pub project_id: String,
    pub session_id: Option<String>,
    pub token_budget: i64,
    pub effective_budget: i64,
    pub tokenizer_model: String,
    pub used_tokens: i64,
    pub omitted_count: i64,
    pub conflict_exclusions: i64,
    pub graph_expansions: i64,
    pub items: Vec<ContextItem>,
}

pub fn build_context(
    db: &Db,
    project_id: &str,
    token_budget: i64,
    session_id: Option<&str>,
    tokenizer_model: Option<&str>,
) -> Result<BuildContextResponse> {
    let effective_model = match tokenizer_model {
        Some(m) => tokens::resolve(Some(m)),
        None => tokens::default_model(),
    };
    let effective_budget = (token_budget - CONTEXT_WRAPPER_TOKEN_MARGIN).max(0);

    let pinned = working_state::pinned_ids(db, session_id)?;

    db.with(|conn| {
        let mut all_candidates: Vec<ContextItem> = Vec::new();
        all_candidates.extend(load_notes(conn, project_id)?);
        // v12: las decisiones vigentes son los tips de decision_records; la
        // tabla `decisions` legacy quedó congelada y sus filas activas ya
        // están migradas — cargarla acá duplicaría.
        all_candidates.extend(load_decision_records(conn, project_id)?);
        all_candidates.extend(load_artifacts(conn, project_id)?);
        all_candidates.extend(load_code_entities(conn, project_id)?);

        let all_ids: Vec<String> = all_candidates.iter().map(|c| c.id().to_string()).collect();
        let accepted = if all_ids.is_empty() {
            Vec::new()
        } else {
            get_accepted_relations_for_ids(conn, &all_ids)?
        };

        let mut conflict_map: HashMap<String, HashSet<String>> = HashMap::new();
        for rel in &accepted {
            if rel.relation != "conflicts_with" {
                continue;
            }
            conflict_map
                .entry(rel.source_id.clone())
                .or_default()
                .insert(rel.target_id.clone());
            conflict_map
                .entry(rel.target_id.clone())
                .or_default()
                .insert(rel.source_id.clone());
        }

        all_candidates.sort_by(|a, b| {
            let pin_a = is_pinned(a, &pinned);
            let pin_b = is_pinned(b, &pinned);
            pin_b
                .cmp(&pin_a)
                .then_with(|| b.importance().cmp(&a.importance()))
                .then_with(|| b.sort_ts().cmp(a.sort_ts()))
        });

        let mut excluded: HashSet<String> = HashSet::new();
        let mut bundle: Vec<ContextItem> = Vec::new();
        for item in all_candidates {
            if excluded.contains(item.id()) {
                continue;
            }
            if let Some(conflicts) = conflict_map.get(item.id()) {
                for c in conflicts {
                    excluded.insert(c.clone());
                }
            }
            bundle.push(item);
        }

        let expansion_budget = (effective_budget as f64 * 0.15).floor() as i64;
        let main_budget = effective_budget - expansion_budget;

        let mut items: Vec<ContextItem> = Vec::new();
        let mut omitted: Vec<ContextItem> = Vec::new();
        let mut used_tokens: i64 = 0;

        for item in bundle {
            let tc = item_token_count(&item, effective_model);
            if used_tokens + tc <= main_budget {
                used_tokens += tc;
                items.push(item);
            } else {
                omitted.push(item);
            }
        }

        let in_bundle: HashSet<String> = items.iter().map(|i| i.id().to_string()).collect();
        let mut expansion_related: HashSet<String> = HashSet::new();
        for rel in &accepted {
            if rel.relation == "conflicts_with" {
                continue;
            }
            if in_bundle.contains(&rel.source_id) && !in_bundle.contains(&rel.target_id) {
                expansion_related.insert(rel.target_id.clone());
            }
            if in_bundle.contains(&rel.target_id) && !in_bundle.contains(&rel.source_id) {
                expansion_related.insert(rel.source_id.clone());
            }
        }

        let mut expansion_tokens: i64 = 0;
        let mut graph_expansions: i64 = 0;
        for item in omitted {
            if !expansion_related.contains(item.id()) {
                continue;
            }
            let tc = item_token_count(&item, effective_model);
            if expansion_tokens + tc <= expansion_budget {
                expansion_tokens += tc;
                used_tokens += tc;
                graph_expansions += 1;
                items.push(item);
            }
        }

        let omitted_count = (all_ids.len() as i64) - (items.len() as i64);

        Ok(BuildContextResponse {
            project_id: project_id.to_string(),
            session_id: session_id.map(|s| s.to_string()),
            token_budget,
            effective_budget,
            tokenizer_model: effective_model.to_string(),
            used_tokens,
            omitted_count,
            conflict_exclusions: excluded.len() as i64,
            graph_expansions,
            items,
        })
    })
}

fn load_notes(conn: &Connection, project_id: &str) -> Result<Vec<ContextItem>> {
    let mut stmt = conn.prepare(
        "SELECT id, project_id, content, tags, status, importance, obsolete_reason,
                created_at, updated_at, token_count, tokenizer_model, topic_key, revision_count,
                COALESCE(updated_at, created_at) AS sort_ts
         FROM notes WHERE project_id = ? AND status = 'active'",
    )?;
    let rows: Vec<ContextItem> = stmt
        .query_map(params![project_id], |r| {
            Ok(ContextItem::Note {
                id: r.get(0)?,
                project_id: r.get(1)?,
                content: r.get(2)?,
                tags: parse_json_array(&r.get::<_, String>(3)?),
                status: r.get(4)?,
                importance: r.get(5)?,
                obsolete_reason: r.get(6)?,
                created_at: r.get(7)?,
                updated_at: r.get(8)?,
                token_count: r.get(9)?,
                tokenizer_model: r.get(10)?,
                topic_key: r.get(11)?,
                revision_count: r.get(12)?,
                sort_ts: r.get(13)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

fn load_decision_records(conn: &Connection, project_id: &str) -> Result<Vec<ContextItem>> {
    let mut stmt = conn.prepare(
        "SELECT id, project_id, topic_key, statement, forces_json, alternatives_json,
                consequences_json, origin, confidence, status, created_at
         FROM decision_records WHERE project_id = ? AND status = 'active'",
    )?;
    let rows: Vec<ContextItem> = stmt
        .query_map(params![project_id], |r| {
            let forces_json: String = r.get(4)?;
            let alternatives_json: String = r.get(5)?;
            let consequences_json: String = r.get(6)?;
            let created_at: String = r.get(10)?;
            Ok(ContextItem::DecisionRecord {
                id: r.get(0)?,
                project_id: r.get(1)?,
                topic_key: r.get(2)?,
                statement: r.get(3)?,
                forces: serde_json::from_str(&forces_json).unwrap_or_default(),
                alternatives: serde_json::from_str(&alternatives_json).unwrap_or_default(),
                consequences: serde_json::from_str(&consequences_json).unwrap_or_default(),
                origin: r.get(7)?,
                confidence: r.get(8)?,
                status: r.get(9)?,
                sort_ts: created_at.clone(),
                created_at,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

fn load_artifacts(conn: &Connection, project_id: &str) -> Result<Vec<ContextItem>> {
    let mut stmt = conn.prepare(
        "SELECT id, project_id, type, content, status, importance, obsolete_reason,
                created_at, updated_at, token_count, tokenizer_model, topic_key, revision_count,
                COALESCE(updated_at, created_at) AS sort_ts
         FROM artifacts WHERE project_id = ? AND status = 'active'",
    )?;
    let rows: Vec<ContextItem> = stmt
        .query_map(params![project_id], |r| {
            Ok(ContextItem::Artifact {
                id: r.get(0)?,
                project_id: r.get(1)?,
                artifact_type: r.get(2)?,
                content: r.get(3)?,
                status: r.get(4)?,
                importance: r.get(5)?,
                obsolete_reason: r.get(6)?,
                created_at: r.get(7)?,
                updated_at: r.get(8)?,
                token_count: r.get(9)?,
                tokenizer_model: r.get(10)?,
                topic_key: r.get(11)?,
                revision_count: r.get(12)?,
                sort_ts: r.get(13)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

fn load_code_entities(conn: &Connection, project_id: &str) -> Result<Vec<ContextItem>> {
    let mut stmt = conn.prepare(
        "SELECT id, project_id, kind, name, qualified_name, path, signature, summary,
                inputs, outputs, side_effects, tags, status, importance, obsolete_reason,
                created_at, updated_at, token_count, tokenizer_model, topic_key, revision_count,
                COALESCE(updated_at, created_at) AS sort_ts
         FROM code_entities WHERE project_id = ? AND status = 'active'",
    )?;
    let rows: Vec<ContextItem> = stmt
        .query_map(params![project_id], |r| {
            Ok(ContextItem::CodeEntity {
                id: r.get(0)?,
                project_id: r.get(1)?,
                kind: r.get(2)?,
                name: r.get(3)?,
                qualified_name: r.get(4)?,
                path: r.get(5)?,
                signature: r.get(6)?,
                summary: r.get(7)?,
                inputs: r.get(8)?,
                outputs: r.get(9)?,
                side_effects: r.get(10)?,
                tags: parse_json_array(&r.get::<_, String>(11)?),
                status: r.get(12)?,
                importance: r.get(13)?,
                obsolete_reason: r.get(14)?,
                created_at: r.get(15)?,
                updated_at: r.get(16)?,
                token_count: r.get(17)?,
                tokenizer_model: r.get(18)?,
                topic_key: r.get(19)?,
                revision_count: r.get(20)?,
                sort_ts: r.get(21)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

// ─── checkpoint ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default)]
pub struct CheckpointOptions {
    pub session_summary: Option<SessionSummary>,
    pub context_summary: Option<ContextSummary>,
    pub token_budget: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CheckpointResponse {
    pub session_id: String,
    pub project_id: String,
    pub updated_session: bool,
    pub updated_project_context_summary: bool,
    pub used_generated_context_summary: bool,
    pub context: BuildContextResponse,
}

fn generate_context_summary(
    session_summary: Option<&SessionSummary>,
    working: &Option<working_state::WorkingState>,
    open_threads: &[String],
    previous: Option<&ContextSummary>,
) -> ContextSummary {
    let mut pending: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    let push_unique = |s: &String, pending: &mut Vec<String>, seen: &mut HashSet<String>| {
        if seen.insert(s.clone()) {
            pending.push(s.clone());
        }
    };

    if let Some(s) = session_summary {
        for p in &s.pending {
            push_unique(p, &mut pending, &mut seen);
        }
    }
    for t in open_threads {
        push_unique(t, &mut pending, &mut seen);
    }
    if let Some(p) = previous {
        for w in &p.pending_work {
            push_unique(w, &mut pending, &mut seen);
        }
    }

    let mut notes_parts: Vec<String> = Vec::new();
    if let Some(w) = working {
        if !w.focus.is_empty() {
            notes_parts.push(format!("focus: {}", w.focus));
        }
        if !w.pinned_ids.is_empty() {
            notes_parts.push(format!("pinned: {}", w.pinned_ids.join(",")));
        }
    }
    if let Some(p) = previous {
        if let Some(n) = &p.notes {
            notes_parts.push(n.clone());
        }
    }

    ContextSummary {
        capabilities: previous.map(|p| p.capabilities.clone()).unwrap_or_default(),
        architecture: previous.map(|p| p.architecture.clone()).unwrap_or_default(),
        constraints: previous.map(|p| p.constraints.clone()).unwrap_or_default(),
        pending_work: pending,
        notes: if notes_parts.is_empty() {
            None
        } else {
            Some(notes_parts.join(" | "))
        },
    }
}

pub fn checkpoint(
    db: &Db,
    session_id: &str,
    project_id: &str,
    options: &CheckpointOptions,
) -> Result<CheckpointResponse> {
    let session_before = sessions::get(db, session_id)?;
    let project_before = projects::get(db, project_id)?;
    let token_budget = options.token_budget.unwrap_or(4000);
    let context = build_context(db, project_id, token_budget, Some(session_id), None)?;
    let working = working_state::get(db, session_id)?;
    let open_thread_texts: Vec<String> =
        crate::repo::project_threads::list_by_project(db, project_id, Some("open"))?
            .into_iter()
            .map(|t| t.thread)
            .collect();

    // Server-side stats guarantee: si el caller mandó session_summary sin
    // stats, completamos los mecánicos desde harness/state + git + DB.
    // El modelo nunca tiene que acordarse.
    let mut summary_with_stats: Option<SessionSummary> = options.session_summary.clone();
    if let Some(ref mut s) = summary_with_stats {
        if s.stats.is_none() {
            let derived = db
                .with(|conn| crate::repo::stats_derivation::derive(conn, session_id, project_id))
                .ok();
            s.stats = derived;
        }
    }

    sessions::update_checkpoint(db, session_id, project_id, summary_with_stats.as_ref())?;

    let used_generated = options.context_summary.is_none();
    let context_summary: ContextSummary = match &options.context_summary {
        Some(cs) => cs.clone(),
        None => {
            let session_summary_ref = options
                .session_summary
                .as_ref()
                .or_else(|| session_before.as_ref().and_then(|s| s.summary.as_ref()));
            let previous = project_before
                .as_ref()
                .and_then(|p| p.context_summary.as_ref());
            generate_context_summary(session_summary_ref, &working, &open_thread_texts, previous)
        }
    };
    projects::update_context_summary(db, project_id, &context_summary)?;

    // Avoid unused warning on imported helper while keeping it part of the API.
    let _ = serialize_summary_value(&context_summary);

    Ok(CheckpointResponse {
        session_id: session_id.to_string(),
        project_id: project_id.to_string(),
        updated_session: true,
        updated_project_context_summary: true,
        used_generated_context_summary: used_generated,
        context,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repo::{notes, projects, relations, working_state, Db};

    fn fresh_with_project() -> (Db, String) {
        let db = Db::new_in_memory().unwrap();
        let p = projects::upsert_force(&db, "p1", "", "development", &[]).unwrap();
        (db, p.id)
    }

    #[test]
    fn build_context_empty_project_returns_empty_items() {
        let (db, pid) = fresh_with_project();
        let r = build_context(&db, &pid, 4000, None, None).unwrap();
        assert!(r.items.is_empty());
        assert_eq!(r.used_tokens, 0);
        assert_eq!(r.tokenizer_model, tokens::GENERIC);
    }

    #[test]
    fn build_context_prioritizes_higher_importance() {
        let (db, pid) = fresh_with_project();
        let _low = notes::add(&db, &pid, "low importance content", &[], Some(1), None).unwrap();
        let _high = notes::add(&db, &pid, "high importance content", &[], Some(5), None).unwrap();
        let r = build_context(&db, &pid, 4000, None, None).unwrap();
        assert_eq!(r.items.len(), 2);
        // First item must be the higher-importance one.
        assert_eq!(r.items[0].importance(), 5);
        assert_eq!(r.items[1].importance(), 1);
    }

    #[test]
    fn build_context_excludes_by_conflicts_with() {
        let (db, pid) = fresh_with_project();
        let a = notes::add(&db, &pid, "version A", &[], Some(5), None).unwrap();
        let b = notes::add(&db, &pid, "version B", &[], Some(3), None).unwrap();
        let sid = relations::upsert(
            &db,
            &relations::UpsertRelationParams {
                source_type: "note",
                source_id: &a,
                target_type: "note",
                target_id: &b,
                relation: "conflicts_with",
                reason: "test conflict",
                evidence: "",
                confidence: Some(0.9),
                judgment_status: Some("accepted"),
                marked_by_actor: "test",
                marked_by_kind: Some("auto"),
                marked_by_model: "",
                ..Default::default()
            },
        )
        .unwrap();
        let _ = sid;

        let r = build_context(&db, &pid, 4000, None, None).unwrap();
        assert_eq!(r.items.len(), 1);
        assert_eq!(r.items[0].id(), a);
        assert!(r.conflict_exclusions >= 1);
    }

    #[test]
    fn build_context_pinned_first() {
        let (db, pid) = fresh_with_project();
        let _high = notes::add(&db, &pid, "high importance", &[], Some(5), None).unwrap();
        let pinned_id = notes::add(&db, &pid, "pinned low", &[], Some(1), None).unwrap();
        let _sess = sessions::save(
            &db,
            "s1",
            &SessionSummary::default(),
            None,
        )
        .unwrap();
        let session_id = _sess.clone();
        working_state::set(&db, &session_id, "focus", &[pinned_id.clone()]).unwrap();

        let r = build_context(&db, &pid, 4000, Some(&session_id), None).unwrap();
        assert_eq!(r.items[0].id(), pinned_id);
    }

    #[test]
    fn build_context_tokenizer_model_param_overrides_default() {
        let (db, pid) = fresh_with_project();
        notes::add(&db, &pid, "x", &[], Some(3), None).unwrap();
        let r = build_context(&db, &pid, 4000, None, Some("anthropic:claude")).unwrap();
        assert_eq!(r.tokenizer_model, tokens::ANTHROPIC_CLAUDE);
    }

    fn record_decision(
        db: &Db,
        pid: &str,
        topic: &str,
        statement: &str,
        confidence: &str,
        supersedes: Option<&str>,
    ) -> crate::repo::decision_records::DecisionRecordRow {
        use crate::repo::decision_records::{record, NewDecisionRecord, RecordOutcome};
        match record(
            db,
            NewDecisionRecord {
                project_id: pid,
                topic_key: topic,
                session_id: "s-ctx",
                phase: Some("planning"),
                statement,
                forces: &[],
                alternatives: &[],
                consequences: &[],
                origin: "user_explicit",
                evidence: &[],
                confidence,
                supersedes,
            },
        )
        .unwrap()
        {
            RecordOutcome::Recorded { record, .. } => record,
            RecordOutcome::TipConflict { tip_id, .. } => panic!("tip conflict con {tip_id}"),
        }
    }

    #[test]
    fn build_context_includes_tips_and_omits_superseded() {
        let (db, pid) = fresh_with_project();
        let first = record_decision(&db, &pid, "openpay.scope", "v1: solo charges", "decided", None);
        let tip = record_decision(
            &db, &pid, "openpay.scope", "v2: charges + hosted fallback", "decided", Some(&first.id),
        );

        let r = build_context(&db, &pid, 4000, None, None).unwrap();
        let ids: Vec<&str> = r.items.iter().map(|i| i.id()).collect();
        assert!(ids.contains(&tip.id.as_str()), "el tip activo debe entrar");
        assert!(!ids.contains(&first.id.as_str()), "el superseded no debe entrar");
        assert!(matches!(r.items[0], ContextItem::DecisionRecord { .. }));
    }

    #[test]
    fn decided_tip_ranks_above_default_note_tentative_does_not() {
        let (db, pid) = fresh_with_project();
        notes::add(&db, &pid, "nota default", &[], Some(3), None).unwrap();
        record_decision(&db, &pid, "t.decidida", "decisión firme", "decided", None);
        record_decision(&db, &pid, "t.tentativa", "decisión provisoria", "tentative", None);

        let r = build_context(&db, &pid, 4000, None, None).unwrap();
        assert_eq!(r.items.len(), 3);
        // decided (importancia derivada 4) primero; tentative empata en 3 con la nota.
        assert!(matches!(
            &r.items[0],
            ContextItem::DecisionRecord { confidence, .. } if confidence == "decided"
        ));
        assert_eq!(r.items[0].importance(), 4);
    }

    #[test]
    fn checkpoint_persists_generated_summary_when_missing() {
        let (db, pid) = fresh_with_project();
        let sid = sessions::save(&db, "s1", &SessionSummary::default(), Some(&pid)).unwrap();
        working_state::set(&db, &sid, "now working on X", &[]).unwrap();
        crate::repo::project_threads::open(&db, &pid, "thread1", &sid).unwrap();
        let cp = checkpoint(&db, &sid, &pid, &CheckpointOptions::default()).unwrap();
        assert!(cp.used_generated_context_summary);
        let p = projects::get(&db, &pid).unwrap().unwrap();
        let cs = p.context_summary.unwrap();
        assert!(cs.pending_work.contains(&"thread1".to_string()));
        assert!(cs.notes.as_deref().unwrap().contains("focus: now working on X"));
    }
}
