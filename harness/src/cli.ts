#!/usr/bin/env node
// CLI del esqueleto andante: `harness run "título" [--desc ...]`.
// Cáscara fina: prompter readline + wiring de adapter/memoria/tools.
// Toda la lógica vive en core/ — acá no se decide nada.

import { randomUUID } from "node:crypto";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { createAnthropicAdapter, createOpenAICompatAdapter } from "./adapters/index.js";
import { runTask, type Prompter } from "./core/orchestrator.js";
import type { TaskState } from "./core/task.js";
import type { ModelAdapter } from "./core/types.js";
import { connectStdioMcp, createMemoryTools, setFocus, type McpBridge } from "./mcp/bridge.js";
import { createLocalTools, defaultExec } from "./tools/local.js";

function readlinePrompter(rl: readline.Interface): Prompter {
  return {
    async ask(question) {
      return (await rl.question(`${question} `)).trim();
    },
    async confirm(question) {
      const a = (await rl.question(`${question} (s/n) `)).trim().toLowerCase();
      return a === "s" || a === "si" || a === "sí" || a === "y";
    },
    async choose(question, options, suggested) {
      const a = (
        await rl.question(`${question} [${options.join("/")}] (default: ${suggested}) `)
      )
        .trim()
        .toLowerCase();
      return options.includes(a) ? a : suggested;
    },
  };
}

function buildAdapter(spec: string): ModelAdapter {
  const sep = spec.indexOf(":");
  const kind = sep === -1 ? spec : spec.slice(0, sep);
  const model = sep === -1 ? "" : spec.slice(sep + 1);
  if (kind === "anthropic") {
    return createAnthropicAdapter(model ? { model } : {});
  }
  if (kind === "openai-compat") {
    if (!model) throw new Error("openai-compat requiere modelo: openai-compat:<modelo>");
    const baseURL = process.env.OPENAI_BASE_URL;
    return createOpenAICompatAdapter({
      model,
      ...(baseURL ? { baseURL } : {}),
      ...(process.env.OPENAI_API_KEY ? { apiKey: process.env.OPENAI_API_KEY } : {}),
    });
  }
  throw new Error(`adapter desconocido: '${kind}' (anthropic | openai-compat)`);
}

interface Args {
  title: string;
  desc: string;
  build?: string;
  test?: string;
  noMemory: boolean;
}

function parseArgs(argv: string[]): Args {
  if (argv[0] !== "run" || !argv[1]) {
    console.error('uso: harness run "título de la tarea" [--desc "..."] [--build cmd] [--test cmd] [--no-memory]');
    process.exit(2);
  }
  const args: Args = { title: argv[1], desc: "", noMemory: false };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case "--desc":
        args.desc = argv[++i] ?? "";
        break;
      case "--build":
        args.build = argv[++i] ?? "";
        break;
      case "--test":
        args.test = argv[++i] ?? "";
        break;
      case "--no-memory":
        args.noMemory = true;
        break;
      default:
        console.error(`flag desconocida: ${argv[i]}`);
        process.exit(2);
    }
  }
  return args;
}

interface Memory {
  bridge: McpBridge;
  projectId: string;
  context?: string;
}

async function connectMemory(projectDir: string, sessionId: string, title: string): Promise<Memory | null> {
  const bin =
    process.env.MCP_MEMORY_BIN ??
    path.resolve(projectDir, "../rust/target/release/mcp-memory.exe");
  let bridge: McpBridge;
  try {
    bridge = await connectStdioMcp({ command: bin });
  } catch (err) {
    console.error(`[memoria] sin server MCP (${bin}): ${String(err)} — sigo sin memoria`);
    return null;
  }
  try {
    const resolved = JSON.parse(
      await bridge.call("resolve_project_by_path", { path: projectDir }),
    ) as { project_id?: string; id?: string } | null;
    const projectId = resolved?.project_id ?? resolved?.id;
    if (!projectId) {
      console.error("[memoria] el path no resuelve a ningún proyecto — sigo sin memoria");
      await bridge.close();
      return null;
    }
    await setFocus(bridge, { projectId, sessionId }, `harness: ${title}`);
    let context: string | undefined;
    try {
      context = await bridge.call("build_context", { project_id: projectId, token_budget: 3000 });
    } catch {
      // sin contexto durable no es fatal
    }
    return { bridge, projectId, ...(context ? { context } : {}) };
  } catch (err) {
    console.error(`[memoria] error resolviendo proyecto: ${String(err)} — sigo sin memoria`);
    await bridge.close();
    return null;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const projectDir = process.cwd();
  const harnessDir = path.join(projectDir, ".harness");
  const sessionId = randomUUID();
  const adapter = buildAdapter(process.env.HARNESS_MODEL ?? "anthropic:claude-opus-5");

  const memory = args.noMemory ? null : await connectMemory(projectDir, sessionId, args.title);

  let live: TaskState | null = null;
  const tools = [
    ...createLocalTools({
      projectDir,
      harnessDir,
      getState: () => {
        if (!live) throw new Error("estado no inicializado");
        return live;
      },
    }),
    ...(memory
      ? createMemoryTools(memory.bridge, {
          projectId: memory.projectId,
          sessionId,
          getPhase: () => live?.phase ?? null,
        })
      : []),
  ];

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const state = await runTask(
      {
        title: args.title,
        description: args.desc,
        project_id: memory?.projectId ?? "sin-memoria",
        session_id: sessionId,
        commands: {
          ...(args.build ? { build: args.build } : {}),
          ...(args.test ? { test: args.test } : {}),
        },
      },
      {
        adapter,
        prompter: readlinePrompter(rl),
        projectDir,
        tools,
        exec: defaultExec,
        ...(memory?.context ? { memoryContext: memory.context } : {}),
        onState: (s) => {
          live = s;
        },
        onEvent: (e) => {
          if (e.type === "assistant" && e.text) console.log(`\n${e.text}\n`);
          if (e.type === "tool_call") console.log(`  → ${e.call.name}`);
          if (e.type === "tool_result" && e.result.isError)
            console.log(`  ✗ ${e.result.content.slice(0, 200)}`);
        },
        log: (line) => console.log(`[harness] ${line}`),
        effort: "high",
      },
    );
    console.log(`\n[harness] estado final: ${state.status} (fase: ${state.phase})`);
  } finally {
    rl.close();
    await memory?.bridge.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
