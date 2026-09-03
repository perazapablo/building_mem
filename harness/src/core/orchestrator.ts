// El orquestador: cablea adapter + assembler + loop + máquina + gates + store.
// No inventa reglas — ejecuta las decididas. Toda la IO humana pasa por el
// Prompter (inyectable) y todo comando por exec (inyectable): el flujo
// completo se testea sin terminal, sin red y sin git.

import { readFile } from "node:fs/promises";
import path from "node:path";

import { assembleSystem } from "./assembler.js";
import { buildGateRegistry, readPlan, type GateContext } from "./gates.js";
import { runTurns, type LoopEvent } from "./loop.js";
import { advance, approve, escalate, rejectPending } from "./machine.js";
import { createTask, type TaskState } from "./task.js";
import { resolveTask, saveTask, taskDir } from "./task-store.js";
import { flagDecisionTool, maskTools, type HarnessTool } from "./tools.js";
import type { Effort, ModelAdapter, Msg } from "./types.js";
import { toolsForPhase, WORKFLOWS, type WorkflowId } from "./workflow.js";

export interface Prompter {
  /** Pregunta abierta; devuelve la línea del humano. */
  ask(question: string): Promise<string>;
  confirm(question: string): Promise<boolean>;
  choose(question: string, options: string[], suggested: string): Promise<string>;
}

export interface ExecFn {
  (command: string, cwd: string): Promise<{ exitCode: number; output: string }>;
}

export interface OrchestratorDeps {
  adapter: ModelAdapter;
  prompter: Prompter;
  projectDir: string;
  /** Tools locales + memoria MCP, sin enmascarar (se enmascara por fase acá). */
  tools: HarnessTool[];
  exec: ExecFn;
  /** Render de build_context; estable durante la tarea. */
  memoryContext?: string;
  effort?: Effort;
  maxTokens?: number;
  maxTurnsPerRound?: number;
  /** Rondas (loop→gate) por fase antes de preguntar si seguir. */
  maxRoundsPerPhase?: number;
  onEvent?: (e: LoopEvent) => void;
  /** Notifica cada mutación persistida: el caller mantiene acá el getState()
   *  que alimentan las tools (write_file/write_artifact/memoria). */
  onState?: (state: TaskState) => void;
  log?: (line: string) => void;
  now?: () => string;
}

export interface TaskInput {
  title: string;
  description: string;
  project_id: string;
  session_id: string;
  commands?: { build?: string; test?: string };
}

/** Heurística barata de sugerencia; la elección siempre es humana. */
export function suggestWorkflow(input: TaskInput): WorkflowId {
  const text = `${input.title} ${input.description}`.toLowerCase();
  const simple = /\b(typo|rename|bump|fix menor|una línea|one.?liner)\b/.test(text);
  return simple ? "directo" : "estandar";
}

async function gitChangedFiles(exec: ExecFn, cwd: string): Promise<string[]> {
  const r = await exec("git status --porcelain", cwd);
  if (r.exitCode !== 0) return [];
  return r.output
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.slice(2).trim().replace(/^"|"$/g, ""))
    .map((p) => (p.includes(" -> ") ? p.split(" -> ")[1]! : p));
}

function buildGateCtx(deps: OrchestratorDeps, dir: string, state: TaskState): GateContext {
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
    exec: (cmd) => deps.exec(cmd, deps.projectDir),
    changedFiles: () => gitChangedFiles(deps.exec, deps.projectDir),
  };
}

async function loadArtifacts(
  dir: string,
  state: TaskState,
): Promise<{ research?: string; plan?: string }> {
  const out: { research?: string; plan?: string } = {};
  for (const key of ["research", "plan"] as const) {
    const rel = state.artifacts[key];
    if (!rel) continue;
    try {
      out[key] = await readFile(path.join(dir, rel), "utf8");
    } catch {
      // el artefacto aún no existe: la fase que lo produce no corrió
    }
  }
  return out;
}

