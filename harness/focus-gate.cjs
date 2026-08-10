// Focus-gate core. Given a project_id, checks whether session_focus has any
// row for it. Agnostic to client. Used by adapters that want to gate memory
// writes on the existence of an explicit focus.
//
// Programmatic:
//   const { checkFocus, requiresFocus, ALLOWLIST } = require('.../focus-gate.cjs');
//
// Contract:
//   checkFocus(project_id, dbPath?) ->
//     { has_focus: bool, focus?: string, session_id?: string,
//       set_at?: string, updated_at?: string, db_path: string, error?: string }
//
//   requiresFocus(tool_name) -> bool
//     true  = writing tool that must have focus before running
//     false = read-only, scope-creation, or focus-itself (bypass)

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');

const DEFAULT_DB = process.env.MCP_MEMORY_DB_PATH
  || 'C:/Users/Desarrollos/.config/mcp-learning/memory.db';

// Tools that DO NOT require focus. Everything else under mcp__memory__* does.
const ALLOWLIST = new Set([
  // ping
  'mcp__memory__ping',
  // reads
  'mcp__memory__list_projects',
  'mcp__memory__get_project',
  'mcp__memory__get_project_context',
  'mcp__memory__get_sessions',
  'mcp__memory__get_working_state',
  'mcp__memory__get_note',
  'mcp__memory__get_artifact',
  'mcp__memory__get_code_entity',
  'mcp__memory__get_code_entity_context',
  'mcp__memory__get_related',
  'mcp__memory__get_relations',
  'mcp__memory__get_audit_trail',
  'mcp__memory__get_pending_judgments',
  'mcp__memory__search_all',
  'mcp__memory__search_notes',
  'mcp__memory__search_code_entities',
  'mcp__memory__build_context',
  'mcp__memory__audit_stale',
  'mcp__memory__list_project_paths',
  'mcp__memory__resolve_project_by_path',
  'mcp__memory__list_open_threads',
  'mcp__memory__list_project_threads',
  // scope-creation (chicken-and-egg: cannot require focus before project exists)
  'mcp__memory__upsert_project',
  'mcp__memory__add_project_path',
  'mcp__memory__remove_project_path',
  // focus itself
  'mcp__memory__set_focus',
  'mcp__memory__get_focus',
  'mcp__memory__get_latest_focus_for_project',
]);

function requiresFocus(tool_name) {
  if (!tool_name || !tool_name.startsWith('mcp__memory__')) return false;
  return !ALLOWLIST.has(tool_name);
}

function checkFocus(project_id, dbPath = DEFAULT_DB) {
  const out = { has_focus: false, db_path: dbPath };
  if (!project_id) { out.error = 'missing project_id'; return out; }
  if (!fs.existsSync(dbPath)) { out.error = `DB not found at ${dbPath}`; return out; }

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare(
      `SELECT session_id, focus, set_at, updated_at
         FROM session_focus
        WHERE project_id = ?
        ORDER BY updated_at DESC
        LIMIT 1`
    ).get(project_id);
    if (row) {
      out.has_focus = true;
      out.session_id = row.session_id;
      out.focus = row.focus;
      out.set_at = row.set_at;
      out.updated_at = row.updated_at;
    }
  } catch (e) {
    out.error = `DB error: ${e.message}`;
  } finally {
    try { db && db.close(); } catch {}
  }
  return out;
}

module.exports = { checkFocus, requiresFocus, ALLOWLIST, DEFAULT_DB };
