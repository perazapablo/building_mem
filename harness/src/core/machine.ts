// La máquina de fases: ejecuta el grafo del workflow sobre TaskState.
// Funciones puras estado→estado — la IO (persistir state.json, preguntar al
// humano, correr comandos) vive en el loop. "Listo, paso a implementar" dicho
// por el agente es una SOLICITUD: la transición ocurre acá, tras gate.

import type { GateContext, GateRegistry } from "./gates.js";
import type { TaskState } from "./task.js";
import { canEscalate, WORKFLOWS, type GateId, type Phase } from "./workflow.js";

export type AdvanceOutcome =
  | { kind: "no_machine" } // libre: sin fases, sin gates
  | { kind: "gate_failed"; gate: GateId; evidence: string }
  | { kind: "awaiting_human"; to: Phase; state: TaskState } // gate OK, falta tu OK
  | { kind: "advanced"; to: Phase; state: TaskState }
  | { kind: "task_complete"; state: TaskState };

type Now = () => string;
const isoNow: Now = () => new Date().toISOString();

function withTransition(
  state: TaskState,
  to: Phase | "done",
  kind: "advance" | "rollback" | "escalation",
  at: string,
  reason?: string,
): TaskState {
  return {
    ...state,
    transitions: [
      ...state.transitions,
      { from: state.phase, to, at, kind, ...(reason ? { reason } : {}) },
    ],
    updated_at: at,
  };
}

/**
 * Corre el gate de salida de la fase actual y avanza si corresponde.
 * Frontera con humanApproval → deja pending_transition y espera approve().
 */
export async function advance(
  state: TaskState,
  gates: GateRegistry,
  ctx: GateContext,
  now: Now = isoNow,
): Promise<AdvanceOutcome> {
  const wf = WORKFLOWS[state.workflow];
  if (!wf.phases.length) return { kind: "no_machine" };
  if (state.status === "done") return { kind: "task_complete", state };
  if (state.phase === null) return { kind: "no_machine" };
  if (state.pending_transition) {
    // Ya hay un gate pasado esperando OK: no se re-corre, se espera al humano.
    return { kind: "awaiting_human", to: state.pending_transition, state };
  }

  const gateId = wf.exitGates[state.phase];
  if (gateId) {
    const result = await gates[gateId].check(ctx);
    if (!result.pass) {
      return { kind: "gate_failed", gate: gateId, evidence: result.evidence };
    }
  }

  const at = now();
  const idx = wf.phases.indexOf(state.phase);
  const next = wf.phases[idx + 1];

  if (next === undefined) {
    const done: TaskState = {
      ...withTransition(state, "done", "advance", at),
      status: "done",
    };
    return { kind: "task_complete", state: done };
  }

  if (wf.humanApproval.includes(state.phase)) {
    const pending: TaskState = { ...state, pending_transition: next, updated_at: at };
    return { kind: "awaiting_human", to: next, state: pending };
  }

  const advanced: TaskState = {
    ...withTransition(state, next, "advance", at),
    phase: next,
    phase_entered_at: at,
    pending_transition: null,
  };
  return { kind: "advanced", to: next, state: advanced };
}

/**
 * Aplica la transición pendiente tras el OK humano. En planning→implementation
 * el loop pasa el diff_scope leído del plan aprobado — es el momento donde se
 * autoriza qué archivos puede tocar el agente.
 */
export function approve(
  state: TaskState,
  extras: { diff_scope?: string[] } = {},
  now: Now = isoNow,
): TaskState {
  if (!state.pending_transition) {
    throw new Error("approve() sin transición pendiente");
  }
  const at = now();
  const to = state.pending_transition;
  return {
    ...withTransition(state, to, "advance", at),
    phase: to,
    phase_entered_at: at,
    pending_transition: null,
    ...(extras.diff_scope ? { diff_scope: extras.diff_scope } : {}),
  };
}

/** El humano rechazó (ej: el plan no convence): se limpia y se sigue en la fase. */
export function rejectPending(state: TaskState, now: Now = isoNow): TaskState {
  if (!state.pending_transition) return state;
  return { ...state, pending_transition: null, updated_at: now() };
}

/**
 * Retroceso: SIEMPRE decisión humana — el loop solo llama esto tras un OK
 * explícito. Un agente que se auto-concede replanificar entra en loops.
 */
export function rollback(
  state: TaskState,
  to: Phase,
  reason: string,
  now: Now = isoNow,
): TaskState {
  const wf = WORKFLOWS[state.workflow];
  if (state.phase === null) throw new Error("rollback en workflow sin fases");
  const fromIdx = wf.phases.indexOf(state.phase);
  const toIdx = wf.phases.indexOf(to);
  if (toIdx === -1 || toIdx >= fromIdx) {
    throw new Error(`rollback inválido: ${state.phase} → ${to}`);
  }
  const at = now();
  const killsScope = toIdx < wf.phases.indexOf("implementation");
  return {
    ...withTransition(state, to, "rollback", at, reason),
    phase: to,
    phase_entered_at: at,
    pending_transition: null,
    // El scope aprobado muere con el plan que lo declaró — y con él las
    // enmiendas, que autorizaban archivos de un plan que ya no rige.
    diff_scope: killsScope ? null : state.diff_scope,
    scope_amendments: killsScope ? [] : state.scope_amendments,
  };
}

/**
 * Escalada directo→estandar: surgió una decisión en una tarea "directa" —
 * la tarea estaba mal clasificada. Entra por planning. Solo hacia arriba.
 */
export function escalate(state: TaskState, reason: string, now: Now = isoNow): TaskState {
  if (!canEscalate(state.workflow, "estandar")) {
    throw new Error(`escalada inválida desde workflow '${state.workflow}'`);
  }
  const at = now();
  return {
    ...state,
    workflow: "estandar",
    phase: "planning",
    phase_entered_at: at,
    pending_transition: null,
    escalations: [
      ...state.escalations,
      { from: state.workflow, to: "estandar", at, reason },
    ],
    transitions: [
      ...state.transitions,
      { from: state.phase, to: "planning", at, kind: "escalation", reason },
    ],
    updated_at: at,
  };
}
