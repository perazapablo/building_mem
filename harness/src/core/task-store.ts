// Persistencia de TaskState: .harness/tasks/<task_id>/state.json en el repo
// del proyecto target. El store es ACUMULABLE — cada tarea es un directorio
// autocontenido (state + artefactos) que sobrevive a la siguiente. Escritura
// atómica (tmp + rename): matar el proceso a mitad de un save jamás deja un
// state.json corrupto. La lectura valida con Zod: un archivo inválido es error
// explícito, no estado silenciosamente roto.
//
// Pueden convivir varias tareas `active`. Qué tarea gobierna un tool call NO
// se adivina: lo resuelve `resolveTask`, y si es ambiguo lo dice en vez de
// elegir por su cuenta — validar contra el diff_scope de la tarea equivocada
// es peor que bloquear.

import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { TaskStateSchema, type TaskState } from "./task.js";
import type { Phase } from "./workflow.js";

export const TASKS_DIR = "tasks";
export const STATE_FILE = "state.json";
/** Layout LEGACY del puntero: un solo JSON con el mapa session_id → task_id.
 *  Se sigue leyendo para no romper tareas creadas antes del cambio, pero ya no
 *  se escribe: un mapa compartido obliga a read-modify-write, y dos agentes
 *  concurrentes se pierden una entrada aunque el rename sea atómico. */
export const CURRENT_FILE = "current.json";
/** Layout vigente: un archivo por sesión (.harness/current/<session_id>).
 *  Sin estado compartido no hay carrera que resolver — N agentes escriben
 *  punteros distintos sin coordinarse. */
export const CURRENT_DIR = "current";

export function taskDir(harnessDir: string, taskId: string): string {
  return path.join(harnessDir, TASKS_DIR, taskId);
}

async function writeAtomic(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, file);
}

