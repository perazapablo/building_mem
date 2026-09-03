// Tipos neutrales del harness — el único vocabulario que el resto del código
// conoce. Ningún archivo fuera de adapters/ importa un SDK de proveedor ni
// contiene `if (provider === ...)`. Los adapters traducen ESTOS tipos a los
// de cada SDK y de vuelta; los fallbacks por capacidad faltante viven en el
// loop, keyed por `caps` — nunca dentro de un adapter.

// ── Mensajes ────────────────────────────────────────────────────────────────

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface ToolResult {
  callId: string;
  content: string;
  isError?: boolean;
}

export type Msg =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  // Todos los resultados de un turno viajan JUNTOS: partirlos en varios
  // mensajes degrada las tool calls paralelas del modelo.
  | { role: "tool_results"; results: ToolResult[] };

// ── Tools ───────────────────────────────────────────────────────────────────

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema del input. */
  inputSchema: Record<string, unknown>;
}

// ── Request / Result ────────────────────────────────────────────────────────

export type Effort = "low" | "medium" | "high";

export interface GenerateRequest {
  /** Lo arma el ensamblador de contexto — byte-estable entre turnos. */
  system: string;
  messages: Msg[];
  /** Ya enmascaradas por PHASE_TOOLS antes de llegar acá. */
  tools: ToolDef[];
  maxTokens: number;
  /** Routing por fase: el adapter lo mapea a su parámetro nativo o lo ignora. */
  effort?: Effort;
}

export type StopReason =
  | "end"        // terminó natural  (Anthropic: end_turn/stop_sequence · OpenAI: stop)
  | "tool_use"   // pide ejecutar tools           (tool_use · tool_calls)
  | "max_tokens" // cortado por límite            (max_tokens · length)
  | "pause"      // reenviar tal cual p/continuar (pause_turn · —)
  | "refusal";   // rechazo de seguridad          (refusal · content_filter) → decide el humano

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface GenerateResult {
  text: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  usage: Usage;
}

// ── Capabilities ────────────────────────────────────────────────────────────

export interface Capabilities {
  contextWindow: number;
  maxOutput: number;
  parallelToolCalls: boolean;
  /** true = el server valida args contra el schema; false = valida el loop con Zod. */
  strictTools: boolean;
  promptCaching: "explicit" | "automatic" | "none";
  reasoning: "always_on" | "optional" | "none";
}

// ── El seam ─────────────────────────────────────────────────────────────────

export interface ModelAdapter {
  /** "anthropic:claude-opus-5" | "openai-compat:<modelo>" */
  readonly id: string;
  readonly caps: Capabilities;
  generate(req: GenerateRequest): Promise<GenerateResult>;
}
