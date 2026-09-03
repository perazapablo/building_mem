import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runTask, suggestWorkflow, type Prompter } from "./orchestrator.js";
import { createLocalTools } from "../tools/local.js";
import type { TaskState } from "./task.js";
import type {
  Capabilities,
  GenerateRequest,
  GenerateResult,
  ModelAdapter,
} from "./types.js";

const NOW = () => "2026-08-24T12:00:00.000Z";
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
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
      // snapshot: el loop sigue mutando el array messages después del call
      requests.push({ ...req, messages: [...req.messages] });
      const next = queue.shift();
      if (!next) throw new Error(`scripted adapter agotado en request #${requests.length}`);
      return next;
    },
  };
}

function ends(text: string): GenerateResult {
  return { text, toolCalls: [], stopReason: "end", usage };
}
function calls(...toolCalls: GenerateResult["toolCalls"]): GenerateResult {
  return { text: "", toolCalls, stopReason: "tool_use", usage };
}

function prompterStub(script: {
  choose?: string[];
  confirm?: boolean[];
  ask?: string[];
}): Prompter {
  const choose = [...(script.choose ?? [])];
  const confirm = [...(script.confirm ?? [])];
  const ask = [...(script.ask ?? [])];
  return {
    async choose(_q, _o, suggested) {
      return choose.shift() ?? suggested;
    },
    async confirm() {
      return confirm.shift() ?? true;
    },
    async ask() {
      return ask.shift() ?? "";
    },
  };
}

const RESEARCH = `---
goal: entender el flujo de pago
findings:
  - openpay expone charges API
---
detalle del research
`;

const PLAN = `---
diff_scope:
  - src/**
verification_criteria:
  - npm test
steps:
  - crear módulo de pago
---
prosa del plan
`;

let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), "harness-orq-"));
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

interface RunOptions {
  adapter: ModelAdapter;
  prompter: Prompter;
  execResults?: Record<string, { exitCode: number; output: string }>;
}

async function run(options: RunOptions): Promise<{ state: TaskState; executed: string[] }> {
  const executed: string[] = [];
  let live: TaskState | null = null;
  const tools = createLocalTools({
    projectDir,
    harnessDir: path.join(projectDir, ".harness"),
    getState: () => {
      if (!live) throw new Error("estado aún no inicializado");
      return live;
    },
  });
  const state = await runTask(
    {
      title: "integrar openpay",
      description: "cargos con tarjeta guardada, fase 1",
      project_id: "proj-1",
      session_id: "sess-1",
      commands: { test: "npm test" },
    },
    {
      adapter: options.adapter,
      prompter: options.prompter,
      projectDir,
      tools,
      exec: async (cmd) => {
        executed.push(cmd);
        return options.execResults?.[cmd] ?? { exitCode: 0, output: "" };
      },
      onState: (s) => {
        live = s;
      },
      now: NOW,
    },
  );
  return { state, executed };
}

