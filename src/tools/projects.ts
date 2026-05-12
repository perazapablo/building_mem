import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getProject, getProjectContext, upsertProject } from "../db.js";

export function registerProjectTools(server: McpServer) {
  server.tool(
    "upsert_project",
    `Creates a project or updates an existing one.
DB PROTOCOL: after get_sessions, identify the active project with this tool when needed.
If existed=true, load persistent memory before continuing with build_context or search_all. Treat DB memory as the source of truth unless current code contradicts it.

project_type guides what durable memory should be captured:
- development: stack, architecture, files, dependencies, code decisions.
- research: hypotheses, sources, findings, experiments, conclusions.
- integration: protocols, schemas, external APIs, connection config.
- learning: key concepts, common mistakes, exercises, resources.
- other: any project outside those categories.`,
    {
      name: z.string().describe("Unique project name in snake_case"),
      description: z.string().describe("Short project description"),
      project_type: z
        .enum(["development", "research", "integration", "learning", "other"])
        .describe("Project type; guides what memory is relevant to capture"),
      tags: z.array(z.string()).describe("Tags for project categorization"),
    },
    async ({ name, description, project_type, tags }) => {
      const result = upsertProject(name, description, project_type, tags);
      return {
        content: [
          { type: "text", text: JSON.stringify({ ...result, name, project_type }) },
        ],
      };
    },
  );

  server.tool(
    "get_project",
    "Returns one project by ID, including its compact context_summary when present.",
    {
      project_id: z.string().describe("Project ID"),
    },
    async ({ project_id }) => {
      const project = getProject(project_id);
      return {
        content: [{ type: "text", text: JSON.stringify(project, null, 2) }],
      };
    },
  );

  server.tool(
    "get_project_context",
    `Returns active notes, decisions, and artifacts for quick project context.
Use only for small/simple context. For normal work, prefer build_context because it is token-aware and includes code_entities.
Default excludes obsolete memory. Set include_obsolete=true only when auditing history or checking why something changed.`,
    {
      project_id: z.string().describe("Project ID"),
      limit: z.number().optional().describe("Max records per type (default: 5)"),
      include_obsolete: z
        .boolean()
        .optional()
        .describe("If true, include obsolete records. Default: false."),
    },
    async ({ project_id, limit, include_obsolete }) => {
      const context = getProjectContext(
        project_id,
        limit ?? 5,
        include_obsolete ?? false,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(context, null, 2) }],
      };
    },
  );
}
