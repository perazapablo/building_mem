//! Harness-facing tools. Reads per-session state files written by the
//! client-side hooks (Claude Code, opencode, ...) and returns enriched
//! snapshots the model can embed into `SessionSummary.stats`.
//!
//! Contract with the hook side (mcp-learning/harness/stats.cjs):
//!   - State dir: env MCP_HARNESS_STATE_DIR
//!     default: dirname($MCP_MEMORY_DB_PATH)/harness/state
//!     fallback: C:/Users/Desarrollos/.config/mcp-learning/harness/state
//!   - One file per session: `<sanitized session_id>.json`
//!   - Shape written by the hook (see stats.cjs emptyState):
//!       { session_id, project_id, started_at, last_update_at,
//!         turns, commits, files_edited[], bash_effects, memory_writes,
//!         code_entities_touched, tool_errors }
//!
//! This tool computes:
//!   - duration_min  = (now - started_at) rounded
//!   - files_edited  = length of files_edited[]
//!   - last_focus    = latest session_focus row for project_id (if any)

use std::{env, fs, path::PathBuf, time::{SystemTime, UNIX_EPOCH}};

use rmcp::{
    handler::server::wrapper::Parameters, model::CallToolResult, schemars, tool, tool_router,
    ErrorData,
};
use serde::{Deserialize, Serialize};

use crate::repo::session_focus;

use super::{json_result, repo_error, MemoryService};

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GetSessionStatsArgs {
    pub session_id: String,
    /// Optional override. If omitted, the tool uses the project_id stored
    /// in the state file at SessionStart.
    #[serde(default)]
    pub project_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawState {
    session_id: String,
    #[serde(default)]
    project_id: Option<String>,
    started_at: String,
    #[serde(default)]
    started_at_ms: Option<i64>,
    #[serde(default)]
    last_update_at: Option<String>,
    #[serde(default)]
    turns: i64,
    #[serde(default)]
    commits: i64,
    #[serde(default)]
    files_edited: Vec<String>,
    #[serde(default)]
    bash_effects: i64,
    #[serde(default)]
    memory_writes: i64,
    #[serde(default)]
    code_entities_touched: i64,
    #[serde(default)]
    tool_errors: i64,
}

#[derive(Debug, Serialize)]
struct LastFocus {
    session_id: String,
    focus: String,
    set_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize)]
struct SessionStatsSnapshot {
    session_id: String,
    project_id: Option<String>,
    started_at: String,
    last_update_at: Option<String>,
    duration_min: Option<i64>,
    turns: i64,
    commits: i64,
    files_edited: usize,
    files_edited_paths: Vec<String>,
    bash_effects: i64,
    memory_writes: i64,
    code_entities_touched: i64,
    tool_errors: i64,
    last_focus: Option<LastFocus>,
}

fn state_dir() -> PathBuf {
    if let Ok(v) = env::var("MCP_HARNESS_STATE_DIR") {
        return PathBuf::from(v);
    }
    if let Ok(db) = env::var("MCP_MEMORY_DB_PATH") {
        let p = PathBuf::from(db);
        if let Some(parent) = p.parent() {
            return parent.join("harness").join("state");
        }
    }
    PathBuf::from("C:/Users/Desarrollos/.config/mcp-learning/harness/state")
}

fn sanitize(session_id: &str) -> String {
    session_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '_' })
        .collect()
}

fn duration_min(started_at_ms: Option<i64>) -> Option<i64> {
    let start_ms = started_at_ms?;
    let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_millis() as i64;
    Some((now_ms - start_ms + 30_000) / 60_000)
}

#[tool_router(router = harness_router, vis = "pub(crate)")]
impl MemoryService {
    #[tool(
        description = "Returns a mechanical SessionStats snapshot for the given \
            session_id: turns, commits, files_edited, bash_effects, memory_writes, \
            code_entities_touched, tool_errors, duration_min, last_focus. Data is \
            aggregated client-side by the harness hooks (Claude Code / opencode) \
            and read here without any modelling judgement. Call this right before \
            checkpoint and embed the result in SessionSummary.stats."
    )]
    pub async fn get_session_stats(
        &self,
        Parameters(args): Parameters<GetSessionStatsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let path = state_dir().join(format!("{}.json", sanitize(&args.session_id)));
        if !path.exists() {
            return json_result(&serde_json::json!({
                "session_id": args.session_id,
                "error": "no state file for this session_id — hooks did not initialize it",
                "state_dir": state_dir().display().to_string(),
            }));
        }

        let raw = fs::read_to_string(&path)
            .map_err(|e| ErrorData::internal_error(format!("read state: {}", e), None))?;
        let state: RawState = serde_json::from_str(&raw)
            .map_err(|e| ErrorData::internal_error(format!("parse state: {}", e), None))?;

        let project_id = args.project_id.or(state.project_id.clone());
        let last_focus = if let Some(pid) = project_id.as_ref() {
            session_focus::get_latest_for_project(&self.db, pid)
                .map_err(repo_error)?
                .map(|row| LastFocus {
                    session_id: row.session_id,
                    focus: row.focus,
                    set_at: row.set_at,
                    updated_at: row.updated_at,
                })
        } else {
            None
        };

        let snapshot = SessionStatsSnapshot {
            session_id: state.session_id.clone(),
            project_id,
            duration_min: duration_min(state.started_at_ms),
            started_at: state.started_at,
            last_update_at: state.last_update_at,
            turns: state.turns,
            commits: state.commits,
            files_edited: state.files_edited.len(),
            files_edited_paths: state.files_edited,
            bash_effects: state.bash_effects,
            memory_writes: state.memory_writes,
            code_entities_touched: state.code_entities_touched,
            tool_errors: state.tool_errors,
            last_focus,
        };
        json_result(&snapshot)
    }
}
