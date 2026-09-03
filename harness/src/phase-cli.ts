#!/usr/bin/env node
// phase-cli: el núcleo del harness (máquina + gates + store de tareas) como
// comandos, para operar el flujo DESDE una sesión de Claude Code.
// El motor (el modelo) es la sesión; esto es el engine de estado.
//
//   node dist/phase-cli.js init "título" --workflow estandar [--test cmd] [--build cmd]
//   node dist/phase-cli.js status
//   node dist/phase-cli.js list             ← todas las tareas del repo
//   node dist/phase-cli.js use <task_id>    ← esta sesión trabaja esa tarea
//   node dist/phase-cli.js advance          ← corre el gate de salida de la fase
//   node dist/phase-cli.js approve          ← aplica pending (lee diff_scope del plan)
//   node dist/phase-cli.js reject "motivo"
//   node dist/phase-cli.js rollback <fase> "motivo"
//   node dist/phase-cli.js escalate "motivo"
//   node dist/phase-cli.js done             ← cierra la tarea (queda en el historial)
//   node dist/phase-cli.js tools            ← tools permitidas (para humanos/debug)
//
// El store ACUMULA: cada tarea es .harness/tasks/<task_id>/ con su state y sus
// artefactos. Pueden convivir varias activas; qué tarea gobierna esta sesión lo
// resuelve el store (puntero de sesión → única activa → tarea de la sesión), y
// si es ambiguo se corta pidiendo `use` en vez de adivinar.
//
// Salida: texto legible + exit codes (0 ok · 1 gate/estado rechazó · 2 uso).
// Las aprobaciones humanas ocurren en la conversación; acá solo se ejecutan.

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { buildGateRegistry, readPlan, type GateContext } from "./core/gates.js";
import { advance, approve, escalate, rejectPending, rollback } from "./core/machine.js";
import { createTask, slugifyTitle, type TaskState } from "./core/task.js";
import {
  clearCurrent,
  listTasks,
  resolveTask,
  saveTask,
  scopeConflicts,
  setCurrent,
  uniqueTaskId,
  taskDir,
} from "./core/task-store.js";
import { PHASES, toolsForPhase, WORKFLOWS, type Phase, type WorkflowId } from "./core/workflow.js";
import { defaultExec } from "./tools/local.js";

const projectDir = process.cwd();
const harnessDir = path.join(projectDir, ".harness");
const sessionId = process.env.CLAUDE_SESSION_ID ?? undefined;

function fail(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}

function short(id: string): string {
  // Un UUID se trunca (los primeros 8 alcanzan para distinguirlo); un slug se
  // muestra entero — truncarlo destruiría exactamente lo que lo hace útil.
  const esUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  return esUuid ? id.slice(0, 8) : id;
}

/** La tarea que gobierna esta sesión, o corte con instrucción accionable. */
async function requireState(): Promise<TaskState> {
  const resolved = await resolveTask(harnessDir, sessionId);
  switch (resolved.kind) {
    case "task":
      return resolved.state;
    case "none":
      return fail(
        `no hay tarea activa en ${harnessDir} — usá init (o 'list' para ver el historial)`,
        2,
      );
    case "ambiguous":
      return fail(
        `hay ${resolved.candidates.length} tareas activas y ninguna ligada a esta sesión:\n` +
          resolved.candidates
            .map((t) => `  ${short(t.task_id)}  ${t.title} (fase ${t.phase})`)
            .join("\n") +
          `\nElegí con: phase-cli use <task_id>`,
        2,
      );
  }
}

async function persist(state: TaskState): Promise<void> {
  await saveTask(harnessDir, state);
}

function gateCtx(state: TaskState): GateContext {
  const dir = taskDir(harnessDir, state.task_id);
  return {
    taskDir: dir,
    state,
    async readFile(rel) {
      try {
        return await readFile(path.join(dir, rel), "utf8");
      } catch {
        return null;
      }
    },
    exec: (cmd) => defaultExec(cmd, projectDir),
    async changedFiles() {
      const r = await defaultExec("git status --porcelain", projectDir);
      if (r.exitCode !== 0) return [];
      return r.output
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => l.slice(2).trim().replace(/^"|"$/g, ""))
        .map((p) => (p.includes(" -> ") ? p.split(" -> ")[1]! : p));
    },
  };
}

function relTaskDir(state: TaskState): string {
  const rel = path.relative(projectDir, taskDir(harnessDir, state.task_id));
  return rel.replace(/\\/g, "/");
}

