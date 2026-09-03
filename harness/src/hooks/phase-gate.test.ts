// El hook es CJS standalone (corre sin build); se testea importando decide().
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require_ = createRequire(import.meta.url);
const { decide, decideAmbiguous, resolveTask, inScope } = require_("../../phase-gate.cjs") as {
  decide: (
    state: Record<string, unknown> | null,
    root: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    taskDir?: string,
  ) => { allow: boolean; mode?: "ask" | "deny"; reason?: string };
  decideAmbiguous: (
    candidates: Record<string, unknown>[],
    toolName: string,
  ) => { allow: boolean; mode?: "ask" | "deny"; reason?: string };
  resolveTask: (
    harnessDir: string,
    sessionId?: string,
  ) =>
    | { kind: "none" }
    | { kind: "task"; state: Record<string, unknown>; dir: string }
    | { kind: "ambiguous"; candidates: Record<string, unknown>[] };
  inScope: (file: string, scope: string[]) => boolean;
};

const ROOT = "C:/proj";
const TASK = ".harness/tasks/t1";

function state(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task_id: "t1",
    title: "tarea de prueba",
    status: "active",
    workflow: "estandar",
    phase: "exploration",
    artifacts: { research: "research.md", plan: "plan.md" },
    diff_scope: null,
    session_ids: [],
    ...overrides,
  };
}

describe("decide — escrituras de código", () => {
  it("exploration y planning PREGUNTAN por código, con guía (no denegan)", () => {
    const r = decide(state(), ROOT, "Write", { file_path: "C:/proj/src/a.ts" });
    expect(r.allow).toBe(false);
    // ask, no deny: escribir código antes de tiempo puede ser un cambio chico
    // legítimo. Denegarlo costaba un turno entero para algo que el humano
    // resuelve con un sí.
    expect(r.mode).toBe("ask");
    expect(r.reason).toContain("todavía no toca escribir código");
    // La guía apunta al artefacto DE ESA TAREA, no a un .harness/ plano.
    expect(r.reason).toContain(`${TASK}/research.md`);

    const p = decide(state({ phase: "planning" }), ROOT, "Edit", {
      file_path: "C:/proj/src/a.ts",
    });
    expect(p.allow).toBe(false);
    expect(p.mode).toBe("ask");
  });

  it("implementation permite dentro del diff_scope y bloquea afuera", () => {
    const s = state({ phase: "implementation", diff_scope: ["src/payments/**"] });
    expect(decide(s, ROOT, "Write", { file_path: "C:/proj/src/payments/o.ts" }).allow).toBe(true);
    const out = decide(s, ROOT, "Write", { file_path: "C:/proj/src/core/hack.ts" });
    expect(out.allow).toBe(false);
    expect(out.mode).toBe("ask");
    expect(out.reason).toContain("diff_scope");
    // La salida NO es el rollback: se aprueba en el momento y queda registrado.
    expect(out.reason).toContain("scope_amendments");
  });

  it("una enmienda aprobada amplía el scope: el mismo archivo deja de preguntar", () => {
    const s = state({
      phase: "implementation",
      diff_scope: ["src/payments/**"],
      scope_amendments: [
        { path: "src/core/hack.ts", kind: "out_of_scope", approved_by: "human" },
      ],
    });
    expect(decide(s, ROOT, "Write", { file_path: "C:/proj/src/core/hack.ts" }).allow).toBe(true);
    // Pero no abre el resto del árbol.
    expect(decide(s, ROOT, "Write", { file_path: "C:/proj/src/core/otro.ts" }).allow).toBe(false);
  });

  it("early_write no amplía el scope: solo deja constancia", () => {
    const s = state({
      phase: "implementation",
      diff_scope: ["src/payments/**"],
      scope_amendments: [
        { path: "src/core/hack.ts", kind: "early_write", approved_by: "human" },
      ],
    });
    expect(decide(s, ROOT, "Write", { file_path: "C:/proj/src/core/hack.ts" }).allow).toBe(false);
  });

  it("sin diff_scope (directo) implementation escribe libre; verification también escribe", () => {
    const s = state({ workflow: "directo", phase: "implementation", artifacts: {} });
    expect(decide(s, ROOT, "Write", { file_path: "C:/proj/x.ts" }).allow).toBe(true);
    const v = state({ phase: "verification", diff_scope: ["src/**"] });
    expect(decide(v, ROOT, "Edit", { file_path: "C:/proj/src/fix.ts" }).allow).toBe(true);
  });

  it("archivos fuera del root de la tarea no son asunto del gate", () => {
    const r = decide(state(), ROOT, "Write", { file_path: "C:/otro-repo/a.ts" });
    expect(r.allow).toBe(true);
  });
});

