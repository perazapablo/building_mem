// La capa de workflow: un grafo declarativo de fases que la máquina ejecuta.
// El workflow es DATA — decidido en harness.workflows y harness.transiciones-fase:
// {directo, estandar, libre}, humano elige, escalada solo hacia arriba,
// transiciones híbridas asimétricas (OK humano solo donde se gana escritura).

export const PHASES = [
  "exploration",
  "planning",
  "implementation",
  "verification",
] as const;
export type Phase = (typeof PHASES)[number];

export const WORKFLOW_IDS = ["directo", "estandar", "libre"] as const;
export type WorkflowId = (typeof WORKFLOW_IDS)[number];

export type GateId =
  | "research_valida"
  | "plan_valida"
  | "diff_en_scope_y_build_ok"
  | "tests_pass";

export interface WorkflowDef {
  id: WorkflowId;
  /** Orden lineal del grafo. Vacío = sin máquina (libre). */
  phases: Phase[];
  /** Condición verificable para SALIR de cada fase. Sin gate = avanza libre. */
  exitGates: Partial<Record<Phase, GateId>>;
  /** Salir de estas fases pausa y espera OK humano. */
  humanApproval: Phase[];
  /** Fases donde decision_record está disponible en PHASE_TOOLS. */
  decisionCapture: Phase[];
}

export const WORKFLOWS: Record<WorkflowId, WorkflowDef> = {
  directo: {
    id: "directo",
    phases: ["implementation", "verification"],
    exitGates: {
      implementation: "diff_en_scope_y_build_ok",
      verification: "tests_pass",
    },
    humanApproval: [],
    // Sin decision_record: su ausencia ES el detector de escalada — el agente
    // usa flag_decision_needed y el harness ofrece subir a estandar.
    decisionCapture: [],
  },
  estandar: {
    id: "estandar",
    phases: ["exploration", "planning", "implementation", "verification"],
    exitGates: {
      exploration: "research_valida",
      planning: "plan_valida",
      implementation: "diff_en_scope_y_build_ok",
      verification: "tests_pass",
    },
    // La única frontera donde el agente gana poder de escritura:
    // al aprobar el plan se autoriza el diff_scope.
    humanApproval: ["planning"],
    decisionCapture: ["planning", "implementation"],
  },
  libre: {
    id: "libre",
    phases: [],
    exitGates: {},
    humanApproval: [],
    decisionCapture: [],
  },
};

// ── PHASE_TOOLS ─────────────────────────────────────────────────────────────
// Enmascara el registro de tools por fase: la tool que no está en la lista no
// existe en el request — no hay tentación que resistir. Nivel 3 de enforcement.

const READ_ONLY = [
  "read_file",
  "grep",
  "list_dir",
  "search_all",
  "context_for_topic",
] as const;

// write_artifact escribe SOLO en .harness/ (research/plan según fase) — es el
// output de la fase, no acceso al código. write_file (código real) recién en
// implementation, y con diff_scope enforced dentro de la tool.
export const PHASE_TOOLS: Record<Phase, readonly string[]> = {
  exploration: [...READ_ONLY, "write_artifact"],
  planning: [...READ_ONLY, "write_artifact", "decision_record"],
  implementation: [...READ_ONLY, "decision_record", "write_file", "run_command"],
  // write_file también acá: "arreglar lo necesario para que pasen los tests"
  // exige escribir — sigue acotado por diff_scope dentro de la tool.
  verification: [...READ_ONLY, "write_file", "run_command"],
};

/** Tools extra según workflow: directo cambia el registro de captura. */
export function toolsForPhase(workflow: WorkflowDef, phase: Phase): string[] {
  const base = [...PHASE_TOOLS[phase]];
  if (!workflow.decisionCapture.includes(phase)) {
    const masked = base.filter((t) => t !== "decision_record");
    // El escape hatch reemplaza al registro donde la captura no está habilitada.
    return [...masked, "flag_decision_needed"];
  }
  return base;
}

/** Escalada válida: solo hacia arriba, y libre no participa. */
export function canEscalate(from: WorkflowId, to: WorkflowId): boolean {
  return from === "directo" && to === "estandar";
}
