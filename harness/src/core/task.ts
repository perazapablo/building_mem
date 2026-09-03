// TaskState: el estado de CONTROL de una tarea — .harness/state.json en el
// repo del proyecto target. Gobierna qué puede pasar (fase, scope, pendientes);
// la bitácora de sesión (harness/state/<session>.json) es otra cosa: observa.
// El alcance es por TAREA, no por sesión: una tarea atraviesa sesiones.

import { randomUUID } from "node:crypto";
import { z } from "zod";

import { PHASES, WORKFLOW_IDS, WORKFLOWS, type WorkflowId } from "./workflow.js";

/** Nombres reservados de Windows: un directorio así no se puede crear. */
const RESERVADOS = new Set([
  "con", "prn", "aux", "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/**
 * Título → identificador legible, que ADEMÁS es el nombre del directorio de la
 * tarea (`.harness/tasks/<task_id>/`).
 *
 * Antes el id era un randomUUID: correcto pero ilegible. Con varias tareas
 * conviviendo, elegir cuál gobierna la sesión significaba mirar una lista de
 * UUIDs y adivinar — justo el caso que el harness multi-agente vuelve
 * frecuente. Como `use` matchea por prefijo, un id slug hace que
 * `use openpay` funcione.
 *
 * Solo [a-z0-9-]: seguro en cualquier filesystem, sin escapes ni sorpresas.
 */
export function slugifyTitle(title: string, maxLen = 60): string {
  const base = String(title ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // acentos: á→a, ñ→n
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!base) return "tarea";

  let s = base;
  if (s.length > maxLen) {
    const corte = s.slice(0, maxLen);
    const guion = corte.lastIndexOf("-");
    // Cortar en frontera de palabra, salvo que eso deje casi nada.
    s = (guion > maxLen * 0.5 ? corte.slice(0, guion) : corte).replace(/-+$/, "");
    // Un corte por longitud suele dejar colgando artículos y preposiciones
    // ("…-calendario-no-el"). No aportan nada y ensucian la lectura, que es
    // justo lo único que este id tiene que dar.
    let previo: string;
    do {
      previo = s;
      s = s.replace(VACIAS_FINALES, "");
    } while (s !== previo && s.includes("-"));
  }
  return RESERVADOS.has(s) || !s ? `${s || "tarea"}-tarea`.replace(/^tarea-tarea$/, "tarea") : s;
}

/** Palabras que no aportan nada colgando al final de un slug truncado. */
const VACIAS_FINALES =
  /-(?:el|la|los|las|un|una|unos|unas|de|del|y|o|en|a|al|que|no|si|con|por|para|se|su|sus|lo|es|the|of|and|to|in|for|on)$/;

const PhaseEnum = z.enum(PHASES);
const WorkflowEnum = z.enum(WORKFLOW_IDS);

/**
 * Una ampliación del contrato original de la tarea. Append-only: es el
 * registro de por qué el diff final no coincide con el plan aprobado.
 * Lo escribe phase-post.cjs cuando un `ask` del gate terminó en escritura —
 * o sea cuando el humano concedió el archivo en el momento, sin rollback.
 */
const ScopeAmendmentSchema = z.object({
  path: z.string().min(1),
  /** out_of_scope amplía el scope efectivo; early_write y plan_amend NO:
   *  esos solo dejan constancia de que se salteó el orden de fases. */
  kind: z.enum(["out_of_scope", "early_write", "plan_amend"]),
  phase: PhaseEnum.nullable(),
  at: z.string(),
  session_id: z.string().nullable().default(null),
  // Literal: una enmienda que el agente se auto-concede no es representable.
  approved_by: z.literal("human"),
  reason: z.string().nullable().default(null),
});

export type ScopeAmendment = z.infer<typeof ScopeAmendmentSchema>;

const TransitionSchema = z.object({
  from: z.string().nullable(),
  to: z.string(),
  at: z.string(),
  kind: z.enum(["advance", "rollback", "escalation"]),
  reason: z.string().optional(),
});

export const TaskStateSchema = z.object({
  task_id: z.string().min(1),
  title: z.string().min(1),

  workflow: WorkflowEnum,
  workflow_suggested: WorkflowEnum,
  // Literal: el estado "el modelo eligió su propio rigor" no es representable.
  workflow_chosen_by: z.literal("human"),

  status: z.enum(["active", "done"]).default("active"),
  phase: PhaseEnum.nullable(),
  phase_entered_at: z.string(),
  /** Gate pasado, esperando OK humano para entrar a esta fase. */
  pending_transition: PhaseEnum.nullable().default(null),

  artifacts: z
    .object({
      research: z.string().optional(),
      plan: z.string().optional(),
    })
    .default({}),
  /** Se llena al aprobar el plan; null en directo/libre. */
  diff_scope: z.array(z.string()).nullable().default(null),
  /** Ampliaciones concedidas por el humano DURANTE la ejecución. El default
   *  vacío mantiene parseables los state.json anteriores a este campo. */
  scope_amendments: z.array(ScopeAmendmentSchema).default([]),
  /** Comandos del proyecto target; los gates los ejecutan y leen exit codes. */
  commands: z
    .object({
      build: z.string().optional(),
      test: z.string().optional(),
    })
    .default({}),

  escalations: z
    .array(
      z.object({
        from: WorkflowEnum,
        to: WorkflowEnum,
        at: z.string(),
        reason: z.string(),
      }),
    )
    .default([]),
  transitions: z.array(TransitionSchema).default([]),

  project_id: z.string().min(1),
  session_ids: z.array(z.string()).default([]),

  // ISO 8601 con Z siempre — nada de "YYYY-MM-DD HH:MM:SS" ambiguo.
  created_at: z.string(),
  updated_at: z.string(),
});

export type TaskState = z.infer<typeof TaskStateSchema>;

export interface CreateTaskInput {
  title: string;
  workflow: WorkflowId;
  workflow_suggested: WorkflowId;
  project_id: string;
  session_id: string;
  task_id?: string;
  commands?: { build?: string; test?: string };
  now?: () => string;
}

export function createTask(input: CreateTaskInput): TaskState {
  const now = input.now ?? (() => new Date().toISOString());
  const at = now();
  const firstPhase = WORKFLOWS[input.workflow].phases[0] ?? null;
  return TaskStateSchema.parse({
    // El id ES el nombre del directorio: legible por diseño. El caller puede
    // pasar uno ya resuelto contra el store (ver uniqueTaskId) para no colisionar.
    task_id: input.task_id ?? slugifyTitle(input.title),
    title: input.title,
    workflow: input.workflow,
    workflow_suggested: input.workflow_suggested,
    workflow_chosen_by: "human",
    status: "active",
    phase: firstPhase,
    phase_entered_at: at,
    pending_transition: null,
    // Los paths que los gates van a validar; write_artifact escribe acá.
    artifacts:
      input.workflow === "estandar"
        ? { research: "research.md", plan: "plan.md" }
        : {},
    diff_scope: null,
    scope_amendments: [],
    commands: input.commands ?? {},
    escalations: [],
    transitions: firstPhase
      ? [{ from: null, to: firstPhase, at, kind: "advance" as const }]
      : [],
    project_id: input.project_id,
    session_ids: [input.session_id],
    created_at: at,
    updated_at: at,
  });
}
