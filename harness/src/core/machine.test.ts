import { describe, expect, it } from "vitest";

import type { Gate, GateContext, GateRegistry } from "./gates.js";
import { advance, approve, escalate, rejectPending, rollback } from "./machine.js";
import { createTask, type TaskState } from "./task.js";
import type { GateId } from "./workflow.js";

const NOW = () => "2026-08-24T12:00:00.000Z";

function task(workflow: "directo" | "estandar" | "libre"): TaskState {
  return createTask({
    title: "integrar openpay",
    workflow,
    workflow_suggested: workflow,
    project_id: "proj-1",
    session_id: "sess-1",
    now: NOW,
  });
}

function gateStub(results: Partial<Record<GateId, { pass: boolean; evidence?: string }>>): GateRegistry {
  const make = (id: GateId): Gate => ({
    id,
    async check() {
      const r = results[id] ?? { pass: true };
      return r.pass ? { pass: true } : { pass: false, evidence: r.evidence ?? "falló" };
    },
  });
  return {
    research_valida: make("research_valida"),
    plan_valida: make("plan_valida"),
    diff_en_scope_y_build_ok: make("diff_en_scope_y_build_ok"),
    tests_pass: make("tests_pass"),
  };
}

const ctx = {} as GateContext; // los stubs no lo usan

describe("advance", () => {
  it("libre no tiene máquina", async () => {
    const out = await advance(task("libre"), gateStub({}), ctx, NOW);
    expect(out.kind).toBe("no_machine");
  });

  it("gate que falla devuelve la evidencia y NO muta el estado", async () => {
    const t = task("estandar");
    const out = await advance(
      t,
      gateStub({ research_valida: { pass: false, evidence: "research.md no existe" } }),
      ctx,
      NOW,
    );
    expect(out).toEqual({
      kind: "gate_failed",
      gate: "research_valida",
      evidence: "research.md no existe",
    });
    expect(t.phase).toBe("exploration");
  });

  it("exploration→planning avanza solo (sin OK humano)", async () => {
    const out = await advance(task("estandar"), gateStub({}), ctx, NOW);
    expect(out.kind).toBe("advanced");
    if (out.kind !== "advanced") return;
    expect(out.to).toBe("planning");
    expect(out.state.phase).toBe("planning");
    expect(out.state.transitions.at(-1)).toMatchObject({
      from: "exploration",
      to: "planning",
      kind: "advance",
    });
  });

  it("planning→implementation exige OK humano: queda pending", async () => {
    let t = task("estandar");
    const a = await advance(t, gateStub({}), ctx, NOW);
    if (a.kind !== "advanced") throw new Error("esperaba advanced");
    t = a.state;

    const out = await advance(t, gateStub({}), ctx, NOW);
    expect(out.kind).toBe("awaiting_human");
    if (out.kind !== "awaiting_human") return;
    expect(out.to).toBe("implementation");
    expect(out.state.pending_transition).toBe("implementation");
    // La fase NO cambió: el agente sigue sin write tools.
    expect(out.state.phase).toBe("planning");
  });

  it("con pending, advance no re-corre el gate: sigue esperando", async () => {
    let t = task("estandar");
    t = (await advance(t, gateStub({}), ctx, NOW) as { state: TaskState }).state;
    t = (await advance(t, gateStub({}), ctx, NOW) as { state: TaskState }).state;

    // Aunque el gate ahora fallara, el pending manda.
    const out = await advance(
      t,
      gateStub({ plan_valida: { pass: false } }),
      ctx,
      NOW,
    );
    expect(out.kind).toBe("awaiting_human");
  });

  it("la última fase que pasa su gate completa la tarea", async () => {
    let t = task("directo"); // implementation → verification
    const a = await advance(t, gateStub({}), ctx, NOW);
    if (a.kind !== "advanced") throw new Error("esperaba advanced");
    t = a.state;
    expect(t.phase).toBe("verification");

    const out = await advance(t, gateStub({}), ctx, NOW);
    expect(out.kind).toBe("task_complete");
    if (out.kind !== "task_complete") return;
    expect(out.state.status).toBe("done");
  });
});

describe("approve / rejectPending", () => {
  async function pendingState(): Promise<TaskState> {
    let t = task("estandar");
    t = (await advance(t, gateStub({}), ctx, NOW) as { state: TaskState }).state;
    const out = await advance(t, gateStub({}), ctx, NOW);
    if (out.kind !== "awaiting_human") throw new Error("esperaba awaiting_human");
    return out.state;
  }

  it("approve aplica la transición y fija el diff_scope autorizado", async () => {
    const t = approve(await pendingState(), { diff_scope: ["src/payments/**"] }, NOW);
    expect(t.phase).toBe("implementation");
    expect(t.pending_transition).toBeNull();
    expect(t.diff_scope).toEqual(["src/payments/**"]);
  });

  it("approve sin pending es error", () => {
    expect(() => approve(task("estandar"), {}, NOW)).toThrow(/sin transición pendiente/);
  });

  it("rejectPending limpia y se queda en la fase", async () => {
    const t = rejectPending(await pendingState(), NOW);
    expect(t.phase).toBe("planning");
    expect(t.pending_transition).toBeNull();
  });
});

describe("rollback", () => {
  it("solo hacia atrás, con razón, y mata el diff_scope pre-implementation", async () => {
    let t = task("estandar");
    t = (await advance(t, gateStub({}), ctx, NOW) as { state: TaskState }).state;
    t = approve(
      (await advance(t, gateStub({}), ctx, NOW) as { state: TaskState }).state,
      { diff_scope: ["src/**"] },
      NOW,
    );
    expect(t.phase).toBe("implementation");

    const back = rollback(t, "planning", "el plan asumía un API que no existe", NOW);
    expect(back.phase).toBe("planning");
    expect(back.diff_scope).toBeNull();
    expect(back.transitions.at(-1)).toMatchObject({
      kind: "rollback",
      reason: "el plan asumía un API que no existe",
    });
  });

  it("retroceder hacia adelante es error", async () => {
    const t = task("estandar");
    expect(() => rollback(t, "implementation", "x", NOW)).toThrow(/rollback inválido/);
  });
});

describe("escalate", () => {
  it("directo escala a estandar entrando por planning", () => {
    const t = escalate(task("directo"), "surgió elección de pasarela de pago", NOW);
    expect(t.workflow).toBe("estandar");
    expect(t.phase).toBe("planning");
    expect(t.escalations).toHaveLength(1);
    expect(t.escalations[0]).toMatchObject({ from: "directo", to: "estandar" });
  });

  it("estandar y libre no escalan", () => {
    expect(() => escalate(task("estandar"), "x", NOW)).toThrow(/escalada inválida/);
    expect(() => escalate(task("libre"), "x", NOW)).toThrow(/escalada inválida/);
  });
});
