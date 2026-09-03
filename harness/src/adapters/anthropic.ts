// Adapter Anthropic: traduce los tipos neutrales del harness al SDK oficial
// y de vuelta. Traductor puro — sin retries propios (los trae el SDK), sin
// fallbacks (viven en el loop, keyed por caps). Las funciones de mapeo son
// puras y exportadas: se testean sin red.

import Anthropic from "@anthropic-ai/sdk";

import type {
  Capabilities,
  GenerateRequest,
  GenerateResult,
  ModelAdapter,
  Msg,
  StopReason,
  ToolCall,
  ToolDef,
} from "../core/types.js";

const DEFAULT_MODEL = "claude-opus-5";

const DEFAULT_CAPS: Capabilities = {
  contextWindow: 1_000_000,
  maxOutput: 128_000,
  parallelToolCalls: true,
  strictTools: false, // strict:true exige additionalProperties:false en cada schema; v1 valida el loop
  promptCaching: "explicit",
  reasoning: "always_on",
};

const STOP_MAP: Record<string, StopReason> = {
  end_turn: "end",
  stop_sequence: "end",
  tool_use: "tool_use",
  max_tokens: "max_tokens",
  pause_turn: "pause",
  refusal: "refusal",
};

export function toAnthropicMessages(messages: Msg[]): Anthropic.MessageParam[] {
  return messages.map((m): Anthropic.MessageParam => {
    switch (m.role) {
      case "user":
        return { role: "user", content: m.content };
      case "assistant": {
        if (!m.toolCalls?.length) {
          return { role: "assistant", content: m.content };
        }
        const blocks: Anthropic.ContentBlockParam[] = [];
        if (m.content) {
          blocks.push({ type: "text", text: m.content });
        }
        for (const call of m.toolCalls) {
          blocks.push({
            type: "tool_use",
            id: call.id,
            name: call.name,
            input: call.args ?? {},
          });
        }
        return { role: "assistant", content: blocks };
      }
      case "tool_results":
        // Un solo mensaje user con TODOS los tool_result del turno.
        return {
          role: "user",
          content: m.results.map((r): Anthropic.ToolResultBlockParam => ({
            type: "tool_result",
            tool_use_id: r.callId,
            content: r.content,
            ...(r.isError ? { is_error: true } : {}),
          })),
        };
    }
  });
}

export function toAnthropicTools(tools: ToolDef[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));
}

export function fromAnthropicResponse(response: Anthropic.Message): GenerateResult {
  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];
  for (const block of response.content) {
    if (block.type === "text") {
      textParts.push(block.text);
    } else if (block.type === "tool_use") {
      toolCalls.push({ id: block.id, name: block.name, args: block.input });
    }
  }
  return {
    text: textParts.join(""),
    toolCalls,
    stopReason: STOP_MAP[response.stop_reason ?? "end_turn"] ?? "end",
    usage: {
      input: response.usage.input_tokens,
      output: response.usage.output_tokens,
      cacheRead: response.usage.cache_read_input_tokens ?? 0,
      cacheWrite: response.usage.cache_creation_input_tokens ?? 0,
    },
  };
}

export interface AnthropicAdapterOptions {
  model?: string;
  apiKey?: string;
  caps?: Partial<Capabilities>;
  /** Inyectable para tests — el adapter jamás crea red si le pasan el cliente. */
  client?: Anthropic;
}

export function createAnthropicAdapter(options: AnthropicAdapterOptions = {}): ModelAdapter {
  const model = options.model ?? DEFAULT_MODEL;
  const client =
    options.client ??
    new Anthropic(options.apiKey ? { apiKey: options.apiKey } : {});
  const caps: Capabilities = { ...DEFAULT_CAPS, ...options.caps };

  return {
    id: `anthropic:${model}`,
    caps,
    async generate(req: GenerateRequest): Promise<GenerateResult> {
      const response = await client.messages.create({
        model,
        max_tokens: req.maxTokens,
        // Breakpoint explícito al final del system: el prefijo estable
        // (tools + system, que el ensamblador garantiza byte-idéntico)
        // queda cacheado; la conversación variable va después.
        system: [
          {
            type: "text",
            text: req.system,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: toAnthropicMessages(req.messages),
        ...(req.tools.length ? { tools: toAnthropicTools(req.tools) } : {}),
        ...(req.effort ? { output_config: { effort: req.effort } } : {}),
      });
      return fromAnthropicResponse(response);
    },
  };
}
