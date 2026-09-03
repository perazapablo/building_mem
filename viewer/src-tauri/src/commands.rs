use mcp_memory::repo::{
    artifacts, code_entities, decisions, events, links, notes, project_paths, project_threads,
    projects, relations, session_focus, sessions, working_state,
};
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use tauri::State;

use crate::state::DbState;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[tauri::command]
pub fn get_db_path(state: State<'_, DbState>) -> String {
    state.lock().path_str()
}

#[tauri::command]
pub fn open_db(state: State<'_, DbState>, path: String) -> Result<String, String> {
    state.open(PathBuf::from(&path)).map_err(err)?;
    Ok(state.lock().path_str())
}

#[derive(Serialize)]
pub struct TableCounts {
    pub projects: i64,
    pub sessions: i64,
    pub notes: i64,
    pub decisions: i64,
    pub artifacts: i64,
    pub code_entities: i64,
    pub links: i64,
    pub memory_relations: i64,
    pub working_state: i64,
    pub events: i64,
}

#[tauri::command]
pub fn get_table_counts(state: State<'_, DbState>) -> Result<TableCounts, String> {
    let guard = state.lock();
    let counts = mcp_memory::repo::counts::table_counts(guard.db()).map_err(err)?;
    Ok(TableCounts {
        projects: counts.projects,
        sessions: counts.sessions,
        notes: counts.notes,
        decisions: counts.decisions,
        artifacts: counts.artifacts,
        code_entities: counts.code_entities,
        links: counts.links,
        memory_relations: counts.memory_relations,
        working_state: counts.working_state,
        events: counts.events,
    })
}

#[tauri::command]
pub fn list_projects(state: State<'_, DbState>) -> Result<Value, String> {
    let rows = projects::list_all(state.lock().db()).map_err(err)?;
    serde_json::to_value(rows).map_err(err)
}

#[tauri::command]
pub fn get_project(state: State<'_, DbState>, id: String) -> Result<Value, String> {
    let p = projects::get(state.lock().db(), &id).map_err(err)?;
    serde_json::to_value(p).map_err(err)
}

#[tauri::command]
pub fn delete_project(state: State<'_, DbState>, id: String) -> Result<Value, String> {
    let counts = projects::delete_project_cascade(state.lock().db(), &id).map_err(err)?;
    serde_json::to_value(counts).map_err(err)
}

#[tauri::command]
pub fn merge_project(
    state: State<'_, DbState>,
    source_id: String,
    target_id: String,
) -> Result<Value, String> {
    let counts =
        projects::merge_project_into(state.lock().db(), &source_id, &target_id).map_err(err)?;
    serde_json::to_value(counts).map_err(err)
}

#[tauri::command]
pub fn list_sessions(state: State<'_, DbState>, project_id: Option<String>) -> Result<Value, String> {
    let rows = sessions::list_all(state.lock().db(), project_id.as_deref()).map_err(err)?;
    serde_json::to_value(rows).map_err(err)
}

#[tauri::command]
pub fn get_session(state: State<'_, DbState>, id: String) -> Result<Value, String> {
    let row = sessions::get(state.lock().db(), &id).map_err(err)?;
    serde_json::to_value(row).map_err(err)
}

#[tauri::command]
pub fn get_working_state(state: State<'_, DbState>, session_id: String) -> Result<Value, String> {
    let row = working_state::get(state.lock().db(), &session_id).map_err(err)?;
    serde_json::to_value(row).map_err(err)
}

#[tauri::command]
pub fn list_working_states(state: State<'_, DbState>) -> Result<Value, String> {
    let rows = working_state::list_all(state.lock().db()).map_err(err)?;
    serde_json::to_value(rows).map_err(err)
}

#[tauri::command]
pub fn list_notes(state: State<'_, DbState>, project_id: Option<String>) -> Result<Value, String> {
    let rows = notes::list_all(state.lock().db(), project_id.as_deref()).map_err(err)?;
    serde_json::to_value(rows).map_err(err)
}

#[tauri::command]
pub fn list_decisions(state: State<'_, DbState>, project_id: Option<String>) -> Result<Value, String> {
    let rows = decisions::list_all(state.lock().db(), project_id.as_deref()).map_err(err)?;
    serde_json::to_value(rows).map_err(err)
}

#[tauri::command]
pub fn list_artifacts(state: State<'_, DbState>, project_id: Option<String>) -> Result<Value, String> {
    let rows = artifacts::list_all(state.lock().db(), project_id.as_deref()).map_err(err)?;
    serde_json::to_value(rows).map_err(err)
}