describe("decide — artefactos", () => {
  it("exploration escribe research pero no plan; planning ambos", () => {
    expect(
      decide(state(), ROOT, "Write", { file_path: `C:/proj/${TASK}/research.md` }).allow,
    ).toBe(true);
    expect(decide(state(), ROOT, "Write", { file_path: `C:/proj/${TASK}/plan.md` }).allow).toBe(
      false,
    );
    expect(
      decide(state({ phase: "planning" }), ROOT, "Write", {
        file_path: `C:/proj/${TASK}/plan.md`,
      }).allow,
    ).toBe(true);
  });

  it("el plan en implementation se enmienda con OK humano, no se reescribe solo", () => {
    const r = decide(state({ phase: "implementation" }), ROOT, "Edit", {
      file_path: `C:/proj/${TASK}/plan.md`,
    });
    expect(r.allow).toBe(false);
    expect(r.mode).toBe("ask");
    expect(r.reason).toContain("ENMIENDA");
  });

  it("los artefactos de OTRA tarea no se tocan (deny duro, sin pregunta)", () => {
    const r = decide(state(), ROOT, "Write", {
      file_path: "C:/proj/.harness/tasks/otra/research.md",
    });
    expect(r.allow).toBe(false);
    expect(r.mode).toBe("deny");
    expect(r.reason).toContain("otra tarea");
  });

  it("state.json no se edita a mano en ninguna fase (nuevo layout y legacy)", () => {
    const nuevo = decide(state({ phase: "implementation" }), ROOT, "Write", {
      file_path: `C:/proj/${TASK}/state.json`,
    });
    expect(nuevo.allow).toBe(false);
    expect(nuevo.reason).toContain("phase-cli");

    const legacy = decide(state({ phase: "implementation" }), ROOT, "Write", {
      file_path: "C:/proj/.harness/state.json",
    });
    expect(legacy.allow).toBe(false);
  });

  it("current.json (qué tarea trabaja cada sesión) tampoco se edita a mano", () => {
    const r = decide(state(), ROOT, "Write", { file_path: "C:/proj/.harness/current.json" });
    expect(r.allow).toBe(false);
    expect(r.reason).toContain("use <task_id>");
  });
});

describe("decide — decision_record por workflow", () => {
  it("estandar: permitido en planning/implementation, bloqueado en exploration", () => {
    expect(
      decide(state({ phase: "planning" }), ROOT, "mcp__memory__decision_record", {}).allow,
    ).toBe(true);
    expect(
      decide(state({ phase: "implementation" }), ROOT, "mcp__memory__decision_record", {}).allow,
    ).toBe(true);
    expect(decide(state(), ROOT, "mcp__memory__decision_record", {}).allow).toBe(false);
  });

  it("phase mentido se bloquea; coincidente u omitido pasa", () => {
    const s = state({ phase: "planning" });
    const lie = decide(s, ROOT, "mcp__memory__decision_record", {
      phase: "implementation",
      topic_key: "t",
    });
    expect(lie.allow).toBe(false);
    expect(lie.reason).toContain("≠ fase real");
    expect(decide(s, ROOT, "mcp__memory__decision_record", { phase: "planning" }).allow).toBe(
      true,
    );
    expect(decide(s, ROOT, "mcp__memory__decision_record", {}).allow).toBe(true);
  });

  it("directo: bloqueado siempre, con mensaje de escalada", () => {
    const r = decide(
      state({ workflow: "directo", phase: "implementation", artifacts: {} }),
      ROOT,
      "mcp__memory__decision_record",
      {},
    );
    expect(r.allow).toBe(false);
    expect(r.reason).toContain("escalar");
  });
});

describe("decide — fuera de una tarea", () => {
  it("sin estado, tarea done o sin fase: no interviene", () => {
    expect(decide(null, ROOT, "Write", { file_path: "C:/proj/a.ts" }).allow).toBe(true);
    expect(
      decide(state({ status: "done" }), ROOT, "Write", { file_path: "C:/proj/a.ts" }).allow,
    ).toBe(true);
  });

  it("otras tools pasan siempre (Bash ya lo gatea action-gating)", () => {
    expect(decide(state(), ROOT, "Bash", { command: "rm -rf src" }).allow).toBe(true);
    expect(decide(state(), ROOT, "Read", { file_path: "C:/proj/a.ts" }).allow).toBe(true);
  });
});

