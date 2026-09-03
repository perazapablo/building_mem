// Gates: condiciones verificables para salir de una fase. Leen artefactos,
// exit codes y diffs — JAMÁS la narración del agente. "Los tests pasan" dicho
// por el modelo vale cero; exit 0 vale todo. Éxito silencioso: un gate que
// pasa no produce evidencia; solo el fallo es verboso.

import { z } from "zod";
import YAML from "yaml";

import type { TaskState } from "./task.js";
import type { GateId } from "./workflow.js";

export type GateResult = { pass: true } | { pass: false; evidence: string };

export interface Gate {
  id: GateId;
  check(ctx: GateContext): Promise<GateResult>;
}

export interface GateContext {
  /** Directorio de LA TAREA (.harness/tasks/<id>/), donde viven sus artefactos. */
  taskDir: string;
  state: TaskState;
  /** null si el archivo no existe. Inyectado — los gates no tocan fs directo. */
  readFile(relPath: string): Promise<string | null>;
  exec(command: string): Promise<{ exitCode: number; output: string }>;
  /** Paths (relativos al repo target) modificados desde que arrancó la fase. */
  changedFiles(): Promise<string[]>;
}

export type { GateId };

// ── Artefactos: Markdown + frontmatter YAML ─────────────────────────────────
// La parte máquina va en el frontmatter (validada con Zod); la prosa en el
// cuerpo. Un plan sin diff_scope o sin criterios de verificación NO valida —
// así "meter los tests al flujo" es schema, no recordatorio.

export const ResearchFrontmatter = z.object({
  goal: z.string().min(1),
  findings: z.array(z.string()).min(1),
  open_questions: z.array(z.string()).default([]),
});

export const PlanFrontmatter = z.object({
  diff_scope: z.array(z.string().min(1)).min(1),
  verification_criteria: z.array(z.string().min(1)).min(1),
  steps: z.array(z.string().min(1)).min(1),
});
export type PlanData = z.infer<typeof PlanFrontmatter>;

