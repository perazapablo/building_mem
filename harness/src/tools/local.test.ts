import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTask, type TaskState } from "../core/task.js";
import { createLocalTools } from "./local.js";

let projectDir: string;
let harnessDir: string;
let state: TaskState;

function tools() {
  const list = createLocalTools({
    projectDir,
    harnessDir,
    getState: () => state,
  });
  return Object.fromEntries(list.map((t) => [t.def.name, t]));
}

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), "harness-proj-"));
  harnessDir = path.join(projectDir, ".harness");
  await mkdir(harnessDir, { recursive: true });
  state = createTask({
    title: "t",
    workflow: "estandar",
    workflow_suggested: "estandar",
    project_id: "p",
    session_id: "s",
  });
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

describe("read_file / list_dir / grep", () => {
  it("lee relativo al proyecto y bloquea path traversal", async () => {
    await writeFile(path.join(projectDir, "a.txt"), "hola", "utf8");
    const t = tools();
    expect(await t.read_file!.execute({ path: "a.txt" })).toBe("hola");
    await expect(t.read_file!.execute({ path: "../fuera.txt" })).rejects.toThrow(
      /fuera del proyecto/,
    );
  });

  it("grep encuentra con path:línea y salta node_modules", async () => {
    await writeFile(path.join(projectDir, "src.ts"), "const openpay = 1;\n", "utf8");
    await mkdir(path.join(projectDir, "node_modules"), { recursive: true });
    await writeFile(
      path.join(projectDir, "node_modules", "x.js"),
      "openpay everywhere",
      "utf8",
    );
    const out = await tools().grep!.execute({ pattern: "openpay" });
    expect(out).toContain("src.ts:1:");
    expect(out).not.toContain("node_modules");
  });
});

describe("write_file", () => {
  it("sin diff_scope escribe (directo); con diff_scope bloquea lo de afuera", async () => {
    const t = tools();
    // Sin scope aprobado aún (null): escribe.
    await t.write_file!.execute({ path: "src/a.ts", content: "x" });
    expect(await readFile(path.join(projectDir, "src/a.ts"), "utf8")).toBe("x");

    state = { ...state, diff_scope: ["src/payments/**"] };
    await expect(
      t.write_file!.execute({ path: "src/core/hack.ts", content: "y" }),
    ).rejects.toThrow(/fuera del diff_scope/);
    await t.write_file!.execute({ path: "src/payments/openpay.ts", content: "ok" });
  });
});

describe("write_artifact", () => {
  it("exploration solo escribe research; plan es rechazado con guía", async () => {
    state = { ...state, phase: "exploration" };
    const t = tools();
    await t.write_artifact!.execute({ artifact: "research", content: "---\ngoal: x\n---\n" });
    // El artefacto vive en el directorio de la tarea, no en .harness/ plano.
    const artifact = path.join(harnessDir, "tasks", state.task_id, "research.md");
    expect(await readFile(artifact, "utf8")).toContain("goal");

    await expect(
      t.write_artifact!.execute({ artifact: "plan", content: "p" }),
    ).rejects.toThrow(/no escribe el artefacto 'plan'/);
  });

  it("en implementation el plan NO se edita: la desviación es decision_record", async () => {
    state = { ...state, phase: "implementation" };
    await expect(
      tools().write_artifact!.execute({ artifact: "plan", content: "p" }),
    ).rejects.toThrow(/decision_record/);
  });
});

describe("run_command", () => {
  it("devuelve exit code y salida vía exec inyectado", async () => {
    const executed: string[] = [];
    const list = createLocalTools({
      projectDir,
      harnessDir,
      getState: () => state,
      exec: async (cmd) => {
        executed.push(cmd);
        return { exitCode: 1, output: "2 tests failed" };
      },
    });
    const run = list.find((t) => t.def.name === "run_command")!;
    const out = await run.execute({ command: "npm test" });
    expect(out).toBe("exit 1\n2 tests failed");
    expect(executed).toEqual(["npm test"]);
  });
});
