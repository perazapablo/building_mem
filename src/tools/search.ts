import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { searchAll } from "../db.js";

export function registerSearchTools(server: McpServer) {
  server.tool(
    "search_all",
    `Searches notes, decisions, artifacts, and code_entities in one FTS5 call.
Use when the DB should answer a question but the memory type is unknown.
For project work, pass project_id whenever possible. Default excludes obsolete memory; include obsolete only for audit/history/recovery.`,
    {
      query: z.string().describe("Search text"),
      project_id: z.string().optional().describe("Filter by project"),
      limit: z.number().optional().describe("Maximum total results (default: 10, max: 50)"),
      include_obsolete: z.boolean().optional().describe("If true, include obsolete entities"),
    },
    async ({ query, project_id, limit, include_obsolete }) => {
      const result = searchAll(query, project_id, limit ?? 10, include_obsolete ?? false);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );
}
