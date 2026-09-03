#!/usr/bin/env node
// PreToolUse hook: enforcement de fases del harness DENTRO de Claude Code.
//
// El store acumula tareas (.harness/tasks/<task_id>/) y varias pueden estar
// activas a la vez. Qué tarea gobierna se resuelve por evidencia, nunca por
// azar: puntero de la sesión → única activa → tarea que ya tiene esta
// session_id. Si quedan varias candidatas, un write se BLOQUEA pidiendo
// `phase-cli use <id>`: validar contra el diff_scope de la tarea equivocada
// es peor que frenar.
//
// ── ask vs deny ────────────────────────────────────────────────────────────
// El gate distingue dos clases de bloqueo, porque no son la misma cosa:
//
//   ask   El humano tiene una respuesta razonable ("sí, ese archivo también").
//         El diff_scope se declara en planning, ANTES de haber leído todo el
//         código: es una predicción, no un contrato. Tratarla como contrato
//         duro obligaba a decision_record + rollback + reescribir el plan —
//         cinco pasos para autorizar un archivo. Ahora se pregunta y sigue;
//         phase-post.cjs graba la enmienda en scope_amendments[].
//
//   deny  No hay respuesta humana razonable: state.json a mano, artefactos de
//         OTRA tarea, decision_record con payload inválido. Son errores del
//         modelo, no fricción legítima.
//
// Reglas:
//   Código fuera del diff_scope (implementation/verification) → ask
//   Código en exploration/planning                            → ask
//   Artefacto de la tarea escrito en la fase equivocada       → ask
//   state.json / puntero de sesión a mano                     → deny
//   Artefactos de OTRA tarea                                  → deny
//   decision_record en fase sin captura / phase mismatch      → deny
//   Varias tareas activas sin dueña                           → deny (use <id>)
//
// Sin tarea activa → no hay contrato de fase → no interviene.
// Convención: exit 0 = permitir · JSON permissionDecision = ask · exit 2 = deny.

const fs = require('node:fs');
const path = require('node:path');

const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

const ARTIFACTS_WRITABLE = {
  exploration: ['research'],
  planning: ['research', 'plan'],
  implementation: [],
  verification: [],
};

const CODE_WRITE_PHASES = new Set(['implementation', 'verification']);

const DECISION_CAPTURE = {
  directo: [],
  estandar: ['planning', 'implementation'],
  libre: null, // sin máquina: no interviene
};

const TASKS_DIR = 'tasks';
const STATE_FILE = 'state.json';
const CURRENT_FILE = 'current.json';
const CURRENT_DIR = 'current'; // layout nuevo: un archivo por sesión (sin carrera)

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null; // inexistente o corrupto: no adivinar
  }
}

