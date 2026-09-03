import { describe, expect, it } from "vitest";

import { assembleSystem, type AssembleInput } from "./assembler.js";
import { WORKFLOWS } from "./workflow.js";

function input(overrides: Partial<AssembleInput> = {}): AssembleInput {
  return {
    task: { title: "integrar openpay", description: "cargos con tarjeta, fase 1" },
    workflow: WORKFLOWS.estandar,
    phase: "planning",
    artifacts: { research: "---\ngoal: entender openpay\n---\nhallazgos..." },
    ...overrides,
  };
}

describe("assembleSystem", () => {
  it("es determinista: mismo input, mismos bytes", () => {
    expect(assembleSystem(input())).toBe(assembleSystem(input()));
  });

  it("no contiene nada volátil (fechas, horas)", () => {
    const out = assembleSystem(input());
    expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(out).not.toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it("cada fase lleva su contrato", () => {
    expect(assembleSystem(input({ phase: "exploration", artifacts: {} }))).toContain(
      "FASE: exploration",
    );
    expect(assembleSystem(input())).toContain("FASE: planning");
    expect(assembleSystem(input({ phase: "implementation" }))).toContain("diff_scope aprobado");
  });

  it("planning hereda el research; exploration arranca limpio", () => {
    expect(assembleSystem(input())).toContain("Artefacto heredado: research");
    expect(assembleSystem(input())).toContain("entender openpay");

    const clean = assembleSystem(
      input({ phase: "exploration", artifacts: { research: "no debería verse" } }),
    );
    expect(clean).not.toContain("Artefacto heredado");
  });

  it("verification ve el plan pero no el research", () => {
    const out = assembleSystem(
      input({
        phase: "verification",
        artifacts: { research: "RESEARCH_X", plan: "PLAN_Y" },
      }),
    );
    expect(out).toContain("PLAN_Y");
    expect(out).not.toContain("RESEARCH_X");
  });

  it("la memoria entra como sección con la regla código-gana", () => {
    const out = assembleSystem(input({ memoryContext: "decisión vigente: charges API" }));
    expect(out).toContain("Memoria del proyecto");
    expect(out).toContain("el código gana");
    expect(out).toContain("charges API");
    // sin memoria, la sección no existe (nada de secciones vacías inestables)
    expect(assembleSystem(input())).not.toContain("Memoria del proyecto");
  });

  it("el orden de secciones es fijo: harness → fase → artefactos → memoria → tarea", () => {
    const out = assembleSystem(input({ memoryContext: "m" }));
    const order = ["## Harness", "## Fase actual", "## Artefacto heredado", "## Memoria", "## Tarea"];
    const positions = order.map((h) => out.indexOf(h));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});
