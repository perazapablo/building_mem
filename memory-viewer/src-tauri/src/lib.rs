mod commands;
mod state;

#[cfg(debug_assertions)]
use tauri::Manager;

use state::{default_db_path, DbState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let db = DbState::new(default_db_path()).expect("no se pudo abrir la base de memoria");

    tauri::Builder::default()
        .manage(db)
        .setup(|app| {
            #[cfg(debug_assertions)]
            if let Some(w) = app.get_webview_window("main") {
                w.open_devtools();
            }
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_db_path,
            commands::list_projects,
            commands::get_project,
            commands::list_sessions,
            commands::get_session,
            commands::list_decision_tips,
            commands::get_dashboard,
            commands::list_notes,
            commands::list_artifacts,
            commands::get_project_graph,
            commands::list_threads,
            commands::get_session_focus,
            commands::get_focus_history,
            commands::get_session_bundle,
            commands::list_paths,
            commands::open_thread,
            commands::close_thread,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
