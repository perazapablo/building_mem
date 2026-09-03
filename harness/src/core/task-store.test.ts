import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTask, slugifyTitle, type TaskState } from "./task.js";
import {
  clearCurrent,
  listTasks,
  loadTask,
  migrateLegacy,
  resolveTask,
  saveTask,
  setCurrent,
  STATE_FILE,
  taskDir,
  uniqueTaskId,
} from "./task-store.js";

let dir: string;

function task(overrides: Partial<TaskState> = {}): TaskState {
  return {
    ...createTask({
      title: overrides.title ?? "integrar openpay",
      workflow: "estandar",
      workflow_suggested: "directo",
      project_id: "p1",
      session_id: "s1",
    }),
    ...overrides,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "harness-store-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("slugifyTitle", () => {
  it("convierte el título en un nombre de directorio legible", () => {
    // El título real que motivó el cambio: los ':' y '(' son ilegales o
    // molestos como path, y el id era un UUID que no decía nada.
    const t =
      "openpay: el cargo salda el cobro de SU MES calendario (no el mas antiguo) " +
      "y la suscripcion arranca el dia mas tardio del mes, hasta el dia del ultimo cobro";
    const s = slugifyTitle(t);
    expect(s).toMatch(/^[a-z0-9-]+$/);
    expect(s.startsWith("openpay-el-cargo-salda")).toBe(true);
    expect(s.length).toBeLessThanOrEqual(60);
    expect(s.endsWith("-")).toBe(false);
  });

  it("pela acentos y ñ en vez de dejarlos en el path", () => {
    expect(slugifyTitle("Añadir validación de sesión")).toBe("anadir-validacion-de-sesion");
  });

  it("corta en frontera de palabra, no a la mitad", () => {
    const s = slugifyTitle("a".repeat(20) + " " + "b".repeat(20) + " " + "c".repeat(40));
    expect(s.split("-").every((p) => /^(a+|b+|c+)$/.test(p))).toBe(true);
  });

  it("un título sin caracteres usables no produce un nombre vacío", () => {
    expect(slugifyTitle("¿¡...!?")).toBe("tarea");
    expect(slugifyTitle("")).toBe("tarea");
  });

  it("esquiva los nombres reservados de Windows", () => {
    // 'con' como directorio es imposible de crear en Windows.
    expect(slugifyTitle("CON")).toBe("con-tarea");
    expect(slugifyTitle("aux")).toBe("aux-tarea");
    // pero un título que EMPIEZA con eso está bien
    expect(slugifyTitle("con el harness")).toBe("con-el-harness");
  });
});

describe("uniqueTaskId", () => {
  it("devuelve el slug tal cual si está libre", async () => {
    expect(await uniqueTaskId(dir, "arreglar-el-gate")).toBe("arreglar-el-gate");
  });

  it("sufija cuando dos tareas comparten título", async () => {
    const a = task({ title: "arreglar el gate", task_id: "arreglar-el-gate" });
    await saveTask(dir, a);
    expect(await uniqueTaskId(dir, "arreglar-el-gate")).toBe("arreglar-el-gate-2");

    const b = task({ title: "arreglar el gate", task_id: "arreglar-el-gate-2" });
    await saveTask(dir, b);
    expect(await uniqueTaskId(dir, "arreglar-el-gate")).toBe("arreglar-el-gate-3");
  });

  it("el id es el nombre del directorio, y 'use' lo matchea por prefijo", async () => {
    const t = task({ title: "openpay: cargo del mes", task_id: slugifyTitle("openpay: cargo del mes") });
    await saveTask(dir, t);
    expect(t.task_id).toBe("openpay-cargo-del-mes");
    // El directorio se llama igual que el id: es la propiedad que hace que
    // taskDir() siga siendo una función pura del id.
    expect(await loadTask(dir, "openpay-cargo-del-mes")).toEqual(t);
    expect(taskDir(dir, t.task_id).endsWith("openpay-cargo-del-mes")).toBe(true);
  });
});

