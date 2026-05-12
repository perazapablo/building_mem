import { z } from "zod";

export const entityTypeSchema = z.enum(["note", "decision", "artifact", "code_entity"]);

export const codeEntityKindSchema = z.enum([
  "module",
  "file",
  "function",
  "class",
  "method",
  "endpoint",
  "config",
  "schema",
]);
