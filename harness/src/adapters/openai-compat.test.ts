import { describe, expect, it } from "vitest";
import type OpenAI from "openai";

import type { Msg } from "../core/types.js";
import {
  createOpenAICompatAdapter,
  fromOpenAIResponse,
  toOpenAIMessages,
} from "./openai-compat.js";

function fakeResponse(
  overrides: Partial<OpenAI.Chat.Completions.ChatCompletion.Choice> = {},
  usage?: Partial<OpenAI.CompletionUsage>,
): OpenAI.Chat.Completions.ChatCompletion {
  return {
    id: "chatcmpl_test",
    object: "chat.completion",
    created: 0,
    model: "test-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "hola", refusal: null },
        finish_reason: "stop",
        logprobs: null,
        ...overrides,
      },
    ],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      ...usage,
    } as OpenAI.CompletionUsage,
  };
}

describe("toOpenAIMessages", () => {
  it("expande tool_results agrupados a un mensaje role:tool por resultado", () => {
    const msgs: Msg[] = [
      { role: "user", content: "hacé dos cosas" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "t1", name: "read_file", args: { path: "a.ts" } },
          { id: "t2", name: "read_file", args: { path: "b.ts" } },
        ],
      },
      {
        role: "tool_results",
        results: [
          { callId: "t1", content: "contenido a" },
          { callId: "t2", content: "contenido b" },
        ],
      },
    ];
    const out = toOpenAIMessages("sos un harness", msgs);
    // system + user + assistant + 2 mensajes tool
    expect(out.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "tool"]);

    const assistant = out[2] as OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam;
    expect(assistant.content).toBeNull();
    expect(assistant.tool_calls).toHaveLength(2);
    expect(assistant.tool_calls?.[0]).toMatchObject({
      id: "t1",
      type: "function",
      function: { name: "read_file", arguments: '{"path":"a.ts"}' },
    });

    const tool1 = out[3] as OpenAI.Chat.Completions.ChatCompletionToolMessageParam;
    expect(tool1.tool_call_id).toBe("t1");
    expect(tool1.content).toBe("contenido a");
  });

  it("el system del harness viaja como primer mensaje role:system", () => {
    const out = toOpenAIMessages("system X", [{ role: "user", content: "hola" }]);
    expect(out[0]).toEqual({ role: "system", content: "system X" });
  });
});

describe("fromOpenAIResponse", () => {
  it("mapea texto, usage y finish_reason stop → end", () => {
    const r = fromOpenAIResponse(
      fakeResponse({}, { prompt_tokens_details: { cached_tokens: 60 } }),
    );
    expect(r.text).toBe("hola");
    expect(r.stopReason).toBe("end");
    expect(r.usage).toEqual({ input: 100, output: 20, cacheRead: 60, cacheWrite: 0 });
  });

  it("parsea args JSON de tool calls y mapea tool_calls", () => {
    const r = fromOpenAIResponse(
      fakeResponse({
        message: {
          role: "assistant",
          content: null,
          refusal: null,
          tool_calls: [
            {
              id: "t1",
              type: "function",
              function: { name: "grep", arguments: '{"pattern":"x"}' },
            },
          ],
        },
        finish_reason: "tool_calls",
      }),
    );
    expect(r.stopReason).toBe("tool_use");
    expect(r.toolCalls).toEqual([{ id: "t1", name: "grep", args: { pattern: "x" } }]);
  });

  it("args malformados se preservan crudos en vez de tirar excepción", () => {
    const r = fromOpenAIResponse(
      fakeResponse({
        message: {
          role: "assistant",
          content: null,
          refusal: null,
          tool_calls: [
            { id: "t1", type: "function", function: { name: "grep", arguments: "{rot" } },
          ],
        },
        finish_reason: "tool_calls",
      }),
    );
    expect(r.toolCalls[0]?.args).toEqual({ __unparsed: "{rot" });
  });

  it.each([
    ["stop", "end"],
    ["length", "max_tokens"],
    ["content_filter", "refusal"],
  ] as const)("finish_reason %s → %s", (input, expected) => {
    const r = fromOpenAIResponse(
      fakeResponse({
        finish_reason: input as OpenAI.Chat.Completions.ChatCompletion.Choice["finish_reason"],
      }),
    );
    expect(r.stopReason).toBe(expected);
  });
});

describe("createOpenAICompatAdapter", () => {
  it("genera contra un cliente inyectado, sin red", async () => {
    let captured: unknown;
    const stub = {
      chat: {
        completions: {
          create: async (params: unknown) => {
            captured = params;
            return fakeResponse();
          },
        },
      },
    } as unknown as OpenAI;

    const adapter = createOpenAICompatAdapter({ client: stub, model: "llama3.3" });
    const result = await adapter.generate({
      system: "sos un harness",
      messages: [{ role: "user", content: "hola" }],
      tools: [
        {
          name: "grep",
          description: "busca",
          inputSchema: { type: "object", properties: { pattern: { type: "string" } } },
        },
      ],
      maxTokens: 1000,
      effort: "low",
    });

    expect(adapter.id).toBe("openai-compat:llama3.3");
    expect(result.text).toBe("hola");
    const params = captured as Record<string, unknown>;
    expect(params.model).toBe("llama3.3");
    expect(params.max_completion_tokens).toBe(1000);
    expect(params.reasoning_effort).toBe("low");
    expect(params.tools).toHaveLength(1);
  });

  it("caps.reasoning none suprime reasoning_effort", async () => {
    let captured: unknown;
    const stub = {
      chat: {
        completions: {
          create: async (params: unknown) => {
            captured = params;
            return fakeResponse();
          },
        },
      },
    } as unknown as OpenAI;

    const adapter = createOpenAICompatAdapter({
      client: stub,
      model: "llama3.3",
      caps: { reasoning: "none" },
    });
    await adapter.generate({
      system: "s",
      messages: [{ role: "user", content: "hola" }],
      tools: [],
      maxTokens: 100,
      effort: "high",
    });
    expect("reasoning_effort" in (captured as Record<string, unknown>)).toBe(false);
  });
});
