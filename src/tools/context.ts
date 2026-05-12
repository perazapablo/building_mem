import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  buildContext,
  checkpoint,
  getWorkingState,
  setWorkingState,
  updateProjectContextSummary,
} from "../db.js";

export function registerContextTools(server: McpServer) {
  server.tool(
    "set_working_state",
    `Stores the active working state for one session.
Use during work whenever focus, open threads, or pinned memory changes. This makes build_context prioritize the right entities for this session.`,
    {
      session_id: z.string().describe("Session ID"),
      focus: z.string().describe("Current work focus"),
      open_threads: z.array(z.string()).describe("Open topics or unresolved threads"),
      pinned_ids: z
        .array(z.string())
        .describe("Pinned IDs. May use raw id or type:id, for example code_entity:abc"),
    },
    async ({ session_id, focus, open_threads, pinned_ids }) => {
      setWorkingState(session_id, focus, open_threads, pinned_ids);
      return { content: [{ type: "text", text: "Working state updated." }] };
    },
  );

  server.tool(
    "get_working_state",
    "Returns active focus, open threads, and pinned memory for one session.",
    {
      session_id: z.string().describe("Session ID"),
    },
    async ({ session_id }) => {
      const result = getWorkingState(session_id);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "update_project_context_summary",
    `Updates the compact project-level context summary.
Use when stable project state changes: current capabilities, architecture, constraints, important pending work.
The agent/model writes this summary. The MCP stores it.`,
    {
      project_id: z.string().describe("Project ID"),
      context_summary: z.string().describe("Compact stable project context summary"),
    },
    async ({ project_id, context_summary }) => {
      updateProjectContextSummary(project_id, context_summary);
      return { content: [{ type: "text", text: "Project context summary updated." }] };
    },
  );

  server.tool(
    "build_context",
    `Builds a token-aware context bundle from persistent DB memory.
Use after identifying the project and before answering/working on project-specific tasks. This is the main source-of-truth load path.
Includes active notes, decisions, artifacts, and code_entities. Prioritizes this session's pinned_ids, then importance, then recency. Respects token_budget with an internal margin.
If session_id is omitted, uses global pins only for backward compatibility.`,
    {
      project_id: z.string().describe("Project ID"),
      token_budget: z.number().describe("Maximum token budget for returned context"),
      session_id: z
        .string()
        .optional()
        .describe("Session ID used to prioritize only that session's pinned_ids"),
    },
    async ({ project_id, token_budget, session_id }) => {
      const result = buildContext(project_id, token_budget, session_id);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "checkpoint",
    `Consolidates a session or work stage into persistent memory.
Use at the end of a meaningful stage, and also during long sessions after major changes.
The agent/model must provide dense summaries when possible. The MCP does not call an LLM.
session_summary: compact session index (~300 tokens max): goal, tools/functions touched, decisions, changes, final state.
context_summary: stable project state: current capabilities, architecture/constraints, pending work. No transcript or narrative.
If context_summary is omitted, MCP generates a mechanical fallback from stored DB context.`,
    {
      session_id: z.string().describe("Session ID to consolidate"),
      project_id: z.string().describe("Associated project ID"),
      session_summary: z
        .string()
        .optional()
        .describe("Dense session summary (~300 tokens max); replaces sessions.summary if provided"),
      context_summary: z
        .string()
        .optional()
        .describe("Stable project summary; if omitted, a mechanical fallback is generated"),
      token_budget: z
        .number()
        .optional()
        .describe("Budget for the associated build_context call (default: 4000)"),
    },
    async ({
      session_id,
      project_id,
      session_summary,
      context_summary,
      token_budget,
    }) => {
      const result = checkpoint(session_id, project_id, {
        session_summary,
        context_summary,
        token_budget,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );
}
