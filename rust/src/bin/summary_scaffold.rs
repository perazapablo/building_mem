//! Build a SessionSummary scaffold for the current or given session.
//!
//! Junta las partes mecánicas: decisions/artifacts creados en la ventana de
//! la sesión, threads cerrados en la sesión, open threads del proyecto,
//! stats desde harness/state + git + DB. `stats` viene del módulo
//! compartido `repo::stats_derivation` — misma lógica que usa `checkpoint`
//! server-side, un solo lugar de verdad.
//!
//! Emite:
//!   - `session_summary`: shape para checkpoint. goal/outcome/blockers/notes
//!     vacíos — el modelo los rellena.
//!   - `_hints`: contexto extra (thread ids, snippets de notes, focus).
//!
//! Uso:
//!     summary-scaffold [--session <id>] [--state-dir <path>] [--db <path>]

use anyhow::{anyhow, bail, Context, Result};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use mcp_memory::db;
use mcp_memory::repo::stats_derivation;
use mcp_memory::summary::SessionSummary;

#[derive(Debug, Serialize)]
struct Scaffold {
    session_id: String,
    project_id: String,
    session_summary: SessionSummary,
    #[serde(rename = "_hints")]
    hints: Hints,
}

#[derive(Debug, Default, Serialize)]
struct Hints {
    session_focus: Option<String>,
    created_notes: Vec<Snippet>,
    open_threads: Vec<ThreadHint>,
    started_at: String,
    state_file: String,
}

#[derive(Debug, Serialize)]
struct Snippet {
    id: String,
    snippet: String,
}

#[derive(Debug, Serialize)]
struct ThreadHint {
    id: String,
    thread: String,
}

fn parse_args() -> Result<(Option<String>, PathBuf, PathBuf)> {
    let mut session: Option<String> = None;
    let mut state_dir: Option<PathBuf> = None;
    let mut db_path: Option<PathBuf> = None;
    let mut it = env::args().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--session" | "-s" => session = it.next(),
            "--state-dir" => state_dir = it.next().map(PathBuf::from),  
            "--db" => db_path = it.next().map(PathBuf::from),
            "--help" | "-h" => {
                eprintln!(
                    "usage: summary-scaffold [--session <id>] [--state-dir <path>] [--db <path>]"
                );
                std::process::exit(0);
            }
            other => bail!("arg desconocido: {other}"),
        }
    }
    let state_dir = state_dir.unwrap_or_else(stats_derivation::resolve_state_dir);
    let db_path = db_path
        .or_else(|| env::var("MCP_MEMORY_DB_PATH").ok().map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("memory.db"));
    Ok((session, state_dir, db_path))
}

fn find_latest_state(state_dir: &Path) -> Result<PathBuf> {
    let mut candidates: Vec<(PathBuf, SystemTime)> = fs::read_dir(state_dir)
        .with_context(|| format!("read state dir {}", state_dir.display()))?
        .flatten()
        .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("json"))
        .filter(|e| e.file_name().to_string_lossy() != "test-dry-run.json")
        .filter_map(|e| {
            e.metadata()
                .and_then(|m| m.modified())
                .ok()
                .map(|m| (e.path(), m))
        })
        .collect();
    candidates.sort_by_key(|(_, m)| std::cmp::Reverse(*m));
    candidates
        .into_iter()
        .next()
        .map(|(p, _)| p)
        .ok_or_else(|| anyhow!("no state files in {}", state_dir.display()))
}

fn iso_to_sqlite_utc(iso: &str) -> String {
    let s = iso.replace('T', " ");
    let s = s.trim_end_matches('Z');
    s.split('.').next().unwrap_or(s).to_string()
}

fn main() -> Result<()> {
    let (session_arg, state_dir, db_path) = parse_args()?;

    let state_path = match &session_arg {
        Some(sid) => state_dir.join(format!("{sid}.json")),
        None => find_latest_state(&state_dir)?,
    };
    let state_raw = fs::read_to_string(&state_path)
        .with_context(|| format!("read state {}", state_path.display()))?;
    let state: Value = serde_json::from_str(&state_raw)?;

    let session_id = state
        .get("session_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("state missing session_id"))?
        .to_string();
    let project_id = state
        .get("project_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("state missing project_id"))?
        .to_string();
    let started_at = state
        .get("started_at")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("state missing started_at"))?
        .to_string();

    let sql_ts = iso_to_sqlite_utc(&started_at);
    let conn = db::open(&db_path)?;

    // Ensure derive() picks up the same state dir even if invoked with
    // --state-dir override.
    env::set_var("MCP_HARNESS_STATE_DIR", &state_dir);

    let mut stmt = conn.prepare(
        "SELECT id FROM decisions WHERE project_id = ? AND created_at >= ? ORDER BY created_at ASC limit 100",
    )?;
    let decisions_ref: Vec<String> = stmt
        .query_map(params![project_id, sql_ts], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<_>>()?;

    let mut stmt = conn.prepare(
        "SELECT id FROM artifacts WHERE project_id = ? AND created_at >= ? ORDER BY created_at ASC limit 100",
    )?;
    let artifacts_ref: Vec<String> = stmt
        .query_map(params![project_id, sql_ts], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<_>>()?;

    let mut stmt = conn.prepare(
        "SELECT id, substr(content, 1, 100) FROM notes WHERE project_id = ? AND created_at >= ? ORDER BY created_at ASC",
    )?;
    let created_notes: Vec<Snippet> = stmt
        .query_map(params![project_id, sql_ts], |r| {
            Ok(Snippet {
                id: r.get(0)?,
                snippet: r.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;

    let mut stmt = conn.prepare("SELECT id FROM project_threads WHERE closed_in = ?")?;
    let threads_closed: Vec<String> = stmt
        .query_map(params![session_id], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<_>>()?;

    let mut stmt = conn.prepare(
        "SELECT id, thread FROM project_threads WHERE project_id = ? AND status = 'open' ORDER BY updated_at DESC",
    )?;
    let open_threads: Vec<ThreadHint> = stmt
        .query_map(params![project_id], |r| {
            Ok(ThreadHint {
                id: r.get(0)?,
                thread: r.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;

    let session_focus_val: Option<String> = conn
        .query_row(
            "SELECT focus FROM session_focus WHERE session_id = ?",
            params![session_id],
            |r| r.get::<_, String>(0),
        )
        .optional()?;

    let stats = stats_derivation::derive(&conn, &session_id, &project_id)?;
    let pending: Vec<String> = open_threads.iter().map(|t| t.thread.clone()).collect();

    let session_summary = SessionSummary {
        goal: String::new(),
        outcome: String::new(),
        decisions_ref,
        artifacts_ref,
        pending,
        blockers: Vec::new(),
        threads_closed,
        stats: Some(stats),
        notes: None,
    };

    let hints = Hints {
        session_focus: session_focus_val,
        created_notes,
        open_threads,
        started_at,
        state_file: state_path.display().to_string(),
    };

    let scaffold = Scaffold {
        session_id,
        project_id,
        session_summary,
        hints,
    };
    println!("{}", serde_json::to_string_pretty(&scaffold)?);
    Ok(())
}