#[tauri::command]
pub fn list_code_entities(state: State<'_, DbState>, project_id: Option<String>) -> Result<Value, String> {
    let rows = code_entities::list_all(state.lock().db(), project_id.as_deref()).map_err(err)?;
    serde_json::to_value(rows).map_err(err)
}

#[tauri::command]
pub fn list_links(state: State<'_, DbState>) -> Result<Value, String> {
    let rows = links::list_all(state.lock().db()).map_err(err)?;
    serde_json::to_value(rows).map_err(err)
}

#[tauri::command]
pub fn list_relations(state: State<'_, DbState>, limit: Option<i64>) -> Result<Value, String> {
    let rows = relations::list_all(state.lock().db(), limit.unwrap_or(500)).map_err(err)?;
    serde_json::to_value(rows).map_err(err)
}

#[tauri::command]
pub fn list_events(
    state: State<'_, DbState>,
    entity_type: Option<String>,
    entity_id: Option<String>,
    limit: Option<i64>,
) -> Result<Value, String> {
    let rows = events::list_all(
        state.lock().db(),
        entity_type.as_deref(),
        entity_id.as_deref(),
        limit.unwrap_or(500),
    )
    .map_err(err)?;
    serde_json::to_value(rows).map_err(err)
}

#[tauri::command]
pub fn get_audit_trail(
    state: State<'_, DbState>,
    entity_type: String,
    entity_id: String,
) -> Result<Value, String> {
    let rows = links::get_audit_trail(state.lock().db(), &entity_type, &entity_id).map_err(err)?;
    serde_json::to_value(rows).map_err(err)
}

#[tauri::command]
pub fn get_relations_for_entity(
    state: State<'_, DbState>,
    entity_type: String,
    entity_id: String,
) -> Result<Value, String> {
    let filters = relations::RelationFilters {
        limit: Some(200),
        ..Default::default()
    };
    let rows = relations::get_for_entity(state.lock().db(), &entity_type, &entity_id, &filters)
        .map_err(err)?;
    serde_json::to_value(rows).map_err(err)
}

#[tauri::command]
pub fn get_project_context(
    state: State<'_, DbState>,
    project_id: String,
    limit: Option<i64>,
    include_obsolete: Option<bool>,
) -> Result<Value, String> {
    let ctx = mcp_memory::repo::projects::get_project_context(
        state.lock().db(),
        &project_id,
        limit.unwrap_or(50),
        include_obsolete.unwrap_or(false),
    )
    .map_err(err)?;
    serde_json::to_value(ctx).map_err(err)
}

#[tauri::command]
pub fn build_context(
    state: State<'_, DbState>,
    project_id: String,
    token_budget: i64,
    session_id: Option<String>,
    tokenizer_model: Option<String>,
) -> Result<Value, String> {
    let res = mcp_memory::repo::context::build_context(
        state.lock().db(),
        &project_id,
        token_budget,
        session_id.as_deref(),
        tokenizer_model.as_deref(),
    )
    .map_err(err)?;
    serde_json::to_value(res).map_err(err)
}

#[tauri::command]
pub fn get_pending_judgments(
    state: State<'_, DbState>,
    project_id: Option<String>,
    limit: Option<i64>,
) -> Result<Value, String> {
    let rows = relations::get_pending_judgments(
        state.lock().db(),
        project_id.as_deref(),
        limit.unwrap_or(200),
    )
    .map_err(err)?;
    serde_json::to_value(rows).map_err(err)
}

#[tauri::command]
pub fn get_code_entity(state: State<'_, DbState>, id: String) -> Result<Value, String> {
    let row = code_entities::get(state.lock().db(), &id).map_err(err)?;
    serde_json::to_value(row).map_err(err)
}

#[tauri::command]
pub fn get_note(state: State<'_, DbState>, id: String) -> Result<Value, String> {
    let row = notes::get(state.lock().db(), &id).map_err(err)?;
    serde_json::to_value(row).map_err(err)
}

#[tauri::command]
pub fn get_decision(state: State<'_, DbState>, id: String) -> Result<Value, String> {
    let row = decisions::get(state.lock().db(), &id).map_err(err)?;
    serde_json::to_value(row).map_err(err)
}

#[tauri::command]
pub fn get_artifact(state: State<'_, DbState>, id: String) -> Result<Value, String> {
    let row = artifacts::get(state.lock().db(), &id).map_err(err)?;
    serde_json::to_value(row).map_err(err)
}

#[tauri::command]
pub fn search_code_entities(
    state: State<'_, DbState>,
    query: String,
    project_id: Option<String>,
    limit: Option<i64>,
) -> Result<Value, String> {
    let rows = code_entities::search(
        state.lock().db(),
        &query,
        project_id.as_deref(),
        limit.unwrap_or(50),
        false,
    )
    .map_err(err)?;
    serde_json::to_value(rows).map_err(err)
}

