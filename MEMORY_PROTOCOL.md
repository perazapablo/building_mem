# Memory Protocol

Extended protocol for the MCP `memory` server. For day-to-day rules a Rust agent executes without thinking, see `MEMORY_RULES.md`. This document covers the **why**, edge cases, and the workflow for the parts that need judgment.

## 1. Mental model

Three sources of truth, ordered by authority:

1. **Current code** — immediate technical truth. If the code says X, X is true now.
2. **DB (this MCP)** — durable continuity. What was decided, learned, produced across sessions. Survives restarts, model swaps, machine moves.
3. **Chat transcript** — ephemeral. Useful within a turn, gone after.

Never invert this order. If the DB contradicts the code, the DB is stale. If the chat contradicts the DB on a durable fact, the chat is forgetful.

The DB is provider-agnostic. Same protocol for Claude, GPT, Codex, opencode, Cursor, any future client. The binary is one process; clients open their own MCP connections via stdio. SQLite WAL mode (enabled in migrations) allows N readers + 1 writer concurrently — no locks to worry about under normal use.

## 2. Lifecycle detail

### INICIO

```
get_sessions(limit=20)                  # detect continuity
upsert_project(...) or get_project(id)  # bind to a project
build_context(project_id, token_budget=4000)  # load durable memory
set_working_state(session_id, focus, open_threads, pinned_ids)
```

- `get_sessions` returns a compact index with structured `summary` already parsed. Use it to decide if this is a continuation or a fresh start.
- `build_context` is **the** load function. Token-aware, returns the highest-importance + pinned items that fit the budget, plus graph expansion via accepted relations.
- `set_working_state` is what makes future `build_context` calls prioritise correctly. Update it whenever focus pivots, not on every message.

### DURANTE

Call `add_*` **immediately** at the moment a decision is made, an artifact is produced, or a code entity is inspected. Batching at session close defeats the point — interrupt-tolerant memory only works if facts land before the interruption.

```
add_decision(project_id, decision, reasoning, importance=3, topic_key=?)
add_artifact(project_id, type, content, importance=3, topic_key=?)
add_code_entity(project_id, kind, name, qualified_name?, path?, summary?, ...)
add_note(project_id, content, tags, importance=3, topic_key=?)
```

- `importance` is 1–5. Most facts are 3. Only mark 5 for project-shaping decisions or critical constraints.
- `topic_key` is a stable semantic identifier (e.g. `"auth.session.expiry"`). When provided, a second `add_*` with the same key **updates** the active entity instead of creating a duplicate. Use it for anything you might revise.

### CIERRE

```
checkpoint(session_id, project_id, session_summary=SessionSummary{...})
get_pending_judgments(project_id) → judge_relation(sync_id, status) per row
```

- `checkpoint` persists the session summary, updates the project's `context_summary` (or generates one mechanically if you omit it), and runs a final `build_context` for the record.
- `get_pending_judgments` returns the auto-detected relations awaiting human review. Process them in batch at close, not per-entity.

## 3. Decision matrix expanded

| Tool              | Example                                                                |
|-------------------|------------------------------------------------------------------------|
| `add_decision`    | "Use Rust over Node for the MCP server. Reason: native binding fragility. Rejected: stay on TS with node:sqlite (would still be Node-runtime-coupled)." |
| `add_artifact`    | A migration plan, a JSON schema, a Cargo.toml fragment, a prompt template. Anything you'd want byte-identical retrieval of. |
| `add_code_entity` | "`repo::context::build_context` — token-aware bundle builder. Inputs: project_id, budget, optional session_id, optional tokenizer_model. Side effect: none. Path: rust/src/repo/context.rs." |
| `add_note`        | "User prefers Spanish responses with technical terms in English." Atomic, one sentence. |

When in doubt: pick the more specific tool. A decision masquerading as a note loses its reasoning and rejected alternatives — both critical for future "why did we do it this way" questions.

## 4. Structured summaries

The schemas are fixed and validated. Fill the fields. Do not invent.