async function readJson(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

// ── Tareas ──────────────────────────────────────────────────────────────────

export async function loadTask(harnessDir: string, taskId: string): Promise<TaskState | null> {
  const raw = await readJson(path.join(taskDir(harnessDir, taskId), STATE_FILE));
  if (raw === null) return null;
  return TaskStateSchema.parse(raw);
}

/**
 * Id libre a partir de un slug: si el directorio ya existe, sufija -2, -3…
 * Dos tareas con el mismo título son plausibles (el mismo bug atacado dos
 * veces); dos directorios con el mismo nombre, no.
 */
export async function uniqueTaskId(harnessDir: string, base: string): Promise<string> {
  const dirs = new Set<string>();
  try {
    for (const e of await readdir(path.join(harnessDir, TASKS_DIR), { withFileTypes: true })) {
      if (e.isDirectory()) dirs.add(e.name);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (!dirs.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const cand = `${base}-${n}`;
    if (!dirs.has(cand)) return cand;
  }
  throw new Error(`no se pudo generar un task_id libre para '${base}'`);
}

export async function saveTask(harnessDir: string, state: TaskState): Promise<void> {
  const file = path.join(taskDir(harnessDir, state.task_id), STATE_FILE);
  await writeAtomic(file, `${JSON.stringify(state, null, 2)}\n`);
}

/** Todas las tareas del repo, más reciente primero. Migra el layout legacy. */
export async function listTasks(harnessDir: string): Promise<TaskState[]> {
  await migrateLegacy(harnessDir);
  let entries: string[];
  try {
    entries = (await readdir(path.join(harnessDir, TASKS_DIR), { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const tasks: TaskState[] = [];
  for (const id of entries) {
    const t = await loadTask(harnessDir, id);
    if (t) tasks.push(t);
  }
  return tasks.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

// ── Puntero por sesión ──────────────────────────────────────────────────────

type CurrentMap = Record<string, string>;

async function readCurrentMap(harnessDir: string): Promise<CurrentMap> {
  const raw = await readJson(path.join(harnessDir, CURRENT_FILE));
  if (raw === null || typeof raw !== "object") return {};
  const out: CurrentMap = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/** El session_id se usa como nombre de archivo: se rechaza cualquier cosa que
 *  pueda escapar del directorio. Son UUIDs, pero el gate no confía en eso. */
function pointerFile(harnessDir: string, sessionId: string): string {
  if (!sessionId || /[/\\]|^\.\.?$/.test(sessionId)) {
    throw new Error(`session_id inválido como puntero: '${sessionId}'`);
  }
  return path.join(harnessDir, CURRENT_DIR, sessionId);
}

/** Puntero vigente de una sesión: archivo propio primero, mapa legacy después. */
async function readPointer(harnessDir: string, sessionId: string): Promise<string | null> {
  try {
    const v = (await readFile(pointerFile(harnessDir, sessionId), "utf8")).trim();
    if (v) return v;
  } catch {
    // sin archivo propio: puede ser una tarea del layout viejo
  }
  return (await readCurrentMap(harnessDir))[sessionId] ?? null;
}

export async function setCurrent(
  harnessDir: string,
  sessionId: string,
  taskId: string,
): Promise<void> {
  await writeAtomic(pointerFile(harnessDir, sessionId), `${taskId}\n`);
}

export async function clearCurrent(harnessDir: string, sessionId: string): Promise<void> {
  await rm(pointerFile(harnessDir, sessionId), { force: true });
  // El mapa legacy puede tener todavía la entrada de esta sesión.
  const map = await readCurrentMap(harnessDir);
  if (!(sessionId in map)) return;
  delete map[sessionId];
  await writeAtomic(path.join(harnessDir, CURRENT_FILE), `${JSON.stringify(map, null, 2)}\n`);
}

// ── Colisión de scopes entre tareas concurrentes ────────────────────────────

export interface ScopeConflict {
  task_id: string;
  title: string;
  phase: Phase | null;
  /** Pares [patrón de esta tarea, patrón de la otra] que se solapan. */
  overlaps: Array<[string, string]>;
}

/** Prefijo estático de un patrón: todo lo anterior al primer comodín. */
function staticPrefix(pattern: string): string {
  const p = pattern.replace(/\\/g, "/");
  const star = p.indexOf("*");
  return (star === -1 ? p : p.slice(0, star)).replace(/\/+$/, "");
}

/**
 * ¿Dos patrones pueden resolver al mismo archivo? Se compara por prefijo
 * estático en frontera de path. Conservador hacia el falso positivo a
 * propósito: esto produce una ADVERTENCIA, y avisar de más sobre dos agentes
 * que van a pisarse cuesta menos que no avisar.
 */
export function patternsOverlap(a: string, b: string): boolean {
  const pa = staticPrefix(a);
  const pb = staticPrefix(b);
  if (pa === pb) return true;
  const under = (x: string, y: string) => y !== "" && x.startsWith(`${y}/`);
  return under(pa, pb) || under(pb, pa);
}

/**
 * Tareas activas DISTINTAS de `state` cuyo scope se solapa con el suyo.
 * Se consulta al aprobar un plan: es el momento en que un agente gana permiso
 * de escritura y, con varios corriendo sobre el mismo repo, el único punto
 * donde se puede avisar antes de que dos se pisen.
 */
export async function scopeConflicts(
  harnessDir: string,
  state: TaskState,
): Promise<ScopeConflict[]> {
  const mine = state.diff_scope ?? [];
  if (!mine.length) return [];
  const others = (await listTasks(harnessDir)).filter(
    (t) => t.status === "active" && t.task_id !== state.task_id,
  );
  const out: ScopeConflict[] = [];
  for (const t of others) {
    const theirs = t.diff_scope ?? [];
    const overlaps: Array<[string, string]> = [];
    for (const m of mine) {
      for (const o of theirs) {
        if (patternsOverlap(m, o)) overlaps.push([m, o]);
      }
    }
    if (overlaps.length) {
      out.push({ task_id: t.task_id, title: t.title, phase: t.phase, overlaps });
    }
  }
  return out;
}

// ── Resolución: qué tarea gobierna ──────────────────────────────────────────

export type Resolution =
  /** No hay ninguna tarea activa: el harness de fases no interviene. */
  | { kind: "none" }
  | { kind: "task"; state: TaskState; via: "current" | "only" | "session" }
  /** Varias activas y ninguna señal para elegir: el caller decide qué hacer,
   *  pero NO se elige una al azar. */
  | { kind: "ambiguous"; candidates: TaskState[] };

/**
 * Resuelve la tarea vigente para una sesión, en orden de evidencia:
 *   current  → puntero explícito de esta sesión (`use <id>`)
 *   only     → hay exactamente una tarea activa en el repo
 *   session  → la sesión aparece en session_ids de una sola tarea activa
 *   ambiguous→ varias candidatas y nada que las distinga
 * Un puntero que apunta a una tarea cerrada o borrada se ignora (no es error):
 * la sesión sigue viva más allá de la tarea que eligió.
 */
export async function resolveTask(harnessDir: string, sessionId?: string): Promise<Resolution> {
  const active = (await listTasks(harnessDir)).filter((t) => t.status === "active");
  if (active.length === 0) return { kind: "none" };

  if (sessionId) {
    const pointed = await readPointer(harnessDir, sessionId);
    const hit = active.find((t) => t.task_id === pointed);
    if (hit) return { kind: "task", state: hit, via: "current" };
  }

  if (active.length === 1) return { kind: "task", state: active[0]!, via: "only" };

  if (sessionId) {
    const owned = active.filter((t) => t.session_ids.includes(sessionId));
    if (owned.length === 1) return { kind: "task", state: owned[0]!, via: "session" };
  }

  return { kind: "ambiguous", candidates: active };
}

// ── Migración del layout legacy ─────────────────────────────────────────────

/**
 * `.harness/state.json` (una tarea por repo) → `.harness/tasks/<id>/`.
 * Arrastra los artefactos que la tarea declara. Idempotente y silenciosa:
 * corre al inicio de cualquier lectura del store.
 * @returns el task_id migrado, o null si no había nada que migrar.
 */
export async function migrateLegacy(harnessDir: string): Promise<string | null> {
  const legacyState = path.join(harnessDir, STATE_FILE);
  const raw = await readJson(legacyState);
  if (raw === null) return null;

  const state = TaskStateSchema.parse(raw);
  const dest = taskDir(harnessDir, state.task_id);
  await mkdir(dest, { recursive: true });

  for (const rel of Object.values(state.artifacts)) {
    if (!rel) continue;
    try {
      await rename(path.join(harnessDir, rel), path.join(dest, rel));
    } catch {
      // el artefacto no existe (la fase que lo produce no corrió): nada que mover
    }
  }
  await writeAtomic(path.join(dest, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
  await rm(legacyState, { force: true });
  return state.task_id;
}