#[tauri::command]
pub fn get_code_entity_context(
    state: State<'_, DbState>,
    project_id: String,
    query: String,
    limit: Option<i64>,
) -> Result<Value, String> {
    let res = code_entities::get_context(
        state.lock().db(),
        &project_id,
        &query,
        limit.unwrap_or(20),
    )
    .map_err(err)?;
    serde_json::to_value(res).map_err(err)
}

#[tauri::command]
pub fn search_notes(
    state: State<'_, DbState>,
    query: String,
    project_id: Option<String>,
    limit: Option<i64>,
) -> Result<Value, String> {
    let rows = notes::search(
        state.lock().db(),
        &query,
        project_id.as_deref(),
        limit.unwrap_or(50),
        false,
    )
    .map_err(err)?;
    serde_json::to_value(rows).map_err(err)
}

#[tauri::command]
pub fn get_related(
    state: State<'_, DbState>,
    entity_type: String,
    entity_id: String,
    depth: Option<i64>,
) -> Result<Value, String> {
    let res = links::get_related(
        state.lock().db(),
        &entity_type,
        &entity_id,
        depth.unwrap_or(1),
    )
    .map_err(err)?;
    serde_json::to_value(res).map_err(err)
}

#[tauri::command]
pub fn search_all(
    state: State<'_, DbState>,
    query: String,
    project_id: String,
    limit: Option<i64>,
) -> Result<Value, String> {
    let res = mcp_memory::repo::search::search_all(
        state.lock().db(),
        &query,
        &project_id,
        limit.unwrap_or(50),
        false,
    )
    .map_err(err)?;
    serde_json::to_value(res).map_err(err)
}

// ─── session_focus ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_focus(state: State<'_, DbState>, session_id: String) -> Result<Value, String> {
    let row = session_focus::get(state.lock().db(), &session_id).map_err(err)?;
    serde_json::to_value(row).map_err(err)
}

#[tauri::command]
pub fn get_latest_focus_for_project(
    state: State<'_, DbState>,
    project_id: String,
) -> Result<Value, String> {
    let row = session_focus::get_latest_for_project(state.lock().db(), &project_id).map_err(err)?;
    serde_json::to_value(row).map_err(err)
}

// ─── project_paths ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn list_project_paths(
    state: State<'_, DbState>,
    project_id: String,
) -> Result<Value, String> {
    let rows = project_paths::list_for_project(state.lock().db(), &project_id).map_err(err)?;
    serde_json::to_value(rows).map_err(err)
}

// ─── project_threads (R/W) ─────────────────────────────────────────────────

#[tauri::command]
pub fn list_project_threads(
    state: State<'_, DbState>,
    project_id: String,
    status: Option<String>,
) -> Result<Value, String> {
    let rows = project_threads::list_by_project(
        state.lock().db(),
        &project_id,
        status.as_deref(),
    )
    .map_err(err)?;
    serde_json::to_value(rows).map_err(err)
}

#[tauri::command]
pub fn open_thread(
    state: State<'_, DbState>,
    project_id: String,
    thread: String,
    session_id: String,
) -> Result<Value, String> {
    let row = project_threads::open(state.lock().db(), &project_id, &thread, &session_id)
        .map_err(err)?;
    serde_json::to_value(row).map_err(err)
}

#[tauri::command]
pub fn close_thread(
    state: State<'_, DbState>,
    thread_id: String,
    status: String,
    reason: Option<String>,
    session_id: String,
) -> Result<Value, String> {
    let row = project_threads::close(
        state.lock().db(),
        &thread_id,
        &status,
        reason.as_deref(),
        &session_id,
    )
    .map_err(err)?;
    serde_json::to_value(row).map_err(err)
}

#[tauri::command]
pub fn touch_thread(state: State<'_, DbState>, thread_id: String) -> Result<bool, String> {
    project_threads::touch(state.lock().db(), &thread_id).map_err(err)
}

#[tauri::command]
pub fn mark_stale_threads(
    state: State<'_, DbState>,
    project_id: String,
    days: i64,
) -> Result<usize, String> {
    project_threads::mark_stale_older_than(state.lock().db(), &project_id, days).map_err(err)
}

// ─── judge relation ────────────────────────────────────────────────────────

#[tauri::command]
pub fn judge_relation(
    state: State<'_, DbState>,
    sync_id: String,
    status: String,
) -> Result<(), String> {
    // Actor triple: the viewer is a human tool. `marked_by_model` empty.
    relations::judge(
        state.lock().db(),
        &sync_id,
        &status,
        "viewer",
        "human",
        "",
    )
    .map_err(err)
}
