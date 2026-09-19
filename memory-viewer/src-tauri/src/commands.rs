//! Comandos de lectura sobre la base de memoria.
//!
//! Todo el trabajo real vive en el crate `mcp_memory`; acá sólo se traduce
//! entre la IPC de Tauri y `repo::`. Nada muta la base.

use mcp_memory::repo::{
    artifacts, dashboard, decision_records, notes, project_paths, project_threads, projects,
    relations, session_bundle, session_focus, sessions,
};
use serde_json::Value;
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
pub fn list_projects(state: State<'_, DbState>) -> Result<Value, String> {
    let rows = projects::list_all(state.lock().db()).map_err(err)?;
    serde_json::to_value(rows).map_err(err)
}

#[tauri::command]
pub fn get_project(state: State<'_, DbState>, id: String) -> Result<Value, String> {
    let row = projects::get(state.lock().db(), &id).map_err(err)?;
    serde_json::to_value(row).map_err(err)
}

#[tauri::command]
pub fn list_sessions(
    state: State<'_, DbState>,
    project_id: String,
    limit: Option<i64>,
) -> Result<Value, String> {
    let rows =
        sessions::list_index(state.lock().db(), &project_id, limit.unwrap_or(50)).map_err(err)?;
    serde_json::to_value(rows).map_err(err)
}

#[tauri::command]
pub fn get_session(state: State<'_, DbState>, session_id: String) -> Result<Value, String> {
    let row = sessions::get(state.lock().db(), &session_id).map_err(err)?;
    serde_json::to_value(row).map_err(err)
}

/// El grafo entero del proyecto en una sola llamada: son cientos de aristas,
/// no miles, así que paginarlo sólo complicaría el layout de fuerzas.
#[tauri::command]
pub fn get_project_graph(state: State<'_, DbState>, project_id: String) -> Result<Value, String> {
    let graph = relations::graph_for_project(state.lock().db(), &project_id).map_err(err)?;
    serde_json::to_value(graph).map_err(err)
}

/// Los números de la portada del proyecto, en una sola llamada.
#[tauri::command]
pub fn get_dashboard(state: State<'_, DbState>, project_id: String) -> Result<Value, String> {
    let d = dashboard::for_project(state.lock().db(), &project_id).map_err(err)?;
    serde_json::to_value(d).map_err(err)
}

/// Todo lo que dejó una sesión: decisiones, hilos, notas, artefactos y el
/// recorrido de focus, en una sola llamada al desplegarla.
#[tauri::command]
pub fn get_session_bundle(state: State<'_, DbState>, session_id: String) -> Result<Value, String> {
    let b = session_bundle::for_session(state.lock().db(), &session_id).map_err(err)?;
    serde_json::to_value(b).map_err(err)
}

/// Marca de quién vino un hilo abierto o cerrado desde acá. La columna espera
/// un `session_id`, y el viewer no tiene sesión: mentir con una inventada sería
/// peor que decir la verdad.
const ACTOR_VIEWER: &str = "viewer";

/// Carve-out de escritura: el viewer es de lectura salvo lo que Pablo pide
/// explícitamente desde la UI. Abrir un hilo es uno de esos casos.
#[tauri::command]
pub fn open_thread(
    state: State<'_, DbState>,
    project_id: String,
    thread: String,
) -> Result<Value, String> {
    let row = project_threads::open(state.lock().db(), &project_id, &thread, ACTOR_VIEWER)
        .map_err(err)?;
    serde_json::to_value(row).map_err(err)
}

/// Carve-out de escritura. `status` es 'done' o 'dropped': terminado y
/// descartado no son lo mismo, y el repo rechaza cualquier otra cosa.
#[tauri::command]
pub fn close_thread(
    state: State<'_, DbState>,
    thread_id: String,
    status: String,
    reason: Option<String>,
) -> Result<Value, String> {
    let razon = reason.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let row = project_threads::close(state.lock().db(), &thread_id, &status, razon, ACTOR_VIEWER)
        .map_err(err)?;
    serde_json::to_value(row).map_err(err)
}

#[tauri::command]
pub fn list_paths(state: State<'_, DbState>, project_id: String) -> Result<Value, String> {
    let rows = project_paths::list_for_project(state.lock().db(), &project_id).map_err(err)?;
    serde_json::to_value(rows).map_err(err)
}

#[tauri::command]
pub fn list_notes(state: State<'_, DbState>, project_id: String) -> Result<Value, String> {
    let rows = notes::list_all(state.lock().db(), Some(&project_id)).map_err(err)?;
    serde_json::to_value(rows).map_err(err)
}

#[tauri::command]
pub fn list_artifacts(state: State<'_, DbState>, project_id: String) -> Result<Value, String> {
    let rows = artifacts::list_all(state.lock().db(), Some(&project_id)).map_err(err)?;
    serde_json::to_value(rows).map_err(err)
}

#[tauri::command]
pub fn list_decision_tips(state: State<'_, DbState>, project_id: String) -> Result<Value, String> {
    let rows = decision_records::list_tips(state.lock().db(), &project_id).map_err(err)?;
    serde_json::to_value(rows).map_err(err)
}

#[tauri::command]
pub fn list_threads(
    state: State<'_, DbState>,
    project_id: String,
    status: Option<String>,
) -> Result<Value, String> {
    let rows = project_threads::list_by_project(state.lock().db(), &project_id, status.as_deref())
        .map_err(err)?;
    serde_json::to_value(rows).map_err(err)
}

/// El recorrido de la sesión: cada focus que declaró, en orden. La fila de
/// `session_focus` sólo guarda el último.
#[tauri::command]
pub fn get_focus_history(state: State<'_, DbState>, session_id: String) -> Result<Value, String> {
    let rows = session_focus::history(state.lock().db(), &session_id).map_err(err)?;
    serde_json::to_value(rows).map_err(err)
}

#[tauri::command]
pub fn get_session_focus(state: State<'_, DbState>, session_id: String) -> Result<Value, String> {
    let row = session_focus::get(state.lock().db(), &session_id).map_err(err)?;
    serde_json::to_value(row).map_err(err)
}