function printStatus(state: TaskState): void {
  console.log(`tarea:     ${state.title}  [${short(state.task_id)}]`);
  console.log(
    `workflow:  ${state.workflow} (elegido por humano; sugerido: ${state.workflow_suggested})`,
  );
  console.log(`estado:    ${state.status}`);
  console.log(
    `fase:      ${state.phase ?? "—"}${state.pending_transition ? ` → PENDIENTE OK humano para '${state.pending_transition}'` : ""}`,
  );
  console.log(`dir:       ${relTaskDir(state)}`);
  if (state.diff_scope) console.log(`scope:     ${state.diff_scope.join(", ")}`);
  if (state.phase) {
    const wf = WORKFLOWS[state.workflow];
    console.log(`tools:     ${toolsForPhase(wf, state.phase).join(", ")}`);
  }
}

/** Deja registrado que esta sesión trabaja esa tarea (puntero + session_ids). */
async function bindSession(state: TaskState): Promise<TaskState> {
  if (!sessionId) return state;
  await setCurrent(harnessDir, sessionId, state.task_id);
  if (state.session_ids.includes(sessionId)) return state;
  return {
    ...state,
    session_ids: [...state.session_ids, sessionId],
    updated_at: new Date().toISOString(),
  };
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case "init": {
      const title = rest[0];
      if (!title) {
        fail('uso: init "título" --workflow directo|estandar [--test cmd] [--build cmd]', 2);
      }
      let workflow: WorkflowId = "estandar";
      const commands: { build?: string; test?: string } = {};
      for (let i = 1; i < rest.length; i++) {
        if (rest[i] === "--workflow") workflow = rest[++i] as WorkflowId;
        else if (rest[i] === "--test") commands.test = rest[++i] ?? "";
        else if (rest[i] === "--build") commands.build = rest[++i] ?? "";
      }
      if (!(workflow in WORKFLOWS)) fail(`workflow inválido: ${workflow}`, 2);
      if (workflow === "libre") fail("libre no usa la máquina de fases: trabajá sin init", 2);
      // El store acumula: una tarea activa preexistente ya no bloquea. La nueva
      // queda ligada a esta sesión, así el gate sabe cuál la gobierna.
      const others = (await listTasks(harnessDir)).filter((t) => t.status === "active");
      const created = createTask({
        title,
        workflow,
        workflow_suggested: workflow, // la sugerencia ocurrió en la conversación
        project_id: process.env.HARNESS_PROJECT_ID ?? "desconocido",
        session_id: sessionId ?? randomUUID(),
        commands,
        // El id (= nombre del directorio) sale del título, resuelto contra las
        // tareas que ya existen para no pisar ninguna.
        task_id: await uniqueTaskId(harnessDir, slugifyTitle(title)),
      });
      const state = await bindSession(created);
      await persist(state);
      console.log(`tarea creada — workflow ${workflow}, fase ${state.phase}`);
      if (others.length) {
        console.log(
          `(conviven ${others.length} tarea(s) activa(s) más: ${others.map((t) => short(t.task_id)).join(", ")})`,
        );
      }
      printStatus(state);
      return;
    }

    case "status": {
      printStatus(await requireState());
      return;
    }

    case "list": {
      const tasks = await listTasks(harnessDir);
      if (!tasks.length) {
        console.log("sin tareas registradas");
        return;
      }
      const resolved = await resolveTask(harnessDir, sessionId);
      const currentId = resolved.kind === "task" ? resolved.state.task_id : null;
      for (const t of tasks) {
        const mark = t.task_id === currentId ? "→" : " ";
        const phase = t.status === "active" ? (t.phase ?? "—") : "cerrada";
        console.log(
          `${mark} ${short(t.task_id)}  ${t.status.padEnd(6)}  ${String(phase).padEnd(14)}  ${t.workflow.padEnd(8)}  ${t.title}`,
        );
      }
      if (resolved.kind === "ambiguous") {
        console.log("\nninguna ligada a esta sesión — elegí con: phase-cli use <task_id>");
      }
      return;
    }

    case "use": {
      const wanted = rest[0];
      if (!wanted) fail("uso: use <task_id>", 2);
      if (!sessionId) fail("sin CLAUDE_SESSION_ID no hay a qué ligar la tarea", 2);
      const matches = (await listTasks(harnessDir)).filter(
        (t) => t.task_id === wanted || t.task_id.startsWith(wanted),
      );
      if (!matches.length) fail(`no existe tarea '${wanted}' — mirá 'list'`, 2);
      if (matches.length > 1) {
        fail(`'${wanted}' es ambiguo: ${matches.map((t) => short(t.task_id)).join(", ")}`, 2);
      }
      const target = matches[0]!;
      if (target.status !== "active") fail(`la tarea ${short(target.task_id)} está cerrada`, 1);
      const state = await bindSession(target);
      await persist(state);
      console.log(`esta sesión trabaja: ${state.title} [${short(state.task_id)}]`);
      printStatus(state);
      return;
    }

    case "done": {
      const state = await requireState();
      const next: TaskState = { ...state, status: "done", updated_at: new Date().toISOString() };
      await persist(next);
      if (sessionId) await clearCurrent(harnessDir, sessionId);
      console.log(
        `tarea cerrada: ${next.title} [${short(next.task_id)}] — queda en el historial (list)`,
      );
      return;
    }

    case "advance": {
      const state = await requireState();
      const outcome = await advance(state, buildGateRegistry(), gateCtx(state));
      switch (outcome.kind) {
        case "no_machine":
          fail("workflow sin máquina de fases");
          break;
        case "gate_failed":
          console.error(`GATE '${outcome.gate}' RECHAZÓ:\n${outcome.evidence}`);
          process.exit(1);
          break;
        case "awaiting_human": {
          await persist(outcome.state);
          const plan = await readPlan(gateCtx(outcome.state));
          console.log(`gate OK — transición a '${outcome.to}' PENDIENTE de OK humano.`);
          if (plan.ok) {
            console.log(`diff_scope propuesto: ${plan.data.diff_scope.join(", ")}`);
            console.log(`verificación: ${plan.data.verification_criteria.join(" · ")}`);
          }
          console.log(
            'Mostrale el plan al humano; con su OK: approve. Si lo rechaza: reject "motivo".',
          );
          return;
        }
        case "advanced":
          await persist(outcome.state);
          console.log(`gate OK — fase: ${outcome.to}`);
          return;
        case "task_complete":
          await persist(outcome.state);
          if (sessionId) await clearCurrent(harnessDir, sessionId);
          console.log("TAREA COMPLETA: todos los gates en verde.");
          return;
      }
      return;
    }

    case "approve": {
      const state = await requireState();
      if (!state.pending_transition) fail("no hay transición pendiente que aprobar");
      const plan = await readPlan(gateCtx(state));
      const scope = plan.ok ? plan.data.diff_scope : [];
      const next = approve(state, scope.length ? { diff_scope: scope } : {});
      await persist(next);
      console.log(
        `aprobado — fase: ${next.phase}${scope.length ? `, diff_scope autorizado: ${scope.join(", ")}` : ""}`,
      );
      // Con varios agentes sobre el mismo repo, este es el único momento en que
      // se puede avisar antes de que dos escriban sobre los mismos archivos.
      // Es un aviso, no un bloqueo: solapar puede ser deliberado.
      const conflicts = await scopeConflicts(harnessDir, next);
      if (conflicts.length) {
        console.log(
          `\n! scope compartido con ${conflicts.length} tarea(s) activa(s) — dos agentes pueden pisarse:`,
        );
        for (const c of conflicts) {
          console.log(`  ${short(c.task_id)}  ${c.title} (fase ${c.phase})`);
          for (const [mio, suyo] of c.overlaps.slice(0, 4)) {
            console.log(`      ${mio}  <->  ${suyo}`);
          }
        }
      }
      return;
    }

    case "reject": {
      const state = await requireState();
      if (!state.pending_transition) fail("no hay transición pendiente que rechazar");
      await persist(rejectPending(state));
      console.log(
        `rechazado — se sigue en fase ${state.phase}. Motivo para el agente: ${rest[0] ?? "(no dado)"}`,
      );
      return;
    }

    case "rollback": {
      const state = await requireState();
      const to = rest[0] as Phase;
      const reason = rest[1];
      if (!PHASES.includes(to) || !reason) fail('uso: rollback <fase> "motivo"', 2);
      const next = rollback(state, to, reason);
      await persist(next);
      console.log(
        `retroceso aplicado — fase: ${next.phase}${next.diff_scope === null ? " (diff_scope anulado)" : ""}`,
      );
      return;
    }

    case "escalate": {
      const state = await requireState();
      const reason = rest[0];
      if (!reason) fail('uso: escalate "motivo"', 2);
      const next = escalate(state, reason);
      await persist(next);
      console.log(`escalado a ${next.workflow} — entra por ${next.phase}`);
      return;
    }

    case "tools": {
      const state = await requireState();
      if (!state.phase) fail("sin fase activa");
      console.log(toolsForPhase(WORKFLOWS[state.workflow], state.phase).join("\n"));
      return;
    }

    default:
      fail(
        "uso: phase-cli <init|status|list|use|advance|approve|reject|rollback|escalate|done|tools>",
        2,
      );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