export async function runTask(input: TaskInput, deps: OrchestratorDeps): Promise<TaskState> {
  const log = deps.log ?? (() => {});
  const harnessDir = path.join(deps.projectDir, ".harness");
  const gates = buildGateRegistry();

  // ── 1. crear o reanudar ───────────────────────────────────────────────────
  // El store acumula tareas: reanudar es resolver cuál gobierna esta sesión.
  // Si hay varias activas y ninguna es de esta sesión, NO se elige por el
  // humano — se corta con el listado para que use `phase-cli use <id>`.
  const resolved = await resolveTask(harnessDir, input.session_id);
  if (resolved.kind === "ambiguous") {
    throw new Error(
      `hay ${resolved.candidates.length} tareas activas y ninguna ligada a esta sesión: ` +
        resolved.candidates.map((t) => `${t.task_id} ('${t.title}')`).join(", ") +
        " — elegí una con: phase-cli use <task_id>",
    );
  }
  let state: TaskState;
  if (resolved.kind === "task") {
    state = resolved.state;
    deps.onState?.(state);
    log(`reanudando tarea '${state.title}' — fase ${state.phase}, workflow ${state.workflow}`);
  } else {
    const suggested = suggestWorkflow(input);
    const chosen = (await deps.prompter.choose(
      `Workflow para "${input.title}"`,
      ["directo", "estandar", "libre"],
      suggested,
    )) as WorkflowId;
    if (chosen === "libre") {
      throw new Error("workflow 'libre' aún no soportado por el orquestador");
    }
    state = createTask({
      title: input.title,
      workflow: chosen,
      workflow_suggested: suggested,
      project_id: input.project_id,
      session_id: input.session_id,
      ...(input.commands ? { commands: input.commands } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
    await saveTask(harnessDir, state);
    deps.onState?.(state);
    log(`tarea creada: workflow ${chosen} (sugerido: ${suggested}), fase ${state.phase}`);
  }

  // Artefactos y gates trabajan contra el directorio de ESTA tarea.
  const dir = taskDir(harnessDir, state.task_id);

  const persist = async (next: TaskState): Promise<TaskState> => {
    await saveTask(harnessDir, next);
    deps.onState?.(next);
    return next;
  };

  // Historia de la ronda actual. Se RESETEA al cruzar de fase: compactación
  // intencional — lo que sobrevive es el artefacto, no el transcript.
  let history: Msg[] = [];
  let prompt = `Iniciá la fase ${state.phase}.`;
  let roundsInPhase = 0;
  const maxRounds = deps.maxRoundsPerPhase ?? 10;

  const resetForPhase = (s: TaskState): void => {
    history = [];
    prompt = `Iniciá la fase ${s.phase}.`;
    roundsInPhase = 0;
  };

  // ── 2. bucle principal ────────────────────────────────────────────────────
  while (state.status === "active") {
    if (state.phase === null) {
      throw new Error(`workflow '${state.workflow}' sin fase activa`);
    }
    roundsInPhase += 1;
    if (roundsInPhase > maxRounds) {
      const goOn = await deps.prompter.confirm(
        `La fase ${state.phase} lleva ${maxRounds} rondas sin pasar el gate. ¿Seguir?`,
      );
      if (!goOn) return state;
      roundsInPhase = 1;
    }

    const wf = WORKFLOWS[state.workflow];
    const phase = state.phase;
    const artifacts = await loadArtifacts(dir, state);
    const system = assembleSystem({
      task: { title: state.title, description: input.description },
      workflow: wf,
      phase,
      artifacts,
      ...(deps.memoryContext ? { memoryContext: deps.memoryContext } : {}),
    });
    const tools = maskTools(
      [...deps.tools, flagDecisionTool()],
      toolsForPhase(wf, phase),
    );

    const outcome = await runTurns(prompt, {
      adapter: deps.adapter,
      tools,
      system,
      ...(deps.maxTokens ? { maxTokens: deps.maxTokens } : {}),
      ...(deps.effort ? { effort: deps.effort } : {}),
      ...(deps.maxTurnsPerRound ? { maxTurns: deps.maxTurnsPerRound } : {}),
      ...(deps.onEvent ? { onEvent: deps.onEvent } : {}),
    }, history);

    switch (outcome.kind) {
      case "agent_done": {
        const ctx = buildGateCtx(deps, dir, state);
        const result = await advance(state, gates, ctx, deps.now);
        switch (result.kind) {
          case "gate_failed": {
            log(`gate ${result.gate} rechazó: ${result.evidence}`);
            history = outcome.messages;
            prompt =
              `El gate '${result.gate}' rechazó la salida de la fase:\n${result.evidence}\n` +
              `Corregí y terminá tu turno de nuevo.`;
            break;
          }
          case "awaiting_human": {
            state = await persist(result.state);
            const planRaw = (await loadArtifacts(dir, state)).plan ?? "(sin plan)";
            log(`plan listo para aprobación:\n${planRaw}`);
            const plan = await readPlan(buildGateCtx(deps, dir, state));
            const scope = plan.ok ? plan.data.diff_scope : [];
            const ok = await deps.prompter.confirm(
              `¿Aprobar el plan y autorizar diff_scope [${scope.join(", ")}]?`,
            );
            if (ok) {
              state = await persist(approve(state, { diff_scope: scope }, deps.now));
              log(`plan aprobado — fase ${state.phase}, scope autorizado`);
              resetForPhase(state);
            } else {
              const reason = await deps.prompter.ask("Motivo del rechazo:");
              state = await persist(rejectPending(state, deps.now));
              history = outcome.messages;
              prompt = `El humano rechazó el plan: ${reason}\nRehacé el plan y terminá tu turno.`;
            }
            break;
          }
          case "advanced": {
            state = await persist(result.state);
            log(`gate OK — fase ${state.phase}`);
            resetForPhase(state);
            break;
          }
          case "task_complete": {
            state = await persist(result.state);
            log("tarea completa: todos los gates en verde");
            break;
          }
          case "no_machine":
            throw new Error("advance sin máquina: workflow sin fases");
        }
        break;
      }

      case "decision_flagged": {
        log(`decisión detectada en tarea '${state.workflow}': ${outcome.summary}`);
        const action = await deps.prompter.choose(
          `Apareció una decisión: "${outcome.summary}". ¿Qué hacemos?`,
          ["escalar", "resolver"],
          "escalar",
        );
        if (action === "escalar") {
          state = await persist(escalate(state, outcome.summary, deps.now));
          log(`escalado a estandar — entra por planning`);
          resetForPhase(state);
        } else {
          const answer = await deps.prompter.ask("Tu resolución en una línea:");
          history = outcome.messages;
          prompt = `El humano resolvió la decisión: ${answer}\nContinuá la tarea con eso.`;
        }
        break;
      }

      case "refusal":
        log("el modelo rechazó por seguridad — tarea pausada, revisala vos");
        return state;

      case "max_tokens": {
        history = outcome.messages;
        prompt = "Tu respuesta se cortó por límite de tokens. Continuá donde quedaste.";
        break;
      }

      case "turn_limit": {
        const goOn = await deps.prompter.confirm(
          "Se alcanzó el límite de turnos de la ronda. ¿Continuar?",
        );
        if (!goOn) return state;
        history = outcome.messages;
        prompt = "Continuá la tarea.";
        break;
      }
    }
  }

  return state;
}