/** Primer ancestro (incluido startDir) con un .harness/. */
function findHarness(startDir) {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, '.harness'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function listTasks(harnessDir) {
  const out = [];
  // Layout legacy (.harness/state.json): una sola tarea, sin migrar todavía.
  const legacy = readJson(path.join(harnessDir, STATE_FILE));
  if (legacy && legacy.task_id) out.push({ state: legacy, dir: harnessDir });

  let entries = [];
  try {
    entries = fs
      .readdirSync(path.join(harnessDir, TASKS_DIR), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return out;
  }
  for (const id of entries) {
    const dir = path.join(harnessDir, TASKS_DIR, id);
    const state = readJson(path.join(dir, STATE_FILE));
    if (state && state.task_id) out.push({ state, dir });
  }
  return out;
}

/**
 * Puntero sesión → tarea. Lee primero el layout por-sesión
 * (.harness/current/<session_id>), que no tiene read-modify-write y por lo
 * tanto no se corrompe con dos agentes concurrentes; cae al mapa legacy
 * (.harness/current.json) para tareas creadas antes del cambio.
 */
function readPointer(harnessDir, sessionId) {
  if (!sessionId) return null;
  try {
    const v = fs.readFileSync(path.join(harnessDir, CURRENT_DIR, sessionId), 'utf8').trim();
    if (v) return v;
  } catch {
    /* sin archivo por sesión: probar el mapa legacy */
  }
  const map = readJson(path.join(harnessDir, CURRENT_FILE)) || {};
  return map[sessionId] || null;
}

/**
 * @returns {{kind:'none'} | {kind:'task', state:object, dir:string}
 *          | {kind:'ambiguous', candidates:object[]}}
 */
function resolveTask(harnessDir, sessionId) {
  const active = listTasks(harnessDir).filter((t) => t.state.status === 'active');
  if (!active.length) return { kind: 'none' };

  if (sessionId) {
    const pointed = readPointer(harnessDir, sessionId);
    const hit = active.find((t) => t.state.task_id === pointed);
    if (hit) return { kind: 'task', state: hit.state, dir: hit.dir };
  }
  if (active.length === 1) return { kind: 'task', state: active[0].state, dir: active[0].dir };
  if (sessionId) {
    const owned = active.filter((t) => (t.state.session_ids || []).includes(sessionId));
    if (owned.length === 1) return { kind: 'task', state: owned[0].state, dir: owned[0].dir };
  }
  return { kind: 'ambiguous', candidates: active.map((t) => t.state) };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function inScope(file, scope) {
  const norm = file.replace(/\\/g, '/');
  return scope.some((pattern) => {
    const p = pattern.replace(/\\/g, '/');
    if (p.endsWith('/**')) return norm === p.slice(0, -3) || norm.startsWith(p.slice(0, -2));
    if (p.includes('*')) {
      const rx = new RegExp(`^${p.split('*').map(escapeRegExp).join('[^/]*')}$`);
      return rx.test(norm);
    }
    return norm === p;
  });
}

/**
 * Scope realmente autorizado = el aprobado en el plan + las ampliaciones que
 * el humano concedió durante implementation. Sin esta unión, el exit gate
 * (diff_en_scope_y_build_ok) rechazaría al final los mismos archivos que el
 * humano aprobó uno por uno. Gemela de effectiveScope() en gates.ts: si
 * cambia una, cambia la otra.
 */
function effectiveScope(state) {
  const base = Array.isArray(state?.diff_scope) ? state.diff_scope : [];
  const amended = Array.isArray(state?.scope_amendments)
    ? state.scope_amendments
        .filter((a) => a && a.kind === 'out_of_scope' && a.path)
        .map((a) => a.path)
    : [];
  return [...base, ...amended];
}

function relToRoot(root, filePath) {
  const abs = path.resolve(root, filePath);
  const rel = path.relative(root, abs);
  return rel.replace(/\\/g, '/');
}

const allow = () => ({ allow: true });
const ask = (reason) => ({ allow: false, mode: 'ask', reason });
const deny = (reason) => ({ allow: false, mode: 'deny', reason });

/**
 * @param taskDir directorio de la tarea; por defecto .harness/tasks/<task_id>
 * @returns {{allow:true} | {allow:false, mode:'ask'|'deny', reason:string}}
 */
function decide(state, root, toolName, toolInput, taskDir) {
  if (!state || state.status !== 'active' || !state.phase) return allow();
  const phase = state.phase;
  const workflow = state.workflow;
  const taskRel = relToRoot(
    root,
    taskDir ?? path.join(root, '.harness', TASKS_DIR, state.task_id ?? ''),
  );

  if (WRITE_TOOLS.has(toolName)) {
    const target = toolInput?.file_path || toolInput?.notebook_path;
    if (!target) return allow();
    const rel = relToRoot(root, target);

    if (rel.startsWith('..')) return allow(); // fuera del proyecto de la tarea

    if (rel.startsWith('.harness/')) {
      if (rel.endsWith(`/${STATE_FILE}`) || rel === `.harness/${STATE_FILE}`) {
        return deny(
          `state.json lo muta solo el phase-cli (advance/approve/rollback) — no editarlo a mano.`,
        );
      }
      if (rel === `.harness/${CURRENT_FILE}` || rel.startsWith(`.harness/${CURRENT_DIR}/`)) {
        return deny(`el puntero sesión→tarea lo muta el phase-cli: usá 'use <task_id>'.`);
      }
      // Los artefactos de la tarea vigente; los de OTRA tarea no se tocan.
      const inTask = rel === taskRel || rel.startsWith(`${taskRel}/`);
      if (!inTask) {
        if (rel.startsWith(`.harness/${TASKS_DIR}/`)) {
          return deny(
            `'${rel}' pertenece a otra tarea del harness. La tarea de esta sesión es ` +
              `'${state.title}' (${taskRel}). Cambiá con: phase-cli use <task_id>.`,
          );
        }
        return allow(); // otros archivos sueltos en .harness/: no es asunto del gate
      }
      const name = rel.slice(taskRel.length + 1);
      const artifact =
        name === (state.artifacts?.research ?? 'research.md')
          ? 'research'
          : name === (state.artifacts?.plan ?? 'plan.md')
            ? 'plan'
            : null;
      if (artifact) {
        const writable = ARTIFACTS_WRITABLE[phase] ?? [];
        if (writable.includes(artifact)) return allow();
        return ask(
          `Fase '${phase}': el artefacto '${artifact}' no es el producto de esta fase.` +
            (artifact === 'plan' && CODE_WRITE_PHASES.has(phase)
              ? ` Si es una ENMIENDA al plan aprobado (apéndice, no reescritura), aprobá y queda registrada.`
              : ''),
        );
      }
      return allow();
    }

    if (!CODE_WRITE_PHASES.has(phase)) {
      const producto =
        phase === 'exploration'
          ? `${taskRel}/${state.artifacts?.research ?? 'research.md'}`
          : `${taskRel}/${state.artifacts?.plan ?? 'plan.md'}`;
      return ask(
        `Fase '${phase}': todavía no toca escribir código. ` +
          `Aprobá solo si es un cambio chico y directo que no amerita esperar al plan ` +
          `(queda registrado en early_writes[]). ` +
          `El camino de la fase es producir ${producto} y correr: ` +
          `node <harness>/dist/phase-cli.js advance`,
      );
    }

    const scope = effectiveScope(state);
    if (scope.length && !inScope(rel, scope)) {
      return ask(
        `'${rel}' está fuera del diff_scope aprobado: [${scope.join(', ')}]. ` +
          `Si corresponde tocarlo, aprobá: el scope se amplía y queda registrado en ` +
          `scope_amendments[], sin rollback ni reescribir el plan.`,
      );
    }
    return allow();
  }

  if (toolName === 'mcp__memory__decision_record') {
    const capture = DECISION_CAPTURE[workflow];
    if (capture === null || capture === undefined) return allow();
    if (!capture.includes(phase)) {
      return deny(
        workflow === 'directo'
          ? `Apareció una decisión en una tarea 'directo': la tarea estaba mal clasificada. ` +
              `Decile al humano qué hay que decidir y ofrecé escalar (phase-cli escalate) ` +
              `o que lo resuelva en una línea.`
          : `La fase '${phase}' no captura decisiones (captura: ${capture.join(', ')}). ` +
              `Si es una decisión real, anotala para registrarla al entrar a la fase correcta.`,
      );
    }
    // El `phase` del payload es autodeclarado por el modelo: se verifica
    // contra el estado real. Sin esto la columna vuelve a ser una opinión.
    const declared = toolInput?.phase;
    if (declared !== undefined && declared !== phase) {
      return deny(
        `phase declarado '${declared}' ≠ fase real de la tarea '${phase}'. ` +
          `Registrá con phase: "${phase}" (o sin el campo).`,
      );
    }
    return allow();
  }

  return allow();
}

/** El caso ambiguo solo frena lo que el harness gobierna; el resto pasa. */
function decideAmbiguous(candidates, toolName) {
  const governed = WRITE_TOOLS.has(toolName) || toolName === 'mcp__memory__decision_record';
  if (!governed) return allow();
  return deny(
    `hay ${candidates.length} tareas activas del harness y ninguna ligada a esta sesión:\n` +
      candidates
        .map((t) => `  ${String(t.task_id).slice(0, 8)}  ${t.title} (fase ${t.phase})`)
        .join('\n') +
      `\nElegí cuál gobierna antes de escribir: node <harness>/dist/phase-cli.js use <task_id>`,
  );
}

function main() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch {
    process.exit(0);
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  const cwd = payload.cwd || process.cwd();
  const root = findHarness(cwd);
  if (!root) process.exit(0);

  const resolved = resolveTask(path.join(root, '.harness'), payload.session_id);
  if (resolved.kind === 'none') process.exit(0);

  const verdict =
    resolved.kind === 'ambiguous'
      ? decideAmbiguous(resolved.candidates, payload.tool_name)
      : decide(resolved.state, root, payload.tool_name, payload.tool_input, resolved.dir);

  if (verdict.allow) process.exit(0);

  if (verdict.mode === 'ask') {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: `[harness/fase] ${verdict.reason}`,
        },
      }),
    );
    process.exit(0);
  }

  console.error(`[harness/fase] BLOQUEO: ${verdict.reason}`);
  process.exit(2);
}

if (require.main === module) main();

module.exports = {
  decide,
  decideAmbiguous,
  findHarness,
  resolveTask,
  inScope,
  effectiveScope,
  readPointer,
};
