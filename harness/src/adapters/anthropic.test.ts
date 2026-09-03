import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

import type { Msg } from "../core/types.js";
import {
  createAnthropicAdapter,
  fromAnthropicResponse,
  toAnthropicMessages,
} from "./anthropic.js";

function fakeResponse(overrides: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content: [{ type: "text", text: "hola", citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 10,
    } as Anthropic.Usage,
    ...overrides,
  } as Anthropic.Message;
}

describe("toAnthropicMessages", () => {
  it("agrupa todos los tool_results en UN solo mensaje user", () => {
    const msgs: Msg[] = [
      { role: "user", content: "hacé dos cosas" },
      {
        role: "assistant",
        content: "voy",
        toolCalls: [
          { id: "t1", name: "read_file", args: { path: "a.ts" } },
          { id: "t2", name: "read_file", args: { path: "b.ts" } },
        ],
      },
      {
        role: "tool_results",
        results: [
          { callId: "t1", content: "contenido a" },
          { callId: "t2", content: "falló", isError: true },
        ],
      },
    ];
    const out = toAnthropicMessages(msgs);
    expect(out).toHaveLength(3);

    const assistant = out[1]!;
    const blocks = assistant.content as Anthropic.ContentBlockParam[];
    expect(blocks.map((b) => b.type)).toEqual(["text", "tool_use", "tool_use"]);

    const results = out[2]!;
    expect(results.role).toBe("user");
    const resultBlocks = results.content as Anthropic.ToolResultBlockParam[];
    expect(resultBlocks).toHaveLength(2);
    expect(resultBlocks[0]).toMatchObject({ type: "tool_result", tool_use_id: "t1" });
    expect(resultBlocks[1]).toMatchObject({ tool_use_id: "t2", is_error: true });
  });

  it("assistant sin toolCalls queda como string plano", () => {
    const out = toAnthropicMessages([{ role: "assistant", content: "listo" }]);
    expect(out[0]).toEqual({ role: "assistant", content: "listo" });
  });
});

describe("fromAnthropicResponse", () => {
  it("mapea texto, usage y stop_reason end_turn → end", () => {
    const r = fromAnthropicResponse(fakeResponse());
    expect(r.text).toBe("hola");
    expect(r.stopReason).toBe("end");
    expect(r.usage).toEqual({ input: 100, output: 20, cacheRead: 80, cacheWrite: 10 });
  });

  it("extrae tool calls y mapea tool_use", () => {
    const r = fromAnthropicResponse(
      fakeResponse({
        content: [
          { type: "text", text: "reviso", citations: null },
          { type: "tool_use", id: "t1", name: "grep", input: { pattern: "x" } },
        ] as Anthropic.ContentBlock[],
        stop_reason: "tool_use",
      }),
    );
    expect(r.stopReason).toBe("tool_use");
    expect(r.toolCalls).toEqual([{ id: "t1", name: "grep", args: { pattern: "x" } }]);
  });

  it.each([
    ["end_turn", "end"],
    ["stop_sequence", "end"],
    ["max_tokens", "max_tokens"],
    ["pause_turn", "pause"],
    ["refusal", "refusal"],
  ] as const)("stop_reason %s → %s", (input, expected) => {
    const r = fromAnthropicResponse(
      fakeResponse({ stop_reason: input as Anthropic.Message["stop_reason"] }),
    );
    expect(r.stopReason).toBe(expected);
  });
});

describe("createAnthropicAdapter", () => {
  it("genera contra un cliente inyectado, sin red", async () => {
    let captured: unknown;
    const stub = {
      messages: {
        create: async (params: unknown) => {
          captured = params;
          return fakeResponse();
        },
      },
    } as unknown as Anthropic;

    const adapter = createAnthropicAdapter({ client: stub, model: "claude-opus-5" });
    const result = await adapter.generate({
      system: "sos un harness",
      messages: [{ role: "user", content: "hola" }],
      tools: [],
      maxTokens: 1000,
      effort: "high",
    });

    expect(adapter.id).toBe("anthropic:claude-opus-5");
    expect(result.text).toBe("hola");
    const params = captured as Record<string, unknown>;
    expect(params.model).toBe("claude-opus-5");
    expect(params.output_config).toEqual({ effort: "high" });
    // El system lleva el breakpoint de cache al final del prefijo estable.
    expect(params.system).toEqual([
      { type: "text", text: "sos un harness", cache_control: { type: "ephemeral" } },
    ]);
    // Sin tools no se manda el campo (tool set vacío ≠ tool set ausente para el cache).
    expect("tools" in params).toBe(false);
  });
});
