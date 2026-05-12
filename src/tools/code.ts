import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  addCodeEntity,
  getCodeEntity,
  getCodeEntityContext,
  searchCodeEntities,
  updateCodeEntity,
} from "../db.js";
import { codeEntityKindSchema } from "./schemas.js";

export function registerCodeTools(server: McpServer) {
  server.tool(
    "add_code_entity",
    `Stores structured memory about code: module, file, function, class, method, endpoint, config, or schema.
Use after inspecting code when future sessions should be able to answer what it does, where it lives, what it accepts/returns, or what side effects it has.
For example, this enables questions like: "What does the XML parser in billing do?"`,
    {
      project_id: z.string().describe("Project ID"),
      kind: codeEntityKindSchema.describe("Code entity type"),
      name: z.string().describe("Short name, for example parseInvoiceXml"),
      qualified_name: z.string().optional().describe("Qualified name, for example billing.xml.parseInvoiceXml"),
      path: z.string().optional().describe("File or module path"),
      signature: z.string().optional().describe("Function/method signature when applicable"),
      summary: z.string().optional().describe("What this entity does"),
      inputs: z.string().optional().describe("Relevant inputs"),
      outputs: z.string().optional().describe("Relevant outputs"),
      side_effects: z.string().optional().describe("Side effects, errors, external calls, or writes"),
      tags: z.array(z.string()).optional().describe("Search tags"),
      importance: z.number().min(1).max(5).optional().describe("Importance from 1 to 5 (default: 3)"),
      topic_key: z
        .string()
        .optional()
        .describe("Stable semantic collision key. Defaults to qualified_name or name and is never null."),
    },
    async ({
      project_id,
      kind,
      name,
      qualified_name,
      path,
      signature,
      summary,
      inputs,
      outputs,
      side_effects,
      tags,
      importance,
      topic_key,
    }) => {
      const id = addCodeEntity(
        project_id,
        kind,
        name,
        qualified_name ?? "",
        path ?? "",
        signature ?? "",
        summary ?? "",
        inputs ?? "",
        outputs ?? "",
        side_effects ?? "",
        tags ?? [],
        importance ?? 3,
        topic_key,
      );
      return { content: [{ type: "text", text: JSON.stringify({ id }) }] };
    },
  );

  server.tool(
    "update_code_entity",
    `Updates structured memory for an existing code entity.
Use when current code contradicts stored memory or more precise details were discovered. Do not create duplicates for the same entity.`,
    {
      id: z.string().describe("Code entity ID"),
      kind: codeEntityKindSchema.optional().describe("New kind"),
      name: z.string().optional().describe("New short name"),
      qualified_name: z.string().optional().describe("New qualified name"),
      path: z.string().optional().describe("New path"),
      signature: z.string().optional().describe("New signature"),
      summary: z.string().optional().describe("New summary"),
      inputs: z.string().optional().describe("New inputs"),
      outputs: z.string().optional().describe("New outputs"),
      side_effects: z.string().optional().describe("New side effects"),
      tags: z.array(z.string()).optional().describe("New tags"),
      importance: z.number().min(1).max(5).optional().describe("New importance"),
      topic_key: z.string().optional().describe("New stable semantic collision key"),
    },
    async ({ id, ...updates }) => {
      updateCodeEntity(id, updates);
      return { content: [{ type: "text", text: "Code entity updated." }] };
    },
  );

  server.tool(
    "get_code_entity",
    "Returns one code entity by ID.",
    {
      id: z.string().describe("Code entity ID"),
    },
    async ({ id }) => {
      const result = getCodeEntity(id);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "search_code_entities",
    `Searches structured code memory with FTS5.
Use for questions about functions, modules, files, endpoints, configs, or schemas already registered in the DB.
If results disagree with current code, inspect code and update the code_entity or mark it obsolete.`,
    {
      query: z.string().describe("Search text"),
      project_id: z.string().optional().describe("Filter by project"),
      limit: z.number().optional().describe("Max results (default: 10, max: 20)"),
      include_obsolete: z.boolean().optional().describe("If true, include obsolete code_entities"),
    },
    async ({ query, project_id, limit, include_obsolete }) => {
      const result = searchCodeEntities(
        query,
        project_id,
        Math.min(limit ?? 10, 20),
        include_obsolete ?? false,
      );
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "get_code_entity_context",
    "Returns active code memory for a project and query. Use as focused context before answering code-knowledge questions.",
    {
      project_id: z.string().describe("Project ID"),
      query: z.string().describe("Search text"),
      limit: z.number().optional().describe("Max results (default: 10, max: 20)"),
    },
    async ({ project_id, query, limit }) => {
      const result = getCodeEntityContext(project_id, query, Math.min(limit ?? 10, 20));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );
}