describe("runTask — flujo estandar completo", () => {
  it("exploration → planning → OK humano con diff_scope → implementation → verification → done", async () => {
    const adapter = scripted([
      // exploration
      calls({ id: "c1", name: "write_artifact", args: { artifact: "research", content: RESEARCH } }),
      ends("research listo"),
      // planning
      calls({ id: "c2", name: "write_artifact", args: { artifact: "plan", content: PLAN } }),
      ends("plan listo"),
      // implementation (tras approve)
      calls({ id: "c3", name: "write_file", args: { path: "src/pago.ts", content: "export const pago = 1;" } }),
      ends("implementado"),
      // verification
      ends("a verificar"),
    ]);

    const { state, executed } = await run({
      adapter,
      prompter: prompterStub({ choose: ["estandar"], confirm: [true] }),
      execResults: {
        "git status --porcelain": { exitCode: 0, output: "?? src/pago.ts\n" },
        "npm test": { exitCode: 0, output: "" },
      },
    });

    expect(state.status).toBe("done");
    expect(state.diff_scope).toEqual(["src/**"]); // copiado del plan al aprobar
    expect(state.transitions.map((t) => `${t.from}→${t.to}`)).toEqual([
      "null→exploration",
      "exploration→planning",
      "planning→implementation",
      "implementation→verification",
      "verification→done",
    ]);

    // el código quedó escrito y los tests del plan corrieron de verdad
    expect(await readFile(path.join(projectDir, "src/pago.ts"), "utf8")).toContain("pago");
    expect(executed).toContain("npm test");

    // compactación: al entrar a planning la conversación arrancó limpia
    // (request de planning = system nuevo + 1 solo user message)
    const planningReq = adapter.requests[2]!;
    expect(planningReq.system).toContain("FASE: planning");
    expect(planningReq.system).toContain("entender el flujo de pago"); // research heredado
    expect(planningReq.messages).toHaveLength(1);

    // enmascarado real por fase: exploration sin write_file; implementation con él
    expect(adapter.requests[0]!.tools.map((t) => t.name)).not.toContain("write_file");
    expect(adapter.requests[4]!.tools.map((t) => t.name)).toContain("write_file");
  });

  it("gate rechaza → la evidencia vuelve al agente como feedback en la MISMA conversación", async () => {
    const adapter = scripted([
      ends("terminé sin escribir el research"), // gate research_valida va a fallar
      calls({ id: "c1", name: "write_artifact", args: { artifact: "research", content: RESEARCH } }),
      ends("ahora sí"),
      // planning: pausa vía refusal para cortar el test acá
      { text: "", toolCalls: [], stopReason: "refusal", usage },
    ]);

    const { state } = await run({
      adapter,
      prompter: prompterStub({ choose: ["estandar"] }),
    });

    // el feedback llegó con la evidencia del gate y la historia previa intacta
    const feedbackReq = adapter.requests[1]!;
    const lastUser = feedbackReq.messages.at(-1)!;
    expect(lastUser.role).toBe("user");
    if (lastUser.role !== "user") return;
    expect(lastUser.content).toContain("research_valida");
    expect(lastUser.content).toContain("no existe");
    expect(feedbackReq.messages.length).toBeGreaterThan(1);

    // tras corregir, avanzó a planning y quedó pausada por el refusal
    expect(state.phase).toBe("planning");
    expect(state.status).toBe("active");
  });

  it("plan rechazado por el humano vuelve con el motivo; aprobado a la segunda", async () => {
    const adapter = scripted([
      calls({ id: "c1", name: "write_artifact", args: { artifact: "research", content: RESEARCH } }),
      ends("research listo"),
      calls({ id: "c2", name: "write_artifact", args: { artifact: "plan", content: PLAN } }),
      ends("plan v1"),
      calls({ id: "c3", name: "write_artifact", args: { artifact: "plan", content: PLAN } }),
      ends("plan v2"),
      ends("implementación vacía"),
      ends("a verificar"),
    ]);

    const { state } = await run({
      adapter,
      prompter: prompterStub({
        choose: ["estandar"],
        confirm: [false, true], // rechaza el v1, aprueba el v2
        ask: ["faltan los reintentos de cobro"],
      }),
      execResults: {
        "git status --porcelain": { exitCode: 0, output: "" },
        "npm test": { exitCode: 0, output: "" },
      },
    });

    // el motivo humano llegó al agente
    const retryReq = adapter.requests[4]!;
    const lastUser = retryReq.messages.at(-1)!;
    if (lastUser.role !== "user") throw new Error("esperaba user");
    expect(lastUser.content).toContain("faltan los reintentos de cobro");

    expect(state.status).toBe("done");
  });
});

describe("suggestWorkflow", () => {
  it("typo/rename sugiere directo; lo demás estandar", () => {
    const base = { description: "", project_id: "p", session_id: "s" };
    expect(suggestWorkflow({ ...base, title: "fix typo en README" })).toBe("directo");
    expect(suggestWorkflow({ ...base, title: "integrar openpay" })).toBe("estandar");
  });
});
