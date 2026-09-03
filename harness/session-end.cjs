#!/usr/bin/env node
// SessionEnd hook: red de seguridad para el checkpoint. Corre cuando Claude
// Code cierra la sesión. Verifica en la DB si sessions[session_id] tiene un
// summary con outcome no vacío. Si no, arma un summary mecánico desde el
// harness state + queries a la DB y lo persiste vía INSERT ON CONFLICT.
//
// Cuando graba mecánicamente:
//   - marca el archivo <state-dir>/<sid>.missed-checkpoint
//   - imprime warning a stderr (visible en la terminal)
//
// El objetivo NO es sustituir la narrativa del modelo — es garantizar que
// la fila de la sesión existe en la DB con lo que sí se pudo capturar, para
// que el TIMELINE del viewer nunca tenga huecos por olvidos.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.MCP_MEMORY_DB_PATH
  || 'C:/Users/Desarrollos/.config/mcp-learning/memory.db';
const STATE_DIR = process.env.MCP_HARNESS_STATE_DIR
  || path.join(__dirname, 'state');

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (buf += c));
    process.stdin.on('end', () => resolve(buf));
  });
}

function readState(session_id) {
  const p = path.join(STATE_DIR, `${session_id}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// ISO "2026-08-13T16:22:26.085Z" → SQLite UTC "2026-08-13 16:22:26"
function isoToSqlite(iso) {
  return String(iso || '').replace('T', ' ').replace(/\.\d+/, '').replace('Z', '');
}

function collectMechanicalSummary(state) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const sql_ts = isoToSqlite(state.started_at);
    const decisions_ref = db.prepare(
      'SELECT id FROM decisions WHERE project_id = ? AND created_at >= ? ORDER BY created_at ASC'
    ).all(state.project_id, sql_ts).map((r) => r.id);
    const artifacts_ref = db.prepare(
      'SELECT id FROM artifacts WHERE project_id = ? AND created_at >= ? ORDER BY created_at ASC'
    ).all(state.project_id, sql_ts).map((r) => r.id);
    const threads_closed = db.prepare(
      'SELECT id FROM project_threads WHERE closed_in = ?'
    ).all(state.session_id).map((r) => r.id);
    const focusRow = db.prepare(
      'SELECT focus FROM session_focus WHERE session_id = ?'
    ).get(state.session_id);
    return {
      decisions_ref,
      artifacts_ref,
      threads_closed,
      focus: focusRow ? focusRow.focus : '',
    };
  } finally {
    try { db.close(); } catch {}
  }
}

function gitCommitsSince(startedAt) {
  try {
    const out = execFileSync('git', ['log', '--since', startedAt, '--format=%H'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split(/\r?\n/).filter(Boolean);
  } catch { return []; }
}

function buildMechanicalSummary(state, extra) {
  const now_ms = Date.now();
  const started_ms = Number.isFinite(state.started_at_ms)
    ? state.started_at_ms : Date.parse(state.started_at);
  const duration_min = Number.isFinite(started_ms)
    ? Math.round((now_ms - started_ms) / 60000) : 0;

  const files_edited = (state.files_edited || []).map((p) => ({ path: p, edits: 1 }));
  const commits = gitCommitsSince(state.started_at);

  const goal = extra.focus || `sesión ${state.session_id.slice(0, 8)}`;
  const parts = [];
  if (extra.decisions_ref.length) parts.push(`${extra.decisions_ref.length} decisions`);
  if (extra.artifacts_ref.length) parts.push(`${extra.artifacts_ref.length} artifacts`);
  if (extra.threads_closed.length) parts.push(`${extra.threads_closed.length} threads cerrados`);
  if (commits.length) parts.push(`${commits.length} commits`);
  if (files_edited.length) parts.push(`${files_edited.length} archivos editados`);
  const outcome = `auto-guardado en SessionEnd: ${parts.length ? parts.join(', ') : 'sin actividad relevante detectada'}.`;

  return {
    goal,
    outcome,
    decisions_ref: extra.decisions_ref,
    artifacts_ref: extra.artifacts_ref,
    pending: [],
    blockers: [],
    threads_closed: extra.threads_closed,
    stats: {
      duration_min,
      turns: state.turns || 0,
      commits,
      files_edited,
      bash_effects: [],
      memory_writes: {},
      code_entities_touched: [],
      tool_errors: state.tool_errors || 0,
      last_focus: extra.focus || '',
    },
    notes: `⚠ auto-saved en SessionEnd: el modelo no llamó checkpoint. Session_id: ${state.session_id}. Revisar y editar narrativa si hace falta.`,
  };
}

function deriveTitle(summary, session_id) {
  const goal = String(summary.goal || '').trim();
  if (goal) return goal.slice(0, 80);
  return `checkpoint ${session_id.slice(0, 8)}`;
}

function hasNarrative(summaryRaw) {
  if (!summaryRaw) return false;
  try {
    const s = JSON.parse(summaryRaw);
    // "Narrativa" = outcome no vacío. goal vacío o solo goal alcanza para
    // considerar que el modelo NO cerró la sesión.
    return typeof s.outcome === 'string' && s.outcome.trim().length > 0;
  } catch {
    return String(summaryRaw).trim().length > 0;
  }
}

function ensureRowWithMechanicalSummary(state) {
  const db = new DatabaseSync(DB_PATH);
  try {
    const row = db.prepare(
      'SELECT summary FROM sessions WHERE id = ?'
    ).get(state.session_id);
    if (row && hasNarrative(row.summary)) {
      return { action: 'skip', reason: 'model_checkpointed' };
    }
    const extra = collectMechanicalSummary(state);
    const summary = buildMechanicalSummary(state, extra);
    // Sesión vacía: sin decisions/artifacts/threads cerrados/commits/archivos
    // editados no hay nada útil que guardar. Skip silencioso — no crea row
    // ni marker.
    const stats = summary.stats || {};
    const hasSignal =
      summary.decisions_ref.length > 0 ||
      summary.artifacts_ref.length > 0 ||
      summary.threads_closed.length > 0 ||
      (stats.commits && stats.commits.length > 0) ||
      (stats.files_edited && stats.files_edited.length > 0);
    if (!hasSignal) {
      return { action: 'skip', reason: 'no_signal' };
    }
    const title = deriveTitle(summary, state.session_id);
    const summary_json = JSON.stringify(summary);
    db.prepare(`
      INSERT INTO sessions (id, title, summary, project_id)
           VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id,
           summary    = excluded.summary,
           updated_at = datetime('now')
    `).run(state.session_id, title, summary_json, state.project_id);
    return { action: 'auto_saved', summary };
  } finally {
    try { db.close(); } catch {}
  }
}

function markMissed(session_id, summary) {
  const p = path.join(STATE_DIR, `${session_id}.missed-checkpoint`);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({
      session_id,
      auto_saved_at: new Date().toISOString(),
      summary,
    }, null, 2));
  } catch { /* silent */ }
}

// Programmatic entrypoint. Adapters call this directly.
//   autoSave(session_id, { quiet })
//     quiet=true  -> no stderr warning (used by clients like opencode that run
//                    this on every session.idle instead of a real SessionEnd).
// Always idempotent: skips when the model already wrote a narrative summary,
// and skips when the session produced no signal worth persisting.
function autoSave(session_id, { quiet = false } = {}) {
  if (!session_id) return { action: 'skip', reason: 'no_session_id' };

  const state = readState(session_id);
  if (!state || !state.project_id) {
    // Sin state file o sin project_id no podemos armar summary mecánico útil.
    return { action: 'skip', reason: 'no_state' };
  }

  try {
    const result = ensureRowWithMechanicalSummary(state);
    if (result.action === 'auto_saved') {
      markMissed(session_id, result.summary);
      if (!quiet) {
        process.stderr.write(
          `
⚠ [harness] MODELO NO HIZO CHECKPOINT — auto-guardado en SessionEnd.
` +
          `  session_id: ${session_id}
` +
          `  outcome:    ${result.summary.outcome}
` +
          `  marker:     ${path.join(STATE_DIR, session_id + '.missed-checkpoint')}

`
        );
      }
    }
    return result;
  } catch (e) {
    if (!quiet) {
      process.stderr.write(`[harness] SessionEnd auto-save falló: ${e.message}
`);
    }
    return { action: 'error', reason: e.message };
  }
}

module.exports = {
  autoSave,
  readState,
  hasNarrative,
  buildMechanicalSummary,
  ensureRowWithMechanicalSummary,
  markMissed,
  STATE_DIR,
  DB_PATH,
};

// CLI / hook entrypoint: lee el payload SessionEnd de Claude Code por stdin.
if (require.main === module) {
  (async () => {
    let session_id = null;
    try {
      const raw = await readStdin();
      if (raw) {
        const payload = JSON.parse(raw);
        if (payload && typeof payload.session_id === 'string') session_id = payload.session_id;
      }
    } catch { /* ignore */ }

    // Sin session_id en el payload no hay red posible. Exit silencioso.
    if (session_id) autoSave(session_id);
    process.exit(0); // nunca fallar el cierre por esto
  })();
}
