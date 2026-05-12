import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  auditStale,
  deleteArtifact,
  deleteDecision,
  deleteNote,
  markObsolete,
  updateArtifact,
  updateDecision,
  updateNote,
} from "../db.js";
import { entityTypeSchema } from "./schemas.js";

export function registerMutationTools(server: McpServer) {
  server.tool(
    "update_note",
    `Updates an existing note when the fact is still relevant but needs correction or refinement.
If the fact no longer applies, use mark_obsolete instead. Do not create duplicates for the same durable fact.`,
    {
      id: z.string().describe("Note ID"),
      content: z.string().optional().describe("New content"),
      tags: z.array(z.string()).optional().describe("New tags; replaces previous tags"),
      importance: z.number().min(1).max(5).optional().describe("New importance from 1 to 5"),
      topic_key: z.string().optional().describe("New stable semantic collision key"),
    },
    async ({ id, content, tags, importance, topic_key }) => {
      updateNote(id, content, tags, importance, topic_key);
      return { content: [{ type: "text", text: "Note updated." }] };
    },
  );

  server.tool(
    "delete_note",
    `Permanently deletes a note.
Use only for garbage or accidental writes. If the note was true before but no longer applies, use mark_obsolete.`,
    { id: z.string().describe("Note ID to delete") },
    async ({ id }) => {
      deleteNote(id);
      return { content: [{ type: "text", text: "Note deleted." }] };
    },
  );

  server.tool(
    "update_decision",
    `Updates an existing decision when wording or reasoning needs correction.
If the decision was reversed or replaced, use mark_obsolete and add_decision for the new decision.`,
    {
      id: z.string().describe("Decision ID"),
      decision: z.string().optional().describe("New decision text"),
      reasoning: z.string().optional().describe("New reasoning"),
      importance: z.number().min(1).max(5).optional().describe("New importance from 1 to 5"),
      topic_key: z.string().optional().describe("New stable semantic collision key"),
    },
    async ({ id, decision, reasoning, importance, topic_key }) => {
      updateDecision(id, decision, reasoning, importance, topic_key);
      return { content: [{ type: "text", text: "Decision updated." }] };
    },
  );

  server.tool(
    "delete_decision",
    `Permanently deletes a decision.
Use only for garbage or accidental writes. For reversed decisions, use mark_obsolete.`,
    { id: z.string().describe("Decision ID to delete") },
    async ({ id }) => {
      deleteDecision(id);
      return { content: [{ type: "text", text: "Decision deleted." }] };
    },
  );

  server.tool(
    "update_artifact",
    `Updates an existing artifact when the same durable output changed or needs correction.
If the artifact is no longer valid, use mark_obsolete instead.`,
    {
      id: z.string().describe("Artifact ID"),
      type: z.string().optional().describe("New artifact type"),
      content: z.string().optional().describe("New content"),
      importance: z.number().min(1).max(5).optional().describe("New importance from 1 to 5"),
      topic_key: z.string().optional().describe("New stable semantic collision key"),
    },
    async ({ id, type, content, importance, topic_key }) => {
      updateArtifact(id, type, content, importance, topic_key);
      return { content: [{ type: "text", text: "Artifact updated." }] };
    },
  );

  server.tool(
    "delete_artifact",
    `Permanently deletes an artifact.
Use only for garbage or accidental writes. Prefer mark_obsolete for historical but outdated artifacts.`,
    { id: z.string().describe("Artifact ID to delete") },
    async ({ id }) => {
      deleteArtifact(id);
      return { content: [{ type: "text", text: "Artifact deleted." }] };
    },
  );

  server.tool(
    "mark_obsolete",
    `Marks an entity obsolete without deleting history.
Use when stored memory was correct at the time but no longer applies. This keeps the DB auditable while excluding the entity from normal context.`,
    {
      type: entityTypeSchema.describe("Entity type"),
      id: z.string().describe("Entity ID"),
      reason: z.string().describe("Concrete reason why it no longer applies"),
    },
    async ({ type, id, reason }) => {
      markObsolete(type, id, reason);
      return { content: [{ type: "text", text: `${type} ${id} marked obsolete.` }] };
    },
  );

  server.tool(
    "audit_stale",
    `Lists active notes, decisions, artifacts, and code_entities not updated in N days.
Use manually to find memory that may need update or mark_obsolete. It does not run automatically.`,
    {
      days: z.number().optional().describe("Minimum age in days (default: 30)"),
      project_id: z.string().optional().describe("Filter by project"),
    },
    async ({ days, project_id }) => {
      const result = auditStale(days ?? 30, project_id);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );
}