describe("task-store", () => {
  it("roundtrip: save → load devuelve el mismo estado", async () => {
    const t = task();
    await saveTask(dir, t);
    expect(await loadTask(dir, t.task_id)).toEqual(t);
  });

  it("una tarea inexistente devuelve null (no revienta)", async () => {
    expect(await loadTask(dir, "no-existe")).toBeNull();
  });

  it("state.json inválido es error explícito, no estado roto", async () => {
    const target = taskDir(dir, "x");
    await mkdir(target, { recursive: true });
    await writeFile(
      path.join(target, STATE_FILE),
      JSON.stringify({ task_id: "x", workflow: "yolo" }),
      "utf8",
    );
    await expect(loadTask(dir, "x")).rejects.toThrow();
  });

  it("el archivo persiste legible y con newline final", async () => {
    const t = task();
    await saveTask(dir, t);
    const raw = await readFile(path.join(taskDir(dir, t.task_id), STATE_FILE), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw).workflow_chosen_by).toBe("human");
  });
});

describe("listTasks — el store acumula", () => {
  it("guardar una tarea nueva NO pisa la anterior", async () => {
    const a = task({ title: "primera" });
    const b = task({ title: "segunda" });
    await saveTask(dir, a);
    await saveTask(dir, b);
    const titles = (await listTasks(dir)).map((t) => t.title).sort();
    expect(titles).toEqual(["primera", "segunda"]);
  });

  it("sin store devuelve lista vacía", async () => {
    expect(await listTasks(dir)).toEqual([]);
  });

  it("ordena por created_at, más reciente primero", async () => {
    await saveTask(dir, task({ title: "vieja", created_at: "2026-01-01T00:00:00.000Z" }));
    await saveTask(dir, task({ title: "nueva", created_at: "2026-08-01T00:00:00.000Z" }));
    expect((await listTasks(dir)).map((t) => t.title)).toEqual(["nueva", "vieja"]);
  });
});

