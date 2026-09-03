// Adapter OpenAI-compatible: cubre OpenAI y todo server que hable su
// protocolo (Ollama, Groq, DeepSeek, vLLM...) vía baseURL. Mismo contrato
// que el adapter Anthropic: traductor puro, mapeos exportados y testeables
// sin red, cero fallbacks propios.

import OpenAI from "openai";

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

// Defaults conservadores: un server compatible arbitrario no declara nada.
// Para un modelo concreto se pisan por opciones (caps).
const DEFAULT_CAPS: Capabilities = {
  contextWindow: 128_000,
  maxOutput: 16_384,
  parallelToolCalls: true,
  strictTools: false,
  promptCaching: "automatic",
  reasoning: "optional",
};

const STOP_MAP: Record<string, StopReason> = {
  stop: "end",
  tool_calls: "tool_use",
  function_call: "tool_use",
  length: "max_tokens",
  content_filter: "refusal",
};

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export function toOpenAIMessages(system: string, messages: Msg[]): ChatMessage[] {
  const out: ChatMessage[] = [{ role: "system", content: system }];
  for (const m of messages) {
    switch (m.role) {
      case "user":
        out.push({ role: "user", content: m.content });
        break;
      case "assistant":
        if (m.toolCalls?.length) {
          out.push({
            role: "assistant",
            content: m.content || null,
            tool_calls: m.toolCalls.map((c) => ({
              id: c.id,
              type: "function" as const,
              function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
            })),
          });
        } else {
          out.push({ role: "assistant", content: m.content });
        }
        break;
      case "tool_results":
        // El protocolo OpenAI exige UN mensaje role:"tool" por resultado,
        // contiguos tras el assistant que los pidió — la agrupación neutral
        // del harness se expande acá.
        for (const r of m.results) {
          out.push({ role: "tool", tool_call_id: r.callId, content: r.content });
        }
        break;
    }
  }
  return out;
}

export function toOpenAITools(
  tools: ToolDef[],
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // Args malformados: se preservan crudos para que el loop los rechace
    // con evidencia en vez de perderlos en una excepción del adapter.
    return { __unparsed: raw };
  }
}

export function fromOpenAIResponse(
  response: OpenAI.Chat.Completions.ChatCompletion,
): GenerateResult {
  const choice = response.choices[0];
  if (!choice) {
    throw new Error("openai-compat: response without choices");
  }
  const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).flatMap((c) =>
    c.type === "function"
      ? [{ id: c.id, name: c.function.name, args: parseArgs(c.function.arguments) }]
      : [],
  );
  return {
    text: choice.message.content ?? "",
    toolCalls,
    stopReason: STOP_MAP[choice.finish_reason ?? "stop"] ?? "end",
    usage: {
      input: response.usage?.prompt_tokens ?? 0,
      output: response.usage?.completion_tokens ?? 0,
      cacheRead: response.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      cacheWrite: 0, // el caching automático no reporta escrituras
    },
  };
}

export interface OpenAICompatAdapterOptions {
  model: string;
  baseURL?: string;
  apiKey?: string;
  caps?: Partial<Capabilities>;
  /** Inyectable para tests. */
  client?: OpenAI;
}

export function createOpenAICompatAdapter(
  options: OpenAICompatAdapterOptions,
): ModelAdapter {
  const client =
    options.client ??
    new OpenAI({
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      // Servers locales (Ollama, vLLM) no validan la key pero el SDK la exige.
      apiKey: options.apiKey ?? "not-needed",
    });
  const caps: Capabilities = { ...DEFAULT_CAPS, ...options.caps };

  return {
    id: `openai-compat:${options.model}`,
    caps,
    async generate(req: GenerateRequest): Promise<GenerateResult> {
      const response = await client.chat.completions.create({
        model: options.model,
        max_completion_tokens: req.maxTokens,
        messages: toOpenAIMessages(req.system, req.messages),
        ...(req.tools.length ? { tools: toOpenAITools(req.tools) } : {}),
        ...(req.effort && caps.reasoning !== "none"
          ? { reasoning_effort: req.effort }
          : {}),
      });
      return fromOpenAIResponse(response);
    },
  };
}
