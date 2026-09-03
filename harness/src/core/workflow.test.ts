import { describe, expect, it } from "vitest";

import { canEscalate, toolsForPhase, WORKFLOWS } from "./workflow.js";

describe("invariantes de los workflows", () => {
  it("todo workflow con fases termina en verification con gate tests_pass", () => {
    for (const wf of Object.values(WORKFLOWS)) {
      if (!wf.phases.length) continue;
      expect(wf.phases.at(-1)).toBe("verification");
      expect(wf.exitGates.verification).toBe("tests_pass");
    }
  });

  it("directo no captura decisiones; estandar captura en planning e implementation", () => {
    expect(WORKFLOWS.directo.decisionCapture).toEqual([]);
    expect(WORKFLOWS.estandar.decisionCapture).toEqual(["planning", "implementation"]);
  });

  it("el único OK humano de estandar es la salida de planning", () => {
    expect(WORKFLOWS.estandar.humanApproval).toEqual(["planning"]);
    expect(WORKFLOWS.directo.humanApproval).toEqual([]);
  });
});

describe("toolsForPhase", () => {
  it("en directo, implementation no tiene decision_record pero sí flag_decision_needed", () => {
    const tools = toolsForPhase(WORKFLOWS.directo, "implementation");
    expect(tools).not.toContain("decision_record");
    expect(tools).toContain("flag_decision_needed");
    expect(tools).toContain("write_file");
  });

  it("en estandar, planning tiene decision_record y write_artifact pero NO write_file", () => {
    const tools = toolsForPhase(WORKFLOWS.estandar, "planning");
    expect(tools).toContain("decision_record");
    expect(tools).toContain("write_artifact");
    expect(tools).not.toContain("write_file");
    expect(tools).not.toContain("run_command");
  });

  it("en estandar, exploration no toca código: solo lectura + su artefacto", () => {
    const tools = toolsForPhase(WORKFLOWS.estandar, "exploration");
    expect(tools).not.toContain("write_file");
    expect(tools).not.toContain("run_command");
    expect(tools).toContain("write_artifact");
    expect(tools).toContain("read_file");
  });
});

describe("canEscalate", () => {
  it("solo directo→estandar", () => {
    expect(canEscalate("directo", "estandar")).toBe(true);
    expect(canEscalate("estandar", "directo")).toBe(false);
    expect(canEscalate("libre", "estandar")).toBe(false);
    expect(canEscalate("directo", "libre")).toBe(false);
  });
});