describe("resolveTask — qué tarea gobierna la sesión", () => {
  it("sin tareas activas: none", async () => {
    await saveTask(dir, task({ status: "done" }));
    expect((await resolveTask(dir, "s1")).kind).toBe("none");
  });

  it("una sola activa gobierna, vía 'only'", async () => {
    const t = task({ session_ids: [] });
    await saveTask(dir, t);
    const r = await resolveTask(dir, "sX");
    expect(r).toMatchObject({ kind: "task", via: "only" });
    if (r.kind === "task") expect(r.state.task_id).toBe(t.task_id);
  });

  it("el puntero explícito de la sesión gana", async () => {
    const a = task({ title: "a", session_ids: [] });
    const b = task({ title: "b", session_ids: [] });
    await saveTask(dir, a);
    await saveTask(dir, b);
    await setCurrent(dir, "s1", b.task_id);
    const r = await resolveTask(dir, "s1");
    expect(r).toMatchObject({ kind: "task", via: "current" });
    if (r.kind === "task") expect(r.state.title).toBe("b");
  });

  it("sin puntero, desempata session_ids", async () => {
    await saveTask(dir, task({ title: "a", session_ids: ["s1"] }));
    await saveTask(dir, task({ title: "b", session_ids: ["s9"] }));
    const r = await resolveTask(dir, "s1");
    expect(r).toMatchObject({ kind: "task", via: "session" });
    if (r.kind === "task") expect(r.state.title).toBe("a");
  });

  it("varias activas sin dueña: ambiguo, jamás una al azar", async () => {
    await saveTask(dir, task({ title: "a", session_ids: [] }));
    await saveTask(dir, task({ title: "b", session_ids: [] }));
    const r = await resolveTask(dir, "s1");
    expect(r.kind).toBe("ambiguous");
    if (r.kind === "ambiguous") expect(r.candidates).toHaveLength(2);
  });

  it("dos sesiones paralelas apuntan a tareas distintas sin pisarse", async () => {
    const a = task({ title: "a", session_ids: [] });
    const b = task({ title: "b", session_ids: [] });
    await saveTask(dir, a);
    await saveTask(dir, b);
    await setCurrent(dir, "s1", a.task_id);
    await setCurrent(dir, "s2", b.task_id);
    const r1 = await resolveTask(dir, "s1");
    const r2 = await resolveTask(dir, "s2");
    if (r1.kind === "task") expect(r1.state.title).toBe("a");
    if (r2.kind === "task") expect(r2.state.title).toBe("b");
  });

  it("un puntero a tarea cerrada se ignora, no rompe la sesión", async () => {
    const cerrada = task({ title: "cerrada", status: "done" });
    const viva = task({ title: "viva", session_ids: [] });
    await saveTask(dir, cerrada);
    await saveTask(dir, viva);
    await setCurrent(dir, "s1", cerrada.task_id);
    const r = await resolveTask(dir, "s1");
    expect(r.kind).toBe("task");
    if (r.kind === "task") expect(r.state.title).toBe("viva");
  });

  it("dos sesiones concurrentes no se pisan el puntero", async () => {
    // El bug del mapa compartido: A y B leen current.json a la vez, ambos
    // escriben, y la escritura tardía borra la entrada de la temprana. Con un
    // archivo por sesión no hay estado compartido que perder.
    const a = task({ title: "A" });
    const b = task({ title: "B" });
    await saveTask(dir, a);
    await saveTask(dir, b);
    await Promise.all([
      setCurrent(dir, "s1", a.task_id),
      setCurrent(dir, "s2", b.task_id),
      setCurrent(dir, "s3", a.task_id),
    ]);
    const r1 = await resolveTask(dir, "s1");
    const r2 = await resolveTask(dir, "s2");
    const r3 = await resolveTask(dir, "s3");
    expect(r1.kind === "task" && r1.state.task_id).toBe(a.task_id);
    expect(r2.kind === "task" && r2.state.task_id).toBe(b.task_id);
    expect(r3.kind === "task" && r3.state.task_id).toBe(a.task_id);
  });

  it("rechaza un session_id que se escape del directorio", async () => {
    await expect(setCurrent(dir, "../../evil", "t1")).rejects.toThrow("inválido");
  });

  it("clearCurrent suelta la tarea de la sesión", async () => {
    const a = task({ title: "a", session_ids: [] });
    const b = task({ title: "b", session_ids: [] });
    await saveTask(dir, a);
    await saveTask(dir, b);
    await setCurrent(dir, "s1", b.task_id);
    await clearCurrent(dir, "s1");
    expect((await resolveTask(dir, "s1")).kind).toBe("ambiguous");
  });
});

describe("migrateLegacy — del state.json único al store", () => {
  it("mueve el estado y sus artefactos a tasks/<id>/ y borra el legacy", async () => {
    const t = task({ title: "legacy" });
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, STATE_FILE), JSON.stringify(t), "utf8");
    await writeFile(path.join(dir, "research.md"), "---\ngoal: x\n---\n", "utf8");

    const migrated = await migrateLegacy(dir);
    expect(migrated).toBe(t.task_id);

    const target = taskDir(dir, t.task_id);
    expect(await loadTask(dir, t.task_id)).toEqual(t);
    expect(await readFile(path.join(target, "research.md"), "utf8")).toContain("goal");
    await expect(readFile(path.join(dir, STATE_FILE), "utf8")).rejects.toThrow();
  });

  it("es idempotente y no inventa nada si no hay legacy", async () => {
    expect(await migrateLegacy(dir)).toBeNull();
    expect(await migrateLegacy(dir)).toBeNull();
  });

  it("listTasks migra sola: el repo viejo se lee sin ceremonia", async () => {
    const t = task({ title: "legacy" });
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, STATE_FILE), JSON.stringify(t), "utf8");
    expect((await listTasks(dir)).map((x) => x.title)).toEqual(["legacy"]);
  });
});