describe("decideAmbiguous — varias activas sin dueña", () => {
  const candidates = [
    { task_id: "aaaaaaaa-1", title: "una", phase: "planning" },
    { task_id: "bbbbbbbb-2", title: "otra", phase: "implementation" },
  ];

  it("bloquea lo que el harness gobierna, con la salida concreta", () => {
    const w = decideAmbiguous(candidates, "Write");
    expect(w.allow).toBe(false);
    expect(w.reason).toContain("use <task_id>");
    expect(w.reason).toContain("una");
    expect(decideAmbiguous(candidates, "mcp__memory__decision_record").allow).toBe(false);
  });

  it("no estorba a las tools que no gobierna", () => {
    expect(decideAmbiguous(candidates, "Read").allow).toBe(true);
    expect(decideAmbiguous(candidates, "Bash").allow).toBe(true);
  });
});

describe("resolveTask — qué tarea gobierna la sesión", () => {
  let harnessDir: string;

  const write = async (id: string, s: Record<string, unknown>): Promise<void> => {
    const dir = path.join(harnessDir, "tasks", id);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "state.json"), JSON.stringify({ task_id: id, ...s }), "utf8");
  };

  beforeEach(async () => {
    harnessDir = path.join(await mkdtemp(path.join(tmpdir(), "gate-")), ".harness");
    await mkdir(harnessDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(path.dirname(harnessDir), { recursive: true, force: true });
  });

  it("sin tareas activas no interviene", async () => {
    await write("t1", { status: "done", phase: null, session_ids: [] });
    expect(resolveTask(harnessDir, "s1").kind).toBe("none");
  });

  it("una sola activa gobierna aunque la sesión no la conozca", async () => {
    await write("t1", { status: "active", phase: "planning", session_ids: ["otra"] });
    const r = resolveTask(harnessDir, "s1");
    expect(r.kind).toBe("task");
    if (r.kind === "task") expect(r.state.task_id).toBe("t1");
  });

  it("el puntero de la sesión gana sobre las demás activas", async () => {
    await write("t1", { status: "active", phase: "planning", session_ids: [] });
    await write("t2", { status: "active", phase: "exploration", session_ids: [] });
    await writeFile(path.join(harnessDir, "current.json"), JSON.stringify({ s1: "t2" }), "utf8");
    const r = resolveTask(harnessDir, "s1");
    expect(r.kind).toBe("task");
    if (r.kind === "task") expect(r.state.task_id).toBe("t2");
  });

  it("sin puntero, la tarea que lista esta sesión en session_ids", async () => {
    await write("t1", { status: "active", phase: "planning", session_ids: ["s1"] });
    await write("t2", { status: "active", phase: "exploration", session_ids: ["s9"] });
    const r = resolveTask(harnessDir, "s1");
    expect(r.kind).toBe("task");
    if (r.kind === "task") expect(r.state.task_id).toBe("t1");
  });

  it("varias activas y ninguna de la sesión: ambiguo, no se elige al azar", async () => {
    await write("t1", { status: "active", phase: "planning", session_ids: [] });
    await write("t2", { status: "active", phase: "exploration", session_ids: [] });
    const r = resolveTask(harnessDir, "s1");
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") expect(r.candidates).toHaveLength(2);
  });

  it("un puntero a tarea cerrada se ignora en vez de romper", async () => {
    await write("t1", { status: "done", phase: null, session_ids: [] });
    await write("t2", { status: "active", phase: "planning", session_ids: [] });
    await writeFile(path.join(harnessDir, "current.json"), JSON.stringify({ s1: "t1" }), "utf8");
    const r = resolveTask(harnessDir, "s1");
    expect(r.kind).toBe("task");
    if (r.kind === "task") expect(r.state.task_id).toBe("t2");
  });

  it("el layout legacy (.harness/state.json) sigue resolviendo", async () => {
    await writeFile(
      path.join(harnessDir, "state.json"),
      JSON.stringify({ task_id: "viejo", status: "active", phase: "exploration", session_ids: [] }),
      "utf8",
    );
    const r = resolveTask(harnessDir, "s1");
    expect(r.kind).toBe("task");
    if (r.kind === "task") expect(r.state.task_id).toBe("viejo");
  });
});

describe("inScope (copia local del hook)", () => {
  it("coincide con la semántica del core", () => {
    expect(inScope("src/payments/a.ts", ["src/payments/**"])).toBe(true);
    expect(inScope("src/core/a.ts", ["src/payments/**"])).toBe(false);
    expect(inScope("src/a.test.ts", ["src/*.test.ts"])).toBe(true);
  });
});
