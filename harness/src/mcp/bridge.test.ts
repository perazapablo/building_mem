import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  bridgeFromClient,
  connectStdioMcp,
  createMemoryTools,
  pruneBoundKeys,
  setFocus,
  type McpBridge,
} from "./bridge.js";

// ── Server MCP falso en memoria ─────────────────────────────────────────────

async function fakeServer(): Promise<{ bridge: McpBridge; received: Record<string, unknown>[] }> {
  const received: Record<string, unknown>[] = [];
  const server = new McpServer({ name: "fake-memory", version: "0.0.0" });

  server.registerTool(
    "decision_record",
    {
      description: "graba una decisión",
      inputSchema: {
        project_id: z.string(),
        session_id: z.string(),
        topic_key: z.string(),
        statement: z.string(),
        phase: z.string().optional(),
      },
    },
    async (args) => {
      received.push(args as Record<string, unknown>);
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, got: args }) }] };
    },
  );

  for (const name of ["search_all", "context_for_topic"]) {
    server.registerTool(
      name,
      { description: name, inputSchema: { project_id: z.string(), query: z.string().optional(), topic_key: z.string().optional() } },
      async (args) => {
        received.push({ __tool: name, ...(args as Record<string, unknown>) });
        return { content: [{ type: "text", text: "{}" }] };
      },
    );
  }

  server.registerTool(
    "explota",
    { description: "siempre falla", inputSchema: {} },
    async () => ({
      content: [{ type: "text", text: "chain ya tiene tip activo: usá supersedes" }],
      isError: true,
    }),
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return { bridge: await bridgeFromClient(client), received };
}

describe("pruneBoundKeys", () => {
  it("quita las claves bound de properties y required", () => {
    const pruned = pruneBoundKeys(
      {
        type: "object",
        properties: { a: {}, project_id: {}, session_id: {} },
        required: ["a", "project_id"],
      },
      ["project_id", "session_id"],
    );
    expect(Object.keys(pruned.properties as object)).toEqual(["a"]);
    expect(pruned.required).toEqual(["a"]);
  });
});

describe("bridge", () => {
  it("el schema que ve el modelo NO tiene las claves estampadas", async () => {
    const { bridge } = await fakeServer();
    const tool = bridge.makeTool("decision_record", {
      bound: () => ({ project_id: "p1", session_id: "s1", phase: "planning" }),
    });
    const props = Object.keys(
      (tool.def.inputSchema.properties as Record<string, unknown>) ?? {},
    );
    expect(props).toEqual(["topic_key", "statement"]);
    expect(tool.def.inputSchema.required).toEqual(["topic_key", "statement"]);
  });

  it("bound pisa cualquier intento del modelo de mandar sus propios ids", async () => {
    const { bridge, received } = await fakeServer();
    const tool = bridge.makeTool("decision_record", {
      bound: () => ({ project_id: "p1", session_id: "s1", phase: "planning" }),
    });
    await tool.execute({
      topic_key: "t",
      statement: "x",
      project_id: "FALSO",
      session_id: "FALSO",
      phase: "implementation",
    });
    expect(received[0]).toMatchObject({
      project_id: "p1",
      session_id: "s1",
      phase: "planning",
      topic_key: "t",
    });
  });

  it("isError del server se vuelve throw: el loop lo marca isError para el modelo", async () => {
    const { bridge } = await fakeServer();
    const tool = bridge.makeTool("explota");
    await expect(tool.execute({})).rejects.toThrow(/tip activo/);
  });

  it("tool inexistente falla al construir, no al ejecutar", async () => {
    const { bridge } = await fakeServer();
    expect(() => bridge.makeTool("no_existe")).toThrow(/no expone la tool 'no_existe'/);
  });

  it("createMemoryTools estampa la fase VIVA desde el estado", async () => {
    const { bridge, received } = await fakeServer();
    let phase: string | null = "planning";
    const tools = createMemoryTools(bridge, {
      projectId: "p1",
      sessionId: "s1",
      getPhase: () => phase,
    });
    const dr = tools.find((t) => t.def.name === "decision_record")!;
    await dr.execute({ topic_key: "a", statement: "s1" });
    phase = "implementation";
    await dr.execute({ topic_key: "b", statement: "s2" });
    expect(received.map((r) => r.phase)).toEqual(["planning", "implementation"]);
  });
});

// ── Integración contra el binario Rust real, DB temporal ────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
const RUST_BIN = path.resolve(here, "../../../rust/target/release/mcp-memory.exe");

describe.skipIf(!existsSync(RUST_BIN))("integración con el server Rust", () => {
  let dir: string;
  let bridge: McpBridge;

  afterAll(async () => {
    await bridge?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("ciclo completo: upsert_project → set_focus → decision_record → context_for_topic → tip conflict", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "harness-mcp-"));
    bridge = await connectStdioMcp({
      command: RUST_BIN,
      env: { MCP_MEMORY_DB_PATH: path.join(dir, "mem.db") },
    });

    const upserted = JSON.parse(
      await bridge.call("upsert_project", {
        name: "harness_it",
        description: "test de integración del bridge",
        project_type: "development",
        tags: ["test"],
      }),
    ) as { outcome: string; id: string };
    expect(upserted.outcome).toBe("created");

    const ctx = { projectId: upserted.id, sessionId: "sess-bridge-it" };
    await setFocus(bridge, ctx, "test de integración del bridge MCP");

    const tools = createMemoryTools(bridge, { ...ctx, getPhase: () => "planning" });
    const dr = tools.find((t) => t.def.name === "decision_record")!;

    const recorded = JSON.parse(
      await dr.execute({
        topic_key: "bridge.test",
        statement: "el bridge estampa ids",
        origin: "agent_inferred",
        confidence: "decided",
      }),
    ) as { record: { id: string; phase: string; session_id: string } };
    expect(recorded.record.phase).toBe("planning");
    expect(recorded.record.session_id).toBe("sess-bridge-it");

    const cft = tools.find((t) => t.def.name === "context_for_topic")!;
    const chain = JSON.parse(await cft.execute({ topic_key: "bridge.test" })) as {
      chain: { id: string }[];
    };
    expect(chain.chain).toHaveLength(1);
    expect(chain.chain[0]!.id).toBe(recorded.record.id);

    // El gate anti-pisado del server viaja como error legible para el modelo.
    await expect(
      dr.execute({
        topic_key: "bridge.test",
        statement: "pisar sin supersedes",
        origin: "agent_inferred",
        confidence: "decided",
      }),
    ).rejects.toThrow(/supersedes/);
  }, 30_000);
});
