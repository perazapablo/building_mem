import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  RELATION_TYPES,
  getPendingJudgments,
  getRelationsForEntity,
  judgeRelation,
  upsertRelation,
} from "../db.js";
import { entityTypeSchema } from "./schemas.js";

const relationTypeSchema = z.enum(RELATION_TYPES);

export function registerRelationTools(server: McpServer) {
  server.tool(
    "add_relation",
    `Creates or updates a typed relation between two memory entities.
Use when you detect that two entities are connected: one implements a decision, one depends on another, one replaces another, or they conflict.
The system auto-creates structural_sibling, topically_related, variant_of, and semantically_related relations on insert — use add_relation for explicit semantic relations (implements, depends_on, conflicts_with, replaces, references).
For manually detected relations you are confident about, set judgment_status to 'accepted'. Otherwise leave it as 'pending' for review.`,
    {
      source_type: entityTypeSchema.describe("Source entity type"),
      source_id: z.string().describe("Source entity ID"),
      target_type: entityTypeSchema.describe("Target entity type"),
      target_id: z.string().describe("Target entity ID"),
      relation: relationTypeSchema.describe("Relation type"),
      reason: z.string().describe("Why this relation exists"),
      evidence: z.string().optional().describe("Concrete evidence supporting this relation"),
      confidence: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Confidence from 0.0 to 1.0 (default: 0.5)"),
      judgment_status: z
        .enum(["pending", "accepted", "rejected"])
        .optional()
        .describe("Initial judgment status (default: pending)"),
      session_id: z.string().optional().describe("Session that created this relation"),
    },
    async ({
      source_type,
      source_id,
      target_type,
      target_id,
      relation,
      reason,
      evidence,
      confidence,
      judgment_status,
      session_id,
    }) => {
      const sync_id = upsertRelation({
        source_type,
        source_id,
        target_type,
        target_id,
        relation,
        reason,
        evidence,
        confidence,
        judgment_status,
        marked_by_kind: "llm",
        marked_by_actor: "agent",
        session_id,
      });
      return { content: [{ type: "text", text: JSON.stringify({ sync_id }) }] };
    },
  );

  server.tool(
    "judge_relation",
    `Accepts or rejects a pending relation.
Use to validate auto-detected relations (structural_sibling, topically_related, semantically_related) or to reject false positives.
Accepted relations actively influence build_context: they unlock graph expansion and trigger conflict exclusion.
Rejected relations are preserved in the audit trail but excluded from all retrieval and context building.`,
    {
      sync_id: z.string().describe("Relation sync_id to judge"),
      judgment_status: z
        .enum(["accepted", "rejected"])
        .describe("Accept or reject this relation"),
      marked_by_actor: z.string().optional().describe("Actor making the judgment"),
      marked_by_model: z
        .string()
        .optional()
        .describe("Model making the judgment, if applicable"),
    },
    async ({ sync_id, judgment_status, marked_by_actor, marked_by_model }) => {
      judgeRelation(
        sync_id,
        judgment_status,
        marked_by_actor ?? "",
        "human",
        marked_by_model ?? "",
      );
      return {
        content: [{ type: "text", text: `Relation ${sync_id} ${judgment_status}.` }],
      };
    },
  );

  server.tool(
    "get_relations",
    `Returns all relations for a given entity, with optional filters.
Use to understand what a given entity is connected to before working on it, or to surface pending relations for review.`,
    {
      entity_type: entityTypeSchema.describe("Entity type"),
      entity_id: z.string().describe("Entity ID"),
      judgment_status: z
        .enum(["pending", "accepted", "rejected"])
        .optional()
        .describe("Filter by judgment status"),
      relation: relationTypeSchema.optional().describe("Filter by relation type"),
      limit: z.number().optional().describe("Maximum results (default: 50)"),
    },
    async ({ entity_type, entity_id, judgment_status, relation, limit }) => {
      const result = getRelationsForEntity(entity_type, entity_id, {
        judgment_status,
        relation,
        limit,
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    "get_pending_judgments",
    `Lists pending relations that need review, ordered by confidence descending.
Use periodically to keep the relation graph validated. High-confidence auto-detected relations at the top are the most likely to be correct and worth accepting quickly.`,
    {
      project_id: z.string().optional().describe("Filter by project"),
      limit: z.number().optional().describe("Maximum results (default: 20)"),
    },
    async ({ project_id, limit }) => {
      const result = getPendingJudgments(project_id, limit ?? 20);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );
}
