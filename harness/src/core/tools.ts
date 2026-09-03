// HarnessTool: una tool ejecutable del lado del harness. El schema se declara
// en Zod una sola vez: de ahí sale el JSON Schema que ve el modelo Y la
// validación de args antes de ejecutar — args inválidos son error con
// evidencia, nunca ejecución con basura.

import { z } from "zod";

import type { ToolDef } from "./types.js";

export interface HarnessTool {
  def: ToolDef;
  /** throw → el loop lo convierte en ToolResult con isError. */
  execute(args: unknown): Promise<string>;
}

export function defineTool<S extends z.ZodType>(options: {
  name: string;
  description: string;
  schema: S;
  execute(args: z.output<S>): Promise<string> | string;
}): HarnessTool {
  return {
    def: {
      name: options.name,
      description: options.description,
      inputSchema: z.toJSONSchema(options.schema) as Record<string, unknown>,
    },
    async execute(raw: unknown): Promise<string> {
      const parsed = options.schema.safeParse(raw ?? {});
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`)
          .join("; ");
        throw new Error(`args inválidos: ${issues}`);
      }
      return options.execute(parsed.data);
    },
  };
}

/** Enmascara el registro según PHASE_TOOLS: la tool que no está, no existe. */
export function maskTools(all: HarnessTool[], allowed: string[]): HarnessTool[] {
  const set = new Set(allowed);
  return all.filter((t) => set.has(t.def.name));
}

export const FLAG_DECISION_TOOL = "flag_decision_needed";

/**
 * El escape hatch de directo: el loop la intercepta y pausa la tarea. El
 * execute existe solo como fallback si alguien la monta fuera del loop.
 */
export function flagDecisionTool(): HarnessTool {
  return defineTool({
    name: FLAG_DECISION_TOOL,
    description:
      "Señala que apareció una decisión real (alternativas que evaluar) en una tarea " +
      "que no tiene captura de decisiones habilitada. Pausa la tarea: el humano decide " +
      "si escala el workflow o resuelve en una línea. Usala en cuanto detectes la " +
      "decisión — no la resuelvas por tu cuenta.",
    schema: z.object({
      summary: z.string().min(1).describe("La decisión que apareció, en 1-3 líneas: qué hay que elegir y entre qué opciones."),
    }),
    execute: ({ summary }) => `escalada solicitada: ${summary}`,
  });
}