```json
SessionSummary {
  "goal":          "string — what this session was trying to accomplish",
  "outcome":       "string — what was actually accomplished",
  "decisions_ref": ["decision_id", ...],
  "artifacts_ref": ["artifact_id", ...],
  "pending":       ["open thread or unresolved work", ...],
  "blockers":      ["active blocker", ...],
  "notes":         "string | null — optional free-form nuance, keep short"
}

ContextSummary {
  "capabilities":  ["current stable project capability", ...],
  "architecture":  "string — stack and architecture, compact",
  "constraints":   ["technical or business constraint", ...],
  "pending_work":  ["outstanding item at project scope", ...],
  "notes":         "string | null — optional, keep short"
}
```

Reference `decision_id` and `artifact_id` returned by their respective `add_*`. **Do not duplicate** the content of a decision into `notes` — it bloats the summary and forks the source of truth.

`notes` exists for nuance that doesn't fit the fields. Use sparingly. If you find yourself writing a paragraph in `notes`, you're probably storing transcript.

## 5. Relations workflow

The server auto-detects 4 kinds of relations on every `add_*`:

| Relation              | Trigger                                                        | Default judgment |
|-----------------------|----------------------------------------------------------------|-----------------:|
| `structural_sibling`  | code_entities sharing the same `path`                           | `accepted` (auto) |
| `topically_related`   | ≥2 shared `tags` in the same project                            | `pending`        |
| `variant_of`          | same entity type with `topic_key` sharing a prefix ≥6 chars     | `accepted` (auto) |
| `semantically_related`| top-3 FTS5 hits with rank ≥ -8                                  | `pending`        |

Manual relations (for explicit semantic relationships you observed) use `add_relation` with one of:

`implements`, `depends_on`, `conflicts_with`, `replaces`, `references`.

For manual relations you're confident about, set `judgment_status="accepted"` directly. Otherwise leave as `pending`.

`conflicts_with` is **load-bearing**: accepted `conflicts_with` causes `build_context` to exclude both items if both would be selected. Use it intentionally to mark superseded vs current.

At session close, walk `get_pending_judgments(project_id)`:
- **Accept** if the relation is correct.
- **Reject** if false positive. Rejected relations stay rejected even if re-detected later.
- **Skip** if unsure — they remain `pending` for the next session.

## 6. Memory vs code conflict resolution

When inspecting current code and finding it contradicts a stored memory:

1. Re-read the code to confirm. False conflicts come from incomplete reads.
2. If confirmed:
   - **Same entity, refined truth** → `update_<entity>(id, ...)` with the new facts. `revision_count` increments automatically.
   - **Reversed decision / superseded artifact** → `mark_obsolete(type, id, reason="superseded by <commit hash> | <code path>")`. History is preserved in `events` table.
3. Continue with the work. Do not block on the discrepancy.
4. If the same entity contradicts code repeatedly, the entity is probably wrong at the semantic level — consider `delete_<entity>` and re-create. `delete_*` is for accidents and re-keys, not for everyday cleanup.

## 7. Cadence

- `set_working_state`: when **focus pivots**. Not per message, not per file read. If you find yourself updating it 10 times an hour, you're using it as a scratch pad.
- `add_*`: at the moment of the fact, not at the end. Interrupt resilience is the whole point.
- `checkpoint`: at the end of a **logical stage**, not by clock. End of a refactor. End of a debugging session. End of a feature. Not "every hour" — that produces noisy summaries.
- `build_context`: at the start of a session, and again if the project pivots dramatically (e.g. user says "actually let's work on X now" mid-session).

## 8. Multi-client and concurrency

The binary is one process per client. Claude Code, Codex, opencode, Cursor each open their own MCP connection. They share the same `memory.db` file via SQLite's WAL mode:

- N readers + 1 writer concurrent: fine.
- Two writers at the same instant: SQLite serialises them via lock; the second one waits milliseconds.
- Two **different binary versions** opening the same DB at the same time: avoid. The newer one may apply a migration the older one doesn't know about. When upgrading the server, do the cutover across all clients in the same window.

The protocol document and rules document apply identically across all clients. Don't fork by provider.

## 9. Provider-agnostic rule

This protocol is independent of Claude, GPT, opencode, Codex, or any specific model family. Any agent using the MCP follows the same lifecycle: startup load, continuous updates, targeted retrieval, stale-memory correction, checkpoint on stage close. Differences between models (context window, tool-use style, reasoning depth) do not change the operational protocol — they may only affect verbosity of summaries.

If you find yourself writing model-specific guidance in this file, you're overfitting. Push it back to a model-specific prompt or the model's system instructions, not here.
