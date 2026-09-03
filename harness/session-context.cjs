// Session-start context core. Agnostic to client.
//
// Given a cwd (+ optional session_id) resolves the project scope, loads the
// durable project context from the DB, drains any `missed-checkpoint` markers
// left by session-end, and returns a plain-text block ready to be injected as
// system/additional context by whatever adapter calls it.
//
// Programmatic:
//   const { buildSessionContext } = require('.../session-context.cjs');
//   const { text, resolved } = buildSessionContext({ cwd, session_id });
//
// Contract:
//   buildSessionContext({ cwd, session_id?, drain? }) ->
//     { text: string, resolved: <resolveCwd result> }
//
//   `drain` defaults to true: markers are listed AND deleted, so the warning
//   is shown exactly once. Pass drain:false to peek without consuming.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { resolveCwd } = require('./mapper.cjs');
const { initState } = require('./stats.cjs');
const { hasNarrative } = require('./session-end.cjs');

const DB_PATH = process.env.MCP_MEMORY_DB_PATH
  || 'C:/Users/Desarrollos/.config/mcp-learning/memory.db';
const STATE_DIR = process.env.MCP_HARNESS_STATE_DIR
  || path.join(__dirname, 'state');

function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n).trimEnd() + '…' : s;
}

function loadProjectContext(project_id) {
  const out = { context_summary: '', last_sessions: [], open_threads: [] };
  let db;
  try {
    db = new DatabaseSync(DB_PATH, { readOnly: true });
    const proj = db.prepare('SELECT context_summary FROM projects WHERE id = ?').get(project_id);
    if (proj && proj.context_summary) out.context_summary = proj.context_summary;
    out.last_sessions = db.prepare(
      `SELECT id, title, summary, updated_at FROM sessions
        WHERE project_id = ? ORDER BY updated_at DESC LIMIT 3`
    ).all(project_id);
    out.open_threads = db.prepare(
      `SELECT id, thread, updated_at FROM project_threads
        WHERE project_id = ? AND status = 'open'
        ORDER BY updated_at DESC LIMIT 8`
    ).all(project_id);
  } catch { /* silent */ }
  finally { try { db && db.close(); } catch {} }
  return out;
}

function fmtProjectContext(ctx) {
  const parts = [];
  if (ctx.context_summary) {
    parts.push(`[harness] project context_summary:\n${truncate(ctx.context_summary, 1200)}`);
  }
  if (ctx.last_sessions.length) {
    const lines = ctx.last_sessions.map((s) =>
      `  - ${s.updated_at} ${String(s.id).slice(0, 8)} — ${truncate(s.title, 120)}`
    ).join('\n');
    parts.push(`[harness] last sessions:\n${lines}`);
  }
  if (ctx.open_threads.length) {
    const lines = ctx.open_threads.map((t) =>
      `  - ${String(t.id).slice(0, 8)} — ${truncate(t.thread, 180)}`
    ).join('\n');
    parts.push(`[harness] open threads (${ctx.open_threads.length}):\n${lines}`);
  }
  return parts.join('\n\n');
}

function fmtScope(r) {
  if (r.matched) {
    return `[harness] project scope resolved for this CWD:\n` +
      `  project_id:   ${r.project_id}\n` +
      `  project_name: ${r.project_name}\n` +
      `  cwd:          ${r.cwd}\n` +
      `Use this project_id for all mcp__memory__* calls this session. ` +
      `Do not call list_projects/upsert_project unless the user asks about a different project.`;
  }
  return `[harness] WARNING: ${r.message}\n` +
    `  cwd:      ${r.cwd}\n` +
    `  path_key: ${r.path_key}\n` +
    `Before writing any memory this session, resolve the project mapping.`;
}

// True when the session row already carries a real (model-written) narrative.
// Used to retire stale markers: clients like opencode run the mechanical
// auto-save on every idle, so a marker can be written mid-session and then
// superseded by a proper checkpoint before the session actually ends.
function sessionHasNarrative(session_id) {
  let db;
  try {
    db = new DatabaseSync(DB_PATH, { readOnly: true });
    const row = db.prepare('SELECT summary FROM sessions WHERE id = ?').get(session_id);
    if (!row) return false;
    const s = row.summary;
    if (!s) return false;
    try {
      const parsed = JSON.parse(s);
      // Un summary auto-guardado lleva la marca en notes; no cuenta como narrativa.
      if (typeof parsed.notes === 'string' && parsed.notes.includes('auto-saved en SessionEnd')) {
        return false;
      }
    } catch { /* fall through to hasNarrative */ }
    return hasNarrative(s);
  } catch {
    return false;
  } finally { try { db && db.close(); } catch {} }
}

// Markers written by session-end when the model never called checkpoint.
// Lists, formats and (by default) removes them so the warning fires once.
function drainMissedCheckpoints(drain = true) {
  let entries = [];
  try {
    entries = fs.readdirSync(STATE_DIR).filter((n) => n.endsWith('.missed-checkpoint'));
  } catch { return ''; }
  if (!entries.length) return '';

  const lines = [];
  for (const name of entries) {
    const full = path.join(STATE_DIR, name);
    try {
      const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
      const sid = raw.session_id || name.replace('.missed-checkpoint', '');
      if (sessionHasNarrative(sid)) {
        // El modelo terminó cerrando la sesión: el marker quedó obsoleto.
        if (drain) { try { fs.unlinkSync(full); } catch {} }
        continue;
      }
      const outcome = (raw.summary && raw.summary.outcome) || '(sin outcome)';
      lines.push(`  - ${String(sid).slice(0, 8)} @ ${raw.auto_saved_at || '?'} — ${truncate(outcome, 160)}`);
    } catch {
      lines.push(`  - ${name} (marker no parseable)`);
    }
    if (drain) { try { fs.unlinkSync(full); } catch {} }
  }
  // Todos los markers resultaron obsoletos: nada que avisar.
  if (!lines.length) return '';
  return `⚠ [harness] Sesiones anteriores auto-guardadas por SessionEnd (el modelo no llamó checkpoint):\n` +
    `${lines.join('\n')}\nRevisá si querés editar la narrativa de alguna.`;
}

function buildSessionContext({ cwd, session_id = null, drain = true } = {}) {
  const resolved = resolveCwd(cwd || process.cwd());

  if (session_id) {
    try { initState(session_id, resolved.matched ? resolved.project_id : null); }
    catch { /* silent */ }
  }

  let text = fmtScope(resolved);
  if (resolved.matched) {
    const extra = fmtProjectContext(loadProjectContext(resolved.project_id));
    if (extra) text += '\n\n' + extra;
  }
  const missed = drainMissedCheckpoints(drain);
  if (missed) text = missed + '\n\n' + text;

  return { text, resolved };
}

module.exports = {
  buildSessionContext,
  loadProjectContext,
  drainMissedCheckpoints,
  sessionHasNarrative,
  fmtProjectContext,
  fmtScope,
  truncate,
  STATE_DIR,
  DB_PATH,
};
