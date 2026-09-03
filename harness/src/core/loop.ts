// El loop de turnos: contexto → generate() → ejecutar tools → repetir.
// Corre DENTRO de una fase; las transiciones no pasan por acá — cuando el
// agente declara terminado (stopReason "end"), el caller corre machine.advance
// y el gate decide. El loop no interpreta narración: solo stopReason y tools.

import type { HarnessTool } from "./tools.js";
import { FLAG_DECISION_TOOL } from "./tools.js";
import type {
  Effort,
  ModelAdapter,
  Msg,
  ToolCall,
  ToolResult,
} from "./types.js";

export type LoopEvent =
  | { type: "turn"; n: number }
  | { type: "assistant"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "tool_result"; result: ToolResult };

export type PhaseOutcome =
  | { kind: "agent_done"; text: string; messages: Msg[] }
  | { kind: "decision_flagged"; summary: string; messages: Msg[] }
  | { kind: "refusal"; messages: Msg[] }
  | { kind: "max_tokens"; messages: Msg[] }
  | { kind: "turn_limit"; messages: Msg[] };

export interface LoopDeps {
  adapter: ModelAdapter;
  /** Ya enmascaradas por fase (maskTools + toolsForPhase). */
  tools: HarnessTool[];
  /** Prefijo estable — lo arma el ensamblador, byte-idéntico entre turnos. */
  system: string;
  maxTokens?: number;
  effort?: Effort;
  maxTurns?: number;
  onEvent?: (e: LoopEvent) => void;
}

// Éxito silencioso: un resultado enorme inunda la ventana y el modelo alucina
// sobre lo recién leído. Se conserva la cola, que es donde viven los errores.
const RESULT_MAX = 20_000;

function truncate(content: string): string {
  return content.length <= RESULT_MAX
    ? content
    : `[…truncado, ${content.length} chars totales]\n${content.slice(-RESULT_MAX)}`;
}

export async function runTurns(
  userMessage: string,
  deps: LoopDeps,
  history: Msg[] = [],
): Promise<PhaseOutcome> {
  const registry = new Map(deps.tools.map((t) => [t.def.name, t]));
  const defs = deps.tools.map((t) => t.def);
  const messages: Msg[] = [...history, { role: "user", content: userMessage }];
  const maxTurns = deps.maxTurns ?? 40;

  for (let turn = 1; turn <= maxTurns; turn++) {
    deps.onEvent?.({ type: "turn", n: turn });

    const result = await deps.adapter.generate({
      system: deps.system,
      messages,
      tools: defs,
      maxTokens: deps.maxTokens ?? 16_000,
      ...(deps.effort ? { effort: deps.effort } : {}),
    });

    if (result.text) deps.onEvent?.({ type: "assistant", text: result.text });
    messages.push({
      role: "assistant",
      content: result.text,
      ...(result.toolCalls.length ? { toolCalls: result.toolCalls } : {}),
    });

    switch (result.stopReason) {
      case "refusal":
        return { kind: "refusal", messages };
      case "max_tokens":
        return { kind: "max_tokens", messages };
      case "pause":
        // Reenvío tal cual para que el modelo continúe (server tools). En v1
        // no usamos server tools, así que en la práctica no dispara.
        continue;
      case "end":
        return { kind: "agent_done", text: result.text, messages };
      case "tool_use":
        break;
    }

    // El escape hatch se intercepta ANTES de ejecutar nada: pausa la tarea.
    const flag = result.toolCalls.find((c) => c.name === FLAG_DECISION_TOOL);
    if (flag) {
      const args = flag.args as { summary?: unknown } | null;
      const summary =
        typeof args?.summary === "string" ? args.summary : JSON.stringify(flag.args);
      messages.push({
        role: "tool_results",
        results: [
          {
            callId: flag.id,
            content: "escalada solicitada; tarea pausada para decisión humana",
          },
        ],
      });
      return { kind: "decision_flagged", summary, messages };
    }

    // Ejecución SIEMPRE serial y en orden: dos write_file en paralelo sobre el
    // mismo repo es una carrera. caps.parallelToolCalls describe al modelo
    // (cuántas calls emite por turno), no a nuestra ejecución.
    const results: ToolResult[] = [];
    for (const call of result.toolCalls) {
      deps.onEvent?.({ type: "tool_call", call });
      const tool = registry.get(call.name);
      let toolResult: ToolResult;
      if (!tool) {
        toolResult = {
          callId: call.id,
          content: `tool desconocida: '${call.name}' no existe en esta fase`,
          isError: true,
        };
      } else {
        try {
          toolResult = { callId: call.id, content: truncate(await tool.execute(call.args)) };
        } catch (err) {
          toolResult = {
            callId: call.id,
            content: truncate(err instanceof Error ? err.message : String(err)),
            isError: true,
          };
        }
      }
      deps.onEvent?.({ type: "tool_result", result: toolResult });
      results.push(toolResult);
    }
    // Un solo mensaje con TODOS los resultados del turno (contrato del seam).
    messages.push({ role: "tool_results", results });
  }

  return { kind: "turn_limit", messages };
}
