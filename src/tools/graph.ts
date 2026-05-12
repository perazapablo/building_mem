import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { addLink, getAuditTrail, getRelated } from "../db.js";
import { entityTypeSchema } from "./schemas.js";

export function registerGraphTools(server: McpServer) {
  server.tool(
    "add_link",
    `Connects two memory entities in the graph.
Use during work when a note, decision, artifact, or code_entity explains, depends on, implements, replaces, or references another entity.
Links make get_related able to retrieve connected context later.`,
    {
      from_type: entityTypeSchema.describe("Source entity type"),
      from_id: z.string().describe("Source entity ID"),
      to_type: entityTypeSchema.describe("Target entity type"),
      to_id: z.string().describe("Target entity ID"),
    },
    async ({ from_type, from_id, to_type, to_id }) => {
      const id = addLink(from_type, from_id, to_type, to_id);
      return { content: [{ type: "text", text: JSON.stringify({ id }) }] };
    },
  );

  server.tool(
    "get_related",
    `Returns bidirectional graph relationships and resolved neighbor entities up to depth.
Use when one remembered item is relevant and nearby memory may explain it: related decisions, code entities, artifacts, or notes.`,
    {
      entity_type: entityTypeSchema.describe("Root entity type"),
      entity_id: z.string().describe("Root entity ID"),
      depth: z.number().optional().describe("Traversal depth (default: 1)"),
    },
    async ({ entity_type, entity_id, depth }) => {
      const result = getRelated(entity_type, entity_id, depth ?? 1);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "get_audit_trail",
    `Returns the auditable insert/update/delete history for one entity.
Use to understand how persistent truth changed over time, why memory became obsolete, or what was updated.`,
    {
      entity_type: z
        .enum(["session", "project", "note", "decision", "artifact", "link", "code_entity"])
        .describe("Entity type"),
      entity_id: z.string().describe("Entity ID"),
    },
    async ({ entity_type, entity_id }) => {
      const result = getAuditTrail(entity_type, entity_id);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );
}
