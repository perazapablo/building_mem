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
  'mcp__memory__context_for_topic',
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

// Session-scoped check. Only returns has_focus=true when THIS session_id has a
// row for THIS project_id. Fixes the stale-focus bug where any prior session
// left focus and made has_focus=true forever.
function checkFocusForSession(project_id, session_id, dbPath = DEFAULT_DB) {
  const out = { has_focus: false, db_path: dbPath };
  if (!project_id) { out.error = 'missing project_id'; return out; }
  if (!session_id) { out.error = 'missing session_id'; return out; }
  if (!fs.existsSync(dbPath)) { out.error = `DB not found at ${dbPath}`; return out; }

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare(
      `SELECT focus, set_at, updated_at
         FROM session_focus
        WHERE project_id = ? AND session_id = ?
        LIMIT 1`
    ).get(project_id, session_id);
    if (row) {
      out.has_focus = true;
      out.session_id = session_id;
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

// ── Focus provisional ───────────────────────────────────────────────────────
// El gate que exigía set_focus antes de tocar código cobraba un turno entero
// por cada cambio chico: para arreglar un typo había que declarar un focus.
// La salida no es aflojar la trazabilidad, es dejar de pagarla — el prompt del
// usuario YA describe qué se está haciendo, y describirlo con sus palabras es
// más honesto que con la paráfrasis del modelo.
//
// Reglas del upsert, en orden de prioridad:
//   sin fila           → inserta provisional
//   fila provisional   → la pisa (el prompt nuevo es el foco actual)
//   fila declarada     → NO la toca. Un set_focus explícito del agente nunca
//                        se degrada por un prompt posterior.

/** Ruido conversacional: no describe trabajo, no debe pisar un focus bueno. */
const ACK = /^(ok|oka?y|dale|s[ií]|no|listo|gracias|perfecto|bien|correcto|segu[ií]|continu[aá]|adelante|hac[eé]lo|hazlo|va|bueno)\b/i;

/**
 * Convierte un prompt en una línea de focus. Sin resumir ni interpretar: es
 * texto del usuario, recortado.
 * @returns {string|null} null si no hay nada aprovechable.
 */
function focusFromPrompt(prompt, maxLen = 180) {
  let s = String(prompt || '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  s = s.replace(/^\/[a-z0-9:_-]+\s*/i, '').trim(); // slash-command al inicio
  if (!s) return null;
  if (s.length <= maxLen) return s;
  const corte = s.slice(0, maxLen);
  const esp = corte.lastIndexOf(' ');
  return `${(esp > maxLen * 0.6 ? corte.slice(0, esp) : corte).trim()}…`;
}

/** ¿Es un acuse que no debería pisar un focus ya existente? */
function isAck(prompt) {
  const s = String(prompt || '').trim();
  return s.split(/\s+/).length <= 3 && ACK.test(s);
}

/**
 * Escribe un focus provisional. Nunca lanza: un fallo acá no puede romper el
 * turno del usuario — a lo sumo el gate de respaldo pide el focus a mano.
 *
 * @returns {{written: bool, reason: string}}
 */
function setProvisionalFocus(session_id, project_id, focus, dbPath = DEFAULT_DB) {
  if (!session_id || !project_id) return { written: false, reason: 'missing ids' };
  const texto = focusFromPrompt(focus);
  if (!texto) return { written: false, reason: 'prompt vacío' };
  if (!fs.existsSync(dbPath)) return { written: false, reason: 'DB inexistente' };

  let db;
  try {
    db = new DatabaseSync(dbPath);
    // El server MCP tiene la DB abierta; WAL permite el segundo escritor pero
    // hay que estar dispuesto a esperar el lock en vez de fallar de una.
    db.exec('PRAGMA busy_timeout = 3000');

    if (isAck(texto)) {
      // Un "dale" no describe trabajo: sirve para arrancar un focus, no para
      // reemplazar uno que ya dice algo.
      const r = db.prepare(
        `INSERT INTO session_focus (session_id, project_id, focus, provisional)
         VALUES (?, ?, ?, 1)
         ON CONFLICT(session_id) DO NOTHING`
      ).run(session_id, project_id, texto);
      return { written: r.changes > 0, reason: r.changes > 0 ? 'insertado (ack)' : 'ya había focus' };
    }

    const r = db.prepare(
      `INSERT INTO session_focus (session_id, project_id, focus, provisional)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(session_id) DO UPDATE SET
         focus      = excluded.focus,
         project_id = excluded.project_id,
         updated_at = datetime('now')
       WHERE session_focus.provisional = 1`
    ).run(session_id, project_id, texto);
    return {
      written: r.changes > 0,
      reason: r.changes > 0 ? 'upsert provisional' : 'focus declarado intacto',
    };
  } catch (e) {
    return { written: false, reason: `DB error: ${e.message}` };
  } finally {
    try { db && db.close(); } catch {}
  }
}

module.exports = {
  checkFocus,
  checkFocusForSession,
  requiresFocus,
  setProvisionalFocus,
  focusFromPrompt,
  isAck,
  ALLOWLIST,
  DEFAULT_DB,
};
