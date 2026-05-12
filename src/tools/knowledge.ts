import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  addArtifact,
  addDecision,
  addNote,
  searchNotes,
} from "../db.js";

export function registerKnowledgeTools(server: McpServer) {
  server.tool(
    "add_note",
    `Stores one atomic durable fact in project memory.
Use during the session whenever a fact becomes useful for future continuity.
Store one concept, observation, constraint, or user preference. Do not store transcripts, trivial facts, or information already obvious from current code.`,
    {
      project_id: z.string().describe("Project ID"),
      content: z.string().describe("Atomic, precise note content"),
      tags: z.array(z.string()).describe("Search tags"),
      importance: z.number().min(1).max(5).optional().describe("Importance from 1 to 5 (default: 3)"),
      topic_key: z.string().optional().describe("Stable semantic collision key. Same active topic updates instead of inserting."),
    },
    async ({ project_id, content, tags, importance, topic_key }) => {
      const id = addNote(project_id, content, tags, importance, topic_key);
      return { content: [{ type: "text", text: JSON.stringify({ id }) }] };
    },
  );

  server.tool(
    "add_decision",
    `Stores an important decision with its reasoning.
Use when a technical, architectural, product, or workflow decision is made.
The decision should state what was chosen. The reasoning should state why, including relevant rejected alternatives when useful.`,
    {
      project_id: z.string().describe("Project ID"),
      decision: z.string().describe("What was decided"),
      reasoning: z.string().describe("Why this decision was made"),
      importance: z.number().min(1).max(5).optional().describe("Importance from 1 to 5 (default: 3)"),
      topic_key: z.string().optional().describe("Stable semantic collision key. Same active topic updates instead of inserting."),
    },
    async ({ project_id, decision, reasoning, importance, topic_key }) => {
      const id = addDecision(project_id, decision, reasoning, importance, topic_key);
      return { content: [{ type: "text", text: JSON.stringify({ id }) }] };
    },
  );

  server.tool(
    "add_artifact",
    `Stores a durable structured output such as a schema, API contract, config, design, plan, or prompt.
Use when the exact content is useful to retrieve later. Keep it focused; avoid dumping raw conversation.`,
    {
      project_id: z.string().describe("Project ID"),
      type: z.string().describe("Artifact type: schema | api | config | design | plan | prompt | etc."),
      content: z.string().describe("Artifact content"),
      importance: z.number().min(1).max(5).optional().describe("Importance from 1 to 5 (default: 3)"),
      topic_key: z.string().optional().describe("Stable semantic collision key. Same active topic updates instead of inserting."),
    },
    async ({ project_id, type, content, importance, topic_key }) => {
      const id = addArtifact(project_id, type, content, importance, topic_key);
      return { content: [{ type: "text", text: JSON.stringify({ id }) }] };
    },
  );

  server.tool(
    "search_notes",
    `Searches active notes with FTS5.
Use when looking for a specific remembered fact. Prefer search_all when the memory type is unknown.
Default excludes obsolete notes. Use include_obsolete=true only for history/audit questions.`,
    {
      query: z.string().describe("Search text"),
      project_id: z.string().optional().describe("Filter by project when possible"),
      limit: z.number().optional().describe("Max results (default: 5, max: 5)"),
      include_obsolete: z.boolean().optional().describe("If true, include obsolete notes. Default: false."),
    },
    async ({ query, project_id, limit, include_obsolete }) => {
      const results = searchNotes(
        query,
        project_id,
        Math.min(limit ?? 5, 5),
        include_obsolete ?? false,
      );
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    },
  );
}
