// Tools locales del agente: fs del proyecto target, artefactos de .harness/
// y comandos. Los guardarraíles duros viven ACÁ (nivel 4), además del
// enmascarado por fase (nivel 3): path traversal bloqueado, write_file
// respeta diff_scope, write_artifact solo escribe el artefacto de su fase.

import { exec as execCb } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

import { inScope } from "../core/gates.js";
import { defineTool, type HarnessTool } from "../core/tools.js";
import type { TaskState } from "../core/task.js";
import { taskDir } from "../core/task-store.js";
import type { Phase } from "../core/workflow.js";

const execAsync = promisify(execCb);

export interface LocalToolsEnv {
  /** Raíz del repo target. Ninguna tool sale de acá. */
  projectDir: string;
  /** Raíz del store de tareas (.harness/). El directorio concreto de la tarea
   *  se deriva del estado vivo — así un cambio de tarea no deja un path viejo. */
  harnessDir: string;
  /** Lectura viva: el diff_scope aparece recién al aprobar el plan. */
  getState(): TaskState;
  /** Inyectable para tests. */
  exec?: (command: string, cwd: string) => Promise<{ exitCode: number; output: string }>;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "target", "coverage"]);
const GREP_MAX_MATCHES = 100;
const READ_MAX = 48_000;
const EXEC_TIMEOUT_MS = 600_000;
const EXEC_MAX_BUFFER = 10 * 1024 * 1024;

/** Resuelve dentro de root o revienta — el agente no sale del repo target. */
function resolveInside(root: string, relPath: string): string {
  const abs = path.resolve(root, relPath);
  const normRoot = path.resolve(root);
  if (abs !== normRoot && !abs.startsWith(normRoot + path.sep)) {
    throw new Error(`path fuera del proyecto: ${relPath}`);
  }
  return abs;
}

export async function defaultExec(
  command: string,
  cwd: string,
): Promise<{ exitCode: number; output: string }> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: EXEC_MAX_BUFFER,
      windowsHide: true,
    });
    return { exitCode: 0, output: `${stdout}${stderr}` };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      exitCode: typeof e.code === "number" ? e.code : 1,
      output: `${e.stdout ?? ""}${e.stderr ?? ""}` || (e.message ?? "exec failed"),
    };
  }
}

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(path.join(dir, entry.name));
    } else if (entry.isFile()) {
      yield path.join(dir, entry.name);
    }
  }
}

// Qué artefacto puede escribir cada fase: exploration produce research,
// planning puede ajustar research y producir plan. En implementation el plan
// NO se edita — una desviación es decision_record, no reescritura del plan.
const ARTIFACT_BY_PHASE: Partial<Record<Phase, ReadonlyArray<"research" | "plan">>> = {
  exploration: ["research"],
  planning: ["research", "plan"],
};

