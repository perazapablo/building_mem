//! Deriva `SessionStats` mecánicos desde harness/state + git + DB.
//!
//! Fuente única de verdad para las tres capas que necesitan armar stats:
//!   - `context::checkpoint` cuando el modelo llama sin stats
//!   - binario `summary-scaffold` (consulta manual)
//!   - `harness/session-end.cjs` (mantiene su propia impl en Node por ser
//!     hook y disparar independiente del server)
//!
//! El módulo es best-effort: si el state file no existe o git no está en el
//! PATH, devuelve un `SessionStats` con lo que sí pudo derivar (posiblemente
//! todo en cero). Nunca falla.

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::summary::{FileEdit, SessionStats};

#[derive(Debug, Deserialize)]
struct RawState {
    #[serde(default)]
    turns: i64,
    #[serde(default)]
    tool_errors: i64,
    #[serde(default)]
    files_edited: Vec<String>,
    #[serde(default)]
    started_at: Option<String>,
    #[serde(default)]
    started_at_ms: Option<i64>,
}

/// Resuelve el state dir en este orden:
///   1. `MCP_HARNESS_STATE_DIR` env
///   2. `<parent(MCP_MEMORY_DB_PATH)>/harness/state`
///   3. `harness/state` relativo a CWD
pub fn resolve_state_dir() -> PathBuf {
    if let Ok(p) = env::var("MCP_HARNESS_STATE_DIR") {
        return PathBuf::from(p);
    }
    if let Ok(db) = env::var("MCP_MEMORY_DB_PATH") {
        if let Some(parent) = Path::new(&db).parent() {
            return parent.join("harness").join("state");
        }
    }
    PathBuf::from("harness/state")
}

fn load_state(session_id: &str, state_dir: &Path) -> Option<RawState> {
    let path = state_dir.join(format!("{session_id}.json"));
    let raw = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// ISO "2026-08-13T16:22:26.085Z" → SQLite UTC "2026-08-13 16:22:26"
fn iso_to_sqlite_utc(iso: &str) -> String {
    let s = iso.replace('T', " ");
    let s = s.trim_end_matches('Z');
    s.split('.').next().unwrap_or(s).to_string()
}

fn git_commits_since(iso: &str) -> Vec<String> {
    Command::new("git")
        .args(["log", "--since", iso, "--format=%H"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .map(String::from)
                .collect()
        })
        .unwrap_or_default()
}

fn session_focus(conn: &Connection, session_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT focus FROM session_focus WHERE session_id = ?",
        params![session_id],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
}

/// Best-effort derivation. Nunca falla — devuelve `SessionStats::default()`
/// si no hay state file (queda todo en cero) y aún así lookea git/focus.
pub fn derive(conn: &Connection, session_id: &str, _project_id: &str) -> Result<SessionStats> {
    let state_dir = resolve_state_dir();
    let state = load_state(session_id, &state_dir);

    let started_at_iso = state.as_ref().and_then(|s| s.started_at.clone());
    let started_at_ms = state.as_ref().and_then(|s| s.started_at_ms);

    let duration_min = started_at_ms
        .and_then(|ms| {
            let now_ms = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .ok()?
                .as_millis() as i64;
            Some((now_ms - ms) / 60_000)
        })
        .unwrap_or(0);

    let turns = state.as_ref().map(|s| s.turns).unwrap_or(0);
    let tool_errors = state.as_ref().map(|s| s.tool_errors).unwrap_or(0);
    let files_edited: Vec<FileEdit> = state
        .as_ref()
        .map(|s| {
            s.files_edited
                .iter()
                .map(|p| FileEdit {
                    path: p.clone(),
                    edits: 1,
                })
                .collect()
        })
        .unwrap_or_default();

    let commits = started_at_iso
        .as_deref()
        .map(git_commits_since)
        .unwrap_or_default();

    let last_focus = session_focus(conn, session_id).unwrap_or_default();

    // sql_ts left for callers that want to query decisions/artifacts in
    // the session window; not part of SessionStats itself.
    let _sql_ts = started_at_iso.as_deref().map(iso_to_sqlite_utc);

    Ok(SessionStats {
        duration_min,
        turns,
        commits,
        files_edited,
        bash_effects: Vec::new(),
        memory_writes: BTreeMap::new(),
        code_entities_touched: Vec::new(),
        tool_errors,
        last_focus,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repo::{projects, Db};
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn unique_temp_dir(tag: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = env::temp_dir().join(format!("mcp_stats_deriv_{tag}_{ts}_{n}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn derive_without_state_file_returns_defaults_but_no_error() {
        let db = Db::new_in_memory().unwrap();
        let p = projects::upsert_force(&db, "p1", "", "development", &[]).unwrap();
        let dir = unique_temp_dir("empty");
        env::set_var("MCP_HARNESS_STATE_DIR", &dir);
        let s = db.with(|c| derive(c, "no-such-session", &p.id)).unwrap();
        assert_eq!(s.turns, 0);
        assert_eq!(s.duration_min, 0);
        assert!(s.files_edited.is_empty());
        env::remove_var("MCP_HARNESS_STATE_DIR");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn derive_reads_state_file() {
        let db = Db::new_in_memory().unwrap();
        let p = projects::upsert_force(&db, "p1", "", "development", &[]).unwrap();
        let dir = unique_temp_dir("read");
        let sid = "test-session-xyz";
        let state = serde_json::json!({
            "session_id": sid,
            "project_id": p.id,
            "started_at": "2026-08-13T00:00:00.000Z",
            "started_at_ms": 1_000_000_000_000_i64,
            "turns": 42,
            "tool_errors": 3,
            "files_edited": ["/tmp/a.rs", "/tmp/b.rs"],
        });
        fs::write(dir.join(format!("{sid}.json")), state.to_string()).unwrap();
        env::set_var("MCP_HARNESS_STATE_DIR", &dir);
        let s = db.with(|c| derive(c, sid, &p.id)).unwrap();
        assert_eq!(s.turns, 42);
        assert_eq!(s.tool_errors, 3);
        assert_eq!(s.files_edited.len(), 2);
        assert!(s.duration_min > 0);
        env::remove_var("MCP_HARNESS_STATE_DIR");
        let _ = fs::remove_dir_all(&dir);
    }
}
