import { describe, expect, it } from "vitest";
import { z } from "zod";

import { runTurns, type LoopEvent } from "./loop.js";
import { defineTool, flagDecisionTool } from "./tools.js";
import type {
  Capabilities,
  GenerateRequest,
  GenerateResult,
  ModelAdapter,
} from "./types.js";

const CAPS: Capabilities = {
  contextWindow: 100_000,
  maxOutput: 10_000,
  parallelToolCalls: true,
  strictTools: false,
  promptCaching: "none",
  reasoning: "none",
};

function scripted(responses: GenerateResult[]): ModelAdapter & { requests: GenerateRequest[] } {
  const queue = [...responses];
  const requests: GenerateRequest[] = [];
  return {
    id: "fake:model",
    caps: CAPS,
    requests,
    async generate(req) {
      requests.push(req);
      const next = queue.shift();
      if (!next) throw new Error("scripted adapter agotado");
      return next;
    },
  };
}

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };

function ends(text: string): GenerateResult {
  return { text, toolCalls: [], stopReason: "end", usage };
}

function calls(...toolCalls: GenerateResult["toolCalls"]): GenerateResult {
  return { text: "", toolCalls, stopReason: "tool_use", usage };
}

const echoTool = defineTool({
  name: "echo",
  description: "repite",
  schema: z.object({ value: z.string() }),
  execute: ({ value }) => `eco:${value}`,
});

const bombTool = defineTool({
  name: "bomb",
  description: "explota",
  schema: z.object({}),
  execute: () => {
    throw new Error("kaboom");
  },
});

describe("runTurns", () => {
  it("ejecuta tools, agrupa TODOS los resultados en un mensaje y termina en end", async () => {
    const adapter = scripted([
      calls(
        { id: "c1", name: "echo", args: { value: "a" } },
        { id: "c2", name: "echo", args: { value: "b" } },
      ),
      ends("listo"),
    ]);
    const out = await runTurns("tarea", { adapter, tools: [echoTool], system: "s" });

    expect(out.kind).toBe("agent_done");
    if (out.kind !== "agent_done") return;
    expect(out.text).toBe("listo");

    // Segundo request: el historial incluye UN solo mensaje tool_results con ambos.
    const second = adapter.requests[1]!;
    const toolResults = second.messages.filter((m) => m.role === "tool_results");
    expect(toolResults).toHaveLength(1);
    if (toolResults[0]?.role !== "tool_results") return;
    expect(toolResults[0].results.map((r) => r.content)).toEqual(["eco:a", "eco:b"]);
  });

  it("tool desconocida y tool que explota → isError, y el loop sigue", async () => {
    const adapter = scripted([
      calls(
        { id: "c1", name: "fantasma", args: {} },
        { id: "c2", name: "bomb", args: {} },
      ),
      ends("ok"),
    ]);
    const out = await runTurns("t", { adapter, tools: [bombTool], system: "s" });
    expect(out.kind).toBe("agent_done");

    const results = adapter.requests[1]!.messages.find((m) => m.role === "tool_results");
    if (results?.role !== "tool_results") throw new Error("faltan resultados");
    expect(results.results[0]).toMatchObject({ isError: true });
    expect(results.results[0]!.content).toContain("no existe en esta fase");
    expect(results.results[1]).toMatchObject({ isError: true });
    expect(results.results[1]!.content).toContain("kaboom");
  });

  it("args inválidos NO ejecutan la tool: error con evidencia del schema", async () => {
    const adapter = scripted([
      calls({ id: "c1", name: "echo", args: { wrong: 1 } }),
      ends("ok"),
    ]);
    await runTurns("t", { adapter, tools: [echoTool], system: "s" });
    const results = adapter.requests[1]!.messages.find((m) => m.role === "tool_results");
    if (results?.role !== "tool_results") throw new Error("faltan resultados");
    expect(results.results[0]).toMatchObject({ isError: true });
    expect(results.results[0]!.content).toContain("args inválidos");
  });

  it("flag_decision_needed se intercepta y pausa: decision_flagged", async () => {
    const adapter = scripted([
      calls({
        id: "c1",
        name: "flag_decision_needed",
        args: { summary: "elegir pasarela: openpay vs stripe" },
      }),
    ]);
    const out = await runTurns("t", {
      adapter,
      tools: [flagDecisionTool()],
      system: "s",
    });
    expect(out).toMatchObject({
      kind: "decision_flagged",
      summary: "elegir pasarela: openpay vs stripe",
    });
  });

  it("refusal pausa sin ejecutar nada", async () => {
    const adapter = scripted([
      { text: "", toolCalls: [], stopReason: "refusal", usage },
    ]);
    const out = await runTurns("t", { adapter, tools: [], system: "s" });
    expect(out.kind).toBe("refusal");
  });

  it("maxTurns corta el loop", async () => {
    const loopy = calls({ id: "c", name: "echo", args: { value: "x" } });
    const adapter = scripted([loopy, loopy, loopy]);
    const out = await runTurns("t", {
      adapter,
      tools: [echoTool],
      system: "s",
      maxTurns: 3,
    });
    expect(out.kind).toBe("turn_limit");
  });

  it("el system y las tools llegan idénticos en cada request (prefijo estable)", async () => {
    const adapter = scripted([
      calls({ id: "c1", name: "echo", args: { value: "a" } }),
      ends("ok"),
    ]);
    await runTurns("t", { adapter, tools: [echoTool], system: "PREFIJO", effort: "high" });
    for (const req of adapter.requests) {
      expect(req.system).toBe("PREFIJO");
      expect(req.tools.map((d) => d.name)).toEqual(["echo"]);
      expect(req.effort).toBe("high");
    }
  });

  it("emite eventos en orden", async () => {
    const adapter = scripted([
      calls({ id: "c1", name: "echo", args: { value: "a" } }),
      ends("fin"),
    ]);
    const events: LoopEvent["type"][] = [];
    await runTurns("t", {
      adapter,
      tools: [echoTool],
      system: "s",
      onEvent: (e) => events.push(e.type),
    });
    expect(events).toEqual(["turn", "tool_call", "tool_result", "turn", "assistant"]);
  });
});