export function createLocalTools(env: LocalToolsEnv): HarnessTool[] {
  const exec = env.exec ?? defaultExec;

  const readFileTool = defineTool({
    name: "read_file",
    description: "Lee un archivo del proyecto (path relativo a la raíz del repo).",
    schema: z.object({ path: z.string().min(1) }),
    async execute({ path: relPath }) {
      const abs = resolveInside(env.projectDir, relPath);
      const content = await readFile(abs, "utf8");
      return content.length <= READ_MAX
        ? content
        : `${content.slice(0, READ_MAX)}\n[…truncado, ${content.length} chars totales]`;
    },
  });

  const listDirTool = defineTool({
    name: "list_dir",
    description: "Lista un directorio del proyecto. Directorios terminan en '/'.",
    schema: z.object({ path: z.string().default(".") }),
    async execute({ path: relPath }) {
      const abs = resolveInside(env.projectDir, relPath);
      const entries = await readdir(abs, { withFileTypes: true });
      return (
        entries
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort()
          .join("\n") || "(vacío)"
      );
    },
  });

  const grepTool = defineTool({
    name: "grep",
    description:
      "Busca un patrón (regex) en los archivos del proyecto. Devuelve path:línea: texto. " +
      "Ignora node_modules/.git/dist/target.",
    schema: z.object({
      pattern: z.string().min(1),
      dir: z.string().default("."),
    }),
    async execute({ pattern, dir }) {
      const rx = new RegExp(pattern);
      const root = resolveInside(env.projectDir, dir);
      const matches: string[] = [];
      for await (const file of walk(root)) {
        if ((await stat(file)).size > 2 * 1024 * 1024) continue;
        let content: string;
        try {
          content = await readFile(file, "utf8");
        } catch {
          continue;
        }
        if (content.includes("\0")) continue;
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (rx.test(lines[i]!)) {
            matches.push(
              `${path.relative(env.projectDir, file).replace(/\\/g, "/")}:${i + 1}: ${lines[i]!.trim()}`,
            );
            if (matches.length >= GREP_MAX_MATCHES) {
              matches.push(`[…corte en ${GREP_MAX_MATCHES} matches]`);
              return matches.join("\n");
            }
          }
        }
      }
      return matches.join("\n") || "(sin matches)";
    },
  });

  const writeFileTool = defineTool({
    name: "write_file",
    description:
      "Escribe un archivo del proyecto (crea directorios si hacen falta). " +
      "Solo dentro del diff_scope aprobado en el plan.",
    schema: z.object({ path: z.string().min(1), content: z.string() }),
    async execute({ path: relPath, content }) {
      const state = env.getState();
      const norm = relPath.replace(/\\/g, "/");
      if (state.diff_scope && !inScope(norm, state.diff_scope)) {
        throw new Error(
          `'${norm}' está fuera del diff_scope aprobado: [${state.diff_scope.join(", ")}]. ` +
            "Si el plan necesita tocar este archivo, es una desviación: registrala con " +
            "decision_record y pedí retroceso a planning.",
        );
      }
      const abs = resolveInside(env.projectDir, relPath);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
      return `escrito: ${norm} (${content.length} chars)`;
    },
  });

  const writeArtifactTool = defineTool({
    name: "write_artifact",
    description:
      "Escribe el artefacto de la fase actual en el directorio de la tarea (research en exploration; " +
      "research o plan en planning). Formato: frontmatter YAML entre '---' con los " +
      "campos que exige el gate, luego la prosa. research: goal, findings[], " +
      "open_questions[]. plan: diff_scope[], verification_criteria[] (comandos " +
      "ejecutables), steps[].",
    schema: z.object({
      artifact: z.enum(["research", "plan"]),
      content: z.string().min(1),
    }),
    async execute({ artifact, content }) {
      const state = env.getState();
      const allowed = (state.phase && ARTIFACT_BY_PHASE[state.phase]) || [];
      if (!allowed.includes(artifact)) {
        throw new Error(
          `la fase '${state.phase}' no escribe el artefacto '${artifact}'` +
            (artifact === "plan" && state.phase === "implementation"
              ? " — una desviación del plan se registra con decision_record, no editándolo"
              : ""),
        );
      }
      const relPath = state.artifacts[artifact] ?? `${artifact}.md`;
      const dir = taskDir(env.harnessDir, state.task_id);
      const abs = resolveInside(dir, relPath);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
      return `artefacto escrito: ${path.posix.join("tasks", state.task_id, relPath)}`;
    },
  });

  const runCommandTool = defineTool({
    name: "run_command",
    description:
      "Ejecuta un comando en la raíz del proyecto y devuelve exit code + salida. " +
      "La evidencia que cuenta para los gates son exit codes, no narración.",
    schema: z.object({ command: z.string().min(1) }),
    async execute({ command }) {
      const r = await exec(command, env.projectDir);
      return `exit ${r.exitCode}\n${r.output}`;
    },
  });

  return [
    readFileTool,
    listDirTool,
    grepTool,
    writeFileTool,
    writeArtifactTool,
    runCommandTool,
  ];
}