export function parseFrontmatter(
  markdown: string,
): { data: unknown; body: string } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match) return null;
  try {
    return { data: YAML.parse(match[1] ?? ""), body: markdown.slice(match[0].length) };
  } catch (err) {
    return { data: { __yaml_error: String(err) }, body: "" };
  }
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`)
    .join("; ");
}

const EVIDENCE_MAX = 2_000;

function tail(output: string): string {
  return output.length <= EVIDENCE_MAX ? output : `…${output.slice(-EVIDENCE_MAX)}`;
}

async function readArtifactFrontmatter<S extends z.ZodTypeAny>(
  ctx: GateContext,
  artifactKey: "research" | "plan",
  schema: S,
): Promise<{ ok: true; data: z.infer<S> } | { ok: false; evidence: string }> {
  const relPath = ctx.state.artifacts[artifactKey];
  if (!relPath) {
    return { ok: false, evidence: `artefacto '${artifactKey}' no declarado en state.json` };
  }
  const content = await ctx.readFile(relPath);
  if (content === null) {
    return { ok: false, evidence: `artefacto '${artifactKey}' no existe: ${relPath}` };
  }
  const fm = parseFrontmatter(content);
  if (!fm) {
    return {
      ok: false,
      evidence: `${relPath}: sin frontmatter YAML (esperado bloque --- al inicio)`,
    };
  }
  const parsed = schema.safeParse(fm.data);
  if (!parsed.success) {
    return { ok: false, evidence: `${relPath}: ${formatZodIssues(parsed.error)}` };
  }
  return { ok: true, data: parsed.data };
}

/** El loop también la necesita: al aprobar el plan copia diff_scope al state. */
export async function readPlan(
  ctx: GateContext,
): Promise<{ ok: true; data: PlanData } | { ok: false; evidence: string }> {
  return readArtifactFrontmatter(ctx, "plan", PlanFrontmatter);
}

// ── Scope matching ──────────────────────────────────────────────────────────
// Entradas del diff_scope: path exacto, "dir/**" (prefijo), o "*" simple
// (comodín sin cruzar /). Sin dependencia de glob: el subset que un plan
// necesita es chico y auditable.

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Scope realmente autorizado = el que aprobó el plan + los archivos que el
 * humano concedió uno por uno durante implementation.
 *
 * Sin esta unión el sistema se contradecía: el gate preguntaba "¿amplío el
 * scope con X?", el humano decía que sí, y al cerrar la fase el exit gate
 * rechazaba X por estar fuera del scope. Gemela de effectiveScope() en
 * phase-gate.cjs — si cambia una, cambia la otra.
 */
export function effectiveScope(state: TaskState): string[] {
  const base = state.diff_scope ?? [];
  const amended = state.scope_amendments
    .filter((a) => a.kind === "out_of_scope")
    .map((a) => a.path);
  return [...base, ...amended];
}

export function inScope(file: string, scope: string[]): boolean {
  const norm = file.replace(/\\/g, "/");
  return scope.some((pattern) => {
    const p = pattern.replace(/\\/g, "/");
    if (p.endsWith("/**")) {
      return norm === p.slice(0, -3) || norm.startsWith(p.slice(0, -2));
    }
    if (p.includes("*")) {
      const rx = new RegExp(`^${p.split("*").map(escapeRegExp).join("[^/]*")}$`);
      return rx.test(norm);
    }
    return norm === p;
  });
}

// ── Los gates ───────────────────────────────────────────────────────────────

const researchValida: Gate = {
  id: "research_valida",
  async check(ctx) {
    const r = await readArtifactFrontmatter(ctx, "research", ResearchFrontmatter);
    return r.ok ? { pass: true } : { pass: false, evidence: r.evidence };
  },
};

const planValida: Gate = {
  id: "plan_valida",
  async check(ctx) {
    const r = await readPlan(ctx);
    return r.ok ? { pass: true } : { pass: false, evidence: r.evidence };
  },
};

const diffEnScopeYBuildOk: Gate = {
  id: "diff_en_scope_y_build_ok",
  async check(ctx) {
    const scope = effectiveScope(ctx.state);
    if (scope.length) {
      const changed = await ctx.changedFiles();
      const outside = changed.filter((f) => !inScope(f, scope));
      if (outside.length) {
        return {
          pass: false,
          evidence: `diff fuera del scope aprobado: ${outside.join(", ")}`,
        };
      }
    }
    const build = ctx.state.commands.build;
    if (build) {
      const r = await ctx.exec(build);
      if (r.exitCode !== 0) {
        return {
          pass: false,
          evidence: `build falló (exit ${r.exitCode}): ${build}\n${tail(r.output)}`,
        };
      }
    }
    return { pass: true };
  },
};

const testsPass: Gate = {
  id: "tests_pass",
  async check(ctx) {
    // Los criterios del plan mandan; sin plan (directo), el comando de test
    // declarado al crear la tarea. Sin ninguno, el gate NO pasa: un flujo con
    // gates jamás termina sin verificación declarada.
    let criteria: string[] = [];
    if (ctx.state.artifacts.plan) {
      const plan = await readPlan(ctx);
      if (!plan.ok) return { pass: false, evidence: plan.evidence };
      criteria = plan.data.verification_criteria;
    } else if (ctx.state.commands.test) {
      criteria = [ctx.state.commands.test];
    }
    if (!criteria.length) {
      return {
        pass: false,
        evidence:
          "sin criterios de verificación: ni plan con verification_criteria ni commands.test",
      };
    }
    for (const cmd of criteria) {
      const r = await ctx.exec(cmd);
      if (r.exitCode !== 0) {
        return {
          pass: false,
          evidence: `criterio falló (exit ${r.exitCode}): ${cmd}\n${tail(r.output)}`,
        };
      }
    }
    return { pass: true };
  },
};

export type GateRegistry = Record<GateId, Gate>;

export function buildGateRegistry(): GateRegistry {
  return {
    research_valida: researchValida,
    plan_valida: planValida,
    diff_en_scope_y_build_ok: diffEnScopeYBuildOk,
    tests_pass: testsPass,
  };
}
