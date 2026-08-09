mod commands;
mod state;

use state::{default_db_path, DbState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let db_state = DbState::new(default_db_path()).expect("failed to open memory db");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(db_state)
        .invoke_handler(tauri::generate_handler![
            commands::get_db_path,
            commands::open_db,
            commands::get_table_counts,
            commands::list_projects,
            commands::get_project,
            commands::delete_project,
            commands::merge_project,
            commands::list_sessions,
            commands::get_session,
            commands::get_working_state,
            commands::list_working_states,
            commands::list_notes,
            commands::list_decisions,
            commands::list_artifacts,
            commands::list_code_entities,
            commands::list_links,
            commands::list_relations,
            commands::list_events,
            commands::get_audit_trail,
            commands::get_relations_for_entity,
            commands::search_all,
            commands::get_project_context,
            commands::build_context,
            commands::get_pending_judgments,
            commands::get_code_entity,
            commands::search_code_entities,
            commands::get_code_entity_context,
            commands::search_notes,
            commands::get_related,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
