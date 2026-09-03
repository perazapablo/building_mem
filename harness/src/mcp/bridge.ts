// Bridge MCP: expone tools de un server MCP (el memory Rust por stdio) como
// HarnessTools. La pieza clave es `bound`: args que el harness estampa y el
// modelo ni ve ni puede pisar — project_id, session_id y phase salen del
// estado del harness, no del payload del modelo. El schema que ve el modelo
// es el del server MENOS las claves bound.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { HarnessTool } from "../core/tools.js";

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface MakeToolOptions {
  /** Args estampados por el harness; pisan cualquier intento del modelo. */
  bound?: () => Record<string, unknown>;
  description?: string;
}

export interface McpBridge {
  listToolNames(): string[];
  makeTool(name: string, options?: MakeToolOptions): HarnessTool;
  /** Llamada directa (para el orquestador: set_focus, checkpoint...). */
  call(name: string, args: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

/** Quita del schema las claves que el harness estampa: el modelo no las ve. */
export function pruneBoundKeys(
  schema: Record<string, unknown>,
  boundKeys: string[],
): Record<string, unknown> {
  if (!boundKeys.length) return schema;
  const drop = new Set(boundKeys);
  const out: Record<string, unknown> = { ...schema };
  const properties = out.properties as Record<string, unknown> | undefined;
  if (properties) {
    out.properties = Object.fromEntries(
      Object.entries(properties).filter(([key]) => !drop.has(key)),
    );
  }
  const required = out.required as string[] | undefined;
  if (Array.isArray(required)) {
    out.required = required.filter((key) => !drop.has(key));
  }
  return out;
}

interface CallToolResultLike {
  isError?: boolean;
  content?: unknown;
}

function extractText(result: CallToolResultLike): string {
  const blocks = Array.isArray(result.content) ? result.content : [];
  const text = blocks
    .filter((b): b is { type: "text"; text: string } => {
      const block = b as { type?: unknown; text?: unknown };
      return block.type === "text" && typeof block.text === "string";
    })
    .map((b) => b.text)
    .join("\n");
  if (result.isError) {
    // El error del server (ej: TipConflict con el tip vigente) es evidencia
    // para el modelo, no una excepción del harness: viaja como isError.
    throw new Error(text || "MCP tool error sin detalle");
  }
  return text;
}

async function buildBridge(client: Client, owned: boolean): Promise<McpBridge> {
  const listed = await client.listTools();
  const tools = new Map<string, McpToolInfo>(
    listed.tools.map((t) => [
      t.name,
      {
        name: t.name,
        ...(t.description !== undefined ? { description: t.description } : {}),
        inputSchema: t.inputSchema as Record<string, unknown>,
      },
    ]),
  );

  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const result = await client.callTool({ name, arguments: args });
    return extractText(result as CallToolResultLike);
  };

  return {
    listToolNames: () => [...tools.keys()],

    makeTool(name, options = {}): HarnessTool {
      const info = tools.get(name);
      if (!info) {
        throw new Error(
          `el server MCP no expone la tool '${name}' (tiene: ${[...tools.keys()].join(", ")})`,
        );
      }
      const boundKeys = options.bound ? Object.keys(options.bound()) : [];
      return {
        def: {
          name,
          description: options.description ?? info.description ?? "",
          inputSchema: pruneBoundKeys(info.inputSchema, boundKeys),
        },
        async execute(raw: unknown): Promise<string> {
          const modelArgs =
            raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
          // bound al final: el harness siempre gana.
          return call(name, { ...modelArgs, ...(options.bound?.() ?? {}) });
        },
      };
    },

    call,

    async close() {
      if (owned) await client.close();
    },
  };
}

export interface StdioMcpOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Levanta el server por stdio (el binario Rust) y conecta. */
export async function connectStdioMcp(options: StdioMcpOptions): Promise<McpBridge> {
  const client = new Client({ name: "harness", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: options.command,
    args: options.args ?? [],
    ...(options.env ? { env: { ...process.env as Record<string, string>, ...options.env } } : {}),
  });
  await client.connect(transport);
  return buildBridge(client, true);
}

/** Para tests: bridge sobre un Client ya conectado (in-memory transport). */
export async function bridgeFromClient(client: Client): Promise<McpBridge> {
  return buildBridge(client, false);
}

// ── Las tools de memoria que ve el agente ───────────────────────────────────

export interface MemoryToolsCtx {
  projectId: string;
  sessionId: string;
  /** La fase la estampa el harness desde TaskState — nunca el modelo. */
  getPhase(): string | null;
}

export function createMemoryTools(bridge: McpBridge, ctx: MemoryToolsCtx): HarnessTool[] {
  return [
    bridge.makeTool("search_all", {
      bound: () => ({ project_id: ctx.projectId }),
    }),
    bridge.makeTool("context_for_topic", {
      bound: () => ({ project_id: ctx.projectId }),
    }),
    bridge.makeTool("decision_record", {
      bound: () => {
        const phase = ctx.getPhase();
        return {
          project_id: ctx.projectId,
          session_id: ctx.sessionId,
          ...(phase ? { phase } : {}),
        };
      },
    }),
  ];
}

/** Protocolo de memoria: focus antes del primer write de la sesión. */
export async function setFocus(
  bridge: McpBridge,
  ctx: { projectId: string; sessionId: string },
  focus: string,
): Promise<void> {
  await bridge.call("set_focus", {
    session_id: ctx.sessionId,
    project_id: ctx.projectId,
    focus,
  });
}
