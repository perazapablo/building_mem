#!/usr/bin/env node
// PostToolUse hook: graba las ENMIENDAS que el humano concedió.
//
// Por qué acá y no en el PreToolUse: un hook PreToolUse que devuelve `ask` no
// sabe la respuesta — emite la pregunta y muere. El PostToolUse corre SOLO si
// el tool efectivamente se ejecutó, o sea solo si el humano dijo que sí. Es la
// única señal confiable de aprobación que el harness tiene, y no hace falta
// inventarla ni preguntarle al modelo.
//
// Reejecuta decide() con los mismos inputs que vio el PreToolUse. Si el
// veredicto era {mode:'ask'}, la escritura pasó por una aprobación humana →
// se registra en state.scope_amendments[]:
//
//   out_of_scope  archivo de código fuera del diff_scope aprobado.
//                 Amplía el scope efectivo (ver effectiveScope) para que el
//                 exit gate no rechace al final lo que se aprobó al principio.
//   early_write   código escrito en exploration/planning. NO amplía scope:
//                 es una nota de que se salteó el orden, no una autorización.
//   plan_amend    se tocó un artefacto fuera de su fase.
//
// `reason` queda en null a propósito. El PreToolUse solo recibe
// tool_name/tool_input/cwd/session_id: no hay ningún campo donde el modelo
// declare un motivo, y fabricarlo sería peor que dejarlo vacío. El
// additionalContext empuja al modelo a registrarlo donde corresponde.
//
// Silencioso ante cualquier error: este hook nunca debe romper un turno.

const fs = require('node:fs');
const path = require('node:path');

const { decide, findHarness, resolveTask } = require('./phase-gate.cjs');

const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);
const STATE_FILE = 'state.json';
const MAX_AMENDMENTS = 200; // cota dura: un state.json no es un log

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** tmp + rename: matar el proceso a mitad no deja un state.json corrupto. */
function writeAtomic(file, content) {
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

function relToRoot(root, filePath) {
  const abs = path.resolve(root, filePath);
  return path.relative(root, abs).replace(/\\/g, '/');
}

/** ¿El tool falló? Entonces no hubo escritura que enmendar. */
function toolFailed(payload) {
  const r = payload?.tool_response;
  if (!r) return false;
  if (r.success === false) return true;
  if (typeof r === 'object' && typeof r.error === 'string' && r.error) return true;
  return false;
}

function classify(rel, state, taskRel) {
  if (rel.startsWith(`${taskRel}/`) || rel === taskRel) return 'plan_amend';
  const codePhase = state.phase === 'implementation' || state.phase === 'verification';
  return codePhase ? 'out_of_scope' : 'early_write';
}

function main() {
  const raw = readStdin();
  if (!raw) return;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  const toolName = payload.tool_name;
  if (!WRITE_TOOLS.has(toolName)) return;
  if (toolFailed(payload)) return;

  const target = payload.tool_input?.file_path || payload.tool_input?.notebook_path;
  if (!target) return;

  const root = findHarness(payload.cwd || process.cwd());
  if (!root) return;

  const resolved = resolveTask(path.join(root, '.harness'), payload.session_id);
  if (resolved.kind !== 'task') return;

  const verdict = decide(
    resolved.state,
    root,
    toolName,
    payload.tool_input,
    resolved.dir,
  );
  // allow → nada que registrar. deny → el write no debería haber ocurrido;
  // no es este hook quien lo arregla.
  if (verdict.allow || verdict.mode !== 'ask') return;

  const stateFile = path.join(resolved.dir, STATE_FILE);
  let state;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return;
  }

  const rel = relToRoot(root, target);
  const taskRel = relToRoot(root, resolved.dir);
  const kind = classify(rel, state, taskRel);

  const list = Array.isArray(state.scope_amendments) ? state.scope_amendments : [];
  if (list.some((a) => a && a.path === rel && a.kind === kind)) return; // ya registrada
  if (list.length >= MAX_AMENDMENTS) return;

  list.push({
    path: rel,
    kind,
    phase: state.phase,
    at: new Date().toISOString(),
    session_id: payload.session_id ?? null,
    approved_by: 'human',
    reason: null,
  });
  state.scope_amendments = list;
  state.updated_at = new Date().toISOString();

  try {
    writeAtomic(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    return;
  }

  const nota =
    kind === 'out_of_scope'
      ? `scope ampliado con '${rel}' (aprobado por el humano). Ya no hace falta rollback ni reescribir el plan. Si el archivo entró por una razón estructural, registrala con decision_record.`
      : kind === 'early_write'
        ? `'${rel}' se escribió en fase '${state.phase}', antes de que la fase habilite código. Queda anotado como early_write; NO amplía el diff_scope.`
        : `'${rel}' se tocó fuera de su fase. Queda anotado como enmienda al artefacto.`;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `[harness/fase] ${nota}`,
      },
    }),
  );
}

if (require.main === module) {
  try {
    main();
  } catch {
    /* nunca romper un turno */
  }
  process.exit(0);
}

module.exports = { classify, toolFailed };
