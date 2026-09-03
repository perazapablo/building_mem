import { describe, expect, it } from "vitest";

import {
  buildGateRegistry,
  inScope,
  parseFrontmatter,
  type GateContext,
} from "./gates.js";
import { createTask, type TaskState } from "./task.js";

const NOW = () => "2026-08-24T12:00:00.000Z";

function baseTask(overrides: Partial<TaskState> = {}): TaskState {
  const t = createTask({
    title: "t",
    workflow: "estandar",
    workflow_suggested: "estandar",
    project_id: "p",
    session_id: "s",
    now: NOW,
  });
  return { ...t, ...overrides };
}

interface CtxOptions {
  state: TaskState;
  files?: Record<string, string>;
  execResults?: Record<string, { exitCode: number; output: string }>;
  changed?: string[];
}

function ctx(options: CtxOptions): GateContext & { executed: string[] } {
  const executed: string[] = [];
  return {
    taskDir: "/fake/.harness/tasks/t1",
    state: options.state,
    executed,
    async readFile(relPath) {
      return options.files?.[relPath] ?? null;
    },
    async exec(command) {
      executed.push(command);
      return options.execResults?.[command] ?? { exitCode: 0, output: "" };
    },
    async changedFiles() {
      return options.changed ?? [];
    },
  };
}

const gates = buildGateRegistry();

const VALID_PLAN = `---
diff_scope:
  - src/payments/**
  - migrations/004_payment_customer.sql
verification_criteria:
  - npm test
steps:
  - crear tabla de mapeo
---
# Plan
prosa del plan
`;

describe("parseFrontmatter", () => {
  it("separa frontmatter YAML del cuerpo", () => {
    const r = parseFrontmatter("---\ngoal: x\n---\ncuerpo");
    expect(r?.data).toEqual({ goal: "x" });
    expect(r?.body).toBe("cuerpo");
  });

  it("sin bloque --- devuelve null", () => {
    expect(parseFrontmatter("# solo prosa")).toBeNull();
  });
});

describe("inScope", () => {
  it.each([
    ["src/payments/openpay.ts", ["src/payments/**"], true],
    ["src/other/x.ts", ["src/payments/**"], false],
    ["migrations/004.sql", ["migrations/004.sql"], true],
    ["src\\payments\\a.ts", ["src/payments/**"], true], // paths windows normalizados
    ["src/a.test.ts", ["src/*.test.ts"], true],
    ["src/deep/a.test.ts", ["src/*.test.ts"], false], // * no cruza /
  ])("%s vs %j → %s", (file, scope, expected) => {
    expect(inScope(file, scope as string[])).toBe(expected);
  });
});

describe("research_valida", () => {
  it("falla si el artefacto no está declarado", async () => {
    const r = await gates.research_valida.check(ctx({ state: baseTask() }));
    expect(r).toMatchObject({ pass: false });
  });

  it("falla si el frontmatter no cumple el schema", async () => {
    const state = baseTask({ artifacts: { research: "research.md" } });
    const r = await gates.research_valida.check(
      ctx({ state, files: { "research.md": "---\ngoal: x\nfindings: []\n---\n" } }),
    );
    expect(r.pass).toBe(false);
    if (!r.pass) expect(r.evidence).toContain("findings");
  });

  it("pasa con frontmatter válido", async () => {
    const state = baseTask({ artifacts: { research: "research.md" } });
    const md = "---\ngoal: entender openpay\nfindings:\n  - usa charges API\n---\n";
    const r = await gates.research_valida.check(ctx({ state, files: { "research.md": md } }));
    expect(r).toEqual({ pass: true });
  });
});

describe("plan_valida", () => {
  it("un plan sin verification_criteria NO valida (tests como schema)", async () => {
    const state = baseTask({ artifacts: { plan: "plan.md" } });
    const md = "---\ndiff_scope:\n  - src/**\nsteps:\n  - paso\n---\n";
    const r = await gates.plan_valida.check(ctx({ state, files: { "plan.md": md } }));
    expect(r.pass).toBe(false);
    if (!r.pass) expect(r.evidence).toContain("verification_criteria");
  });

  it("pasa con plan completo", async () => {
    const state = baseTask({ artifacts: { plan: "plan.md" } });
    const r = await gates.plan_valida.check(ctx({ state, files: { "plan.md": VALID_PLAN } }));
    expect(r).toEqual({ pass: true });
  });
});

describe("diff_en_scope_y_build_ok", () => {
  it("archivo fuera del scope aprobado falla con la lista", async () => {
    const state = baseTask({ diff_scope: ["src/payments/**"] });
    const r = await gates.diff_en_scope_y_build_ok.check(
      ctx({ state, changed: ["src/payments/a.ts", "src/core/hack.ts"] }),
    );
    expect(r.pass).toBe(false);
    if (!r.pass) expect(r.evidence).toContain("src/core/hack.ts");
  });

  it("build con exit != 0 falla con evidencia del comando", async () => {
    const state = baseTask({
      diff_scope: ["src/**"],
      commands: { build: "npm run build" },
    });
    const r = await gates.diff_en_scope_y_build_ok.check(
      ctx({
        state,
        changed: ["src/a.ts"],
        execResults: { "npm run build": { exitCode: 2, output: "error TS2345" } },
      }),
    );
    expect(r.pass).toBe(false);
    if (!r.pass) expect(r.evidence).toContain("error TS2345");
  });

  it("diff en scope y build exit 0 pasa en silencio", async () => {
    const state = baseTask({ diff_scope: ["src/**"], commands: { build: "npm run build" } });
    const r = await gates.diff_en_scope_y_build_ok.check(
      ctx({ state, changed: ["src/a.ts"] }),
    );
    expect(r).toEqual({ pass: true });
  });
});

describe("tests_pass", () => {
  it("sin plan ni commands.test falla: verificación no declarada", async () => {
    const r = await gates.tests_pass.check(ctx({ state: baseTask({ artifacts: {} }) }));
    expect(r.pass).toBe(false);
    if (!r.pass) expect(r.evidence).toContain("sin criterios");
  });

  it("corre los verification_criteria del plan y falla con el que rompió", async () => {
    const state = baseTask({ artifacts: { plan: "plan.md" } });
    const c = ctx({
      state,
      files: { "plan.md": VALID_PLAN },
      execResults: { "npm test": { exitCode: 1, output: "2 tests failed" } },
    });
    const r = await gates.tests_pass.check(c);
    expect(r.pass).toBe(false);
    if (!r.pass) expect(r.evidence).toContain("2 tests failed");
    expect(c.executed).toEqual(["npm test"]);
  });

  it("directo sin plan usa commands.test", async () => {
    const state = baseTask({ artifacts: {}, commands: { test: "cargo test" } });
    const c = ctx({ state });
    const r = await gates.tests_pass.check(c);
    expect(r).toEqual({ pass: true });
    expect(c.executed).toEqual(["cargo test"]);
  });
});
