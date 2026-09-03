# Memory Protocol

Extended protocol for the MCP `memory` server. For day-to-day rules a Rust agent executes without thinking, see `MEMORY_RULES.md`. This document covers the **why**, edge cases, and the workflow for the parts that need judgment.

## 1. Mental model

Three sources of truth, ordered by authority:

1. **Current code** — immediate technical truth. If the code says X, X is true now.
2. **DB (this MCP)** — durable continuity. What was decided, learned, produced across sessions. Survives restarts, model swaps, machine moves.
3. **Chat transcript** — ephemeral. Useful within a turn, gone after.

Never invert this order. If the DB contradicts the code, the DB is stale. If the chat contradicts the DB on a durable fact, the chat is forgetful.

The DB is provider-agnostic. Same protocol for Claude, GPT, Codex, opencode, Cursor, any future client. The binary is one process; clients open their own MCP connections via stdio. SQLite WAL mode (enabled in migrations) allows N readers + 1 writer concurrently — no locks to worry about under normal use.

## 2. How the tools behave

Every tool is scoped by `project_id` — that is the primary anchor. If you don't have one yet, use `list_projects` + `get_project` (existing) or `upsert_project` (new). Reuse the returned id for every subsequent call.

### Reading

- `get_sessions(project_id)` — last 5 sessions of the project (compact index: id, title, timestamps). Use to decide if this is a continuation. There is no cross-project listing.
- `build_context(project_id, token_budget)` — token-aware bundle of highest-importance + pinned items + graph expansion via accepted relations. The load function when you need durable context.
- `search_all(query, project_id)` — one FTS5 call across notes / decisions / artifacts / code_entities. Returns snippets (~200 chars). Use when the answer is in memory but the type is unknown.
- `search_notes` / `search_code_entities` — narrower FTS when the type is known.
- `get_note` / `get_artifact` / `get_code_entity` — full payload by id, when a snippet is not enough.
- `get_related` / `get_code_entity_context` — graph expansion around a known entity.
- `get_working_state(session_id)` — pinned ids and legacy focus mirror for a session.
- `get_focus(session_id)` / `get_latest_focus_for_project(project_id)` — focus as a first-class entity (from `session_focus`).
- `resolve_project_by_path(path)` — map a filesystem path to a `project_id` for the harness bootstrap.
- `list_project_paths(project_id)` — inspect current path bindings.
- `list_open_threads(project_id)` / `list_project_threads(project_id, status?)` — real state of pending work (from `project_threads`).

Default excludes obsolete. `include_obsolete=true` only for history/audit/recovery.

### Writing (during work)

- `decision_record` / `add_artifact` / `add_code_entity` / `add_note` — call at the moment a fact appears, not batched at close. Interrupt-tolerant memory only works if facts land before the interruption. For `add_*`, pass `topic_key` for anything you might revise — a second `add_*` with the same key updates the active entity instead of duplicating.
- `decision_record(project_id, session_id, topic_key, statement, forces[], alternatives[{option, rejected_because|null}], consequences[], origin, confidence, phase?, evidence[], supersedes?)` — decisions are **append-only chains**, not rows (v12 replaced `add_decision`, whose upsert destroyed history). `topic_key` identifies the *chain*; the single `status='active'` record is its tip.
  - Revising a decision: pass `supersedes=<tip_id>`. Recording on a chain that already has a tip **without** `supersedes` fails and returns the tip — you cannot overwrite what you have not read.
  - `origin` is required, no default: `user_explicit` / `user_implicit` must be actively affirmed; when unsure, `agent_inferred`. It is the only defense against fabricated rationale, which is indistinguishable from the real thing once written.
  - `rejected_because: null` is a valid, meaningful state: the option was discarded but nobody recorded why. **Never invent one to fill the field** — ask, or leave it null.
  - `decision_revert(id, reason, session_id)` — the decision was undone with no replacement. To replace it, use `supersedes` instead. Closed records are frozen.
  - There is no update/delete for decision records, by design; `mark_obsolete` on `decision` is rejected. The `decisions` table is frozen legacy: its active rows were migrated as single-link chains keeping their ids.
- `context_for_topic(project_id, topic_key, depth?)` — the chain for a topic, tip-first. Use when resuming a topic cold: it shows what is decided *and how it got there*.
- `update_*` — revise an existing entity by id. `revision_count` increments automatically.
- `mark_obsolete(type, id, reason)` — supersede without deleting. Preferred over `delete_*` for anything with history.
- `delete_*` — for accidents and re-keys, not everyday cleanup. Requires user confirmation (harness `ask` gate).
- `set_focus(session_id, project_id, focus)` — atomic focus update. Preferred over `set_working_state` when you only want to change focus. The harness may require this before persistent actions.
- `set_working_state(session_id, focus, pinned_ids)` — persists focus mirror + pinned ids. `open_threads` was removed — use threads tools instead.
- `open_thread(project_id, thread, session_id)` — when a real TODO appears during work. Returns a thread id.
- `close_thread(thread_id, status='done'|'dropped', reason?, session_id)` — explicit closure. Preferred over silence.
- `touch_thread(thread_id)` — bump `updated_at` on an open thread from a related decision/artifact so it stays out of stale territory.
- `add_project_path(project_id, path)` — bind a checkout. Idempotent per (project, path).

`importance` is 1–5. Most facts are 3. Reserve 5 for project-shaping decisions or critical constraints — it drives ranking in `build_context`.

### Closing a stage (only when Pablo asks)

Not autonomous. Only when Pablo says "cerrá", "checkpoint", "guardá la sesión" or equivalent. The agent does **not** decide to checkpoint on its own — no clock, no "logical stage detected".

```
checkpoint(session_id, project_id, session_summary=SessionSummary{...})
get_pending_judgments(project_id) → judge_relation(sync_id, status) per row
```

- `checkpoint` persists the session summary, updates the project's `context_summary` (or generates one mechanically if you omit it), and runs a final `build_context` for the record.
- `get_pending_judgments` returns the auto-detected relations awaiting human review. Process them in batch at that moment, not per-entity during work.

## 3. Decision matrix expanded

| Tool              | Example                                                                |
|-------------------|------------------------------------------------------------------------|
| `decision_record` | `statement`: "Use Rust over Node for the MCP server." · `forces`: ["native binding fragility on Node"] · `alternatives`: [{option: "stay on TS with node:sqlite", rejected_because: "would still be Node-runtime-coupled"}] · `consequences`: ["the viewer links the crate by path"] · `origin`: `user_explicit` |
| `add_artifact`    | A migration plan, a JSON schema, a Cargo.toml fragment, a prompt template. Anything you'd want byte-identical retrieval of. |
| `add_code_entity` | "`repo::context::build_context` — token-aware bundle builder. Inputs: project_id, budget, optional session_id, optional tokenizer_model. Side effect: none. Path: rust/src/repo/context.rs." |
| `add_note`        | "User prefers Spanish responses with technical terms in English." Atomic, one sentence. |

When in doubt: pick the more specific tool. A decision masquerading as a note loses its reasoning and rejected alternatives — both critical for future "why did we do it this way" questions.

## 4. Structured summaries

The schemas are fixed and validated. Fill the fields. Do not invent.

```json
SessionSummary {
  "goal":           "string — what this session was trying to accomplish",
  "outcome":        "string — what was actually accomplished",
  "decisions_ref":  ["decision_id", ...],
  "artifacts_ref":  ["artifact_id", ...],
  "pending":        ["open thread or unresolved work", ...],
  "blockers":       ["active blocker", ...],
  "threads_closed": ["thread_id", ...],
  "stats":          SessionStats | null,
  "notes":          "string | null — optional free-form nuance, keep short"
}

SessionStats {
  "duration_min":          "int — wall-clock minutes",
  "turns":                 "int — user+assistant turns",
  "commits":               ["git sha", ...],
  "files_edited":          [{"path": "string", "edits": "int"}, ...],
  "bash_effects":          [{"cmd": "string", "exit": "int"}, ...],
  "memory_writes":         {"decision_record": "int", "add_artifact": "int", ...},
  "code_entities_touched": ["code_entity_id", ...],
  "tool_errors":           "int",
  "last_focus":            "string — last set_focus value seen"
}

ContextSummary {
  "capabilities":  ["current stable project capability", ...],
  "architecture":  "string — stack and architecture, compact",
  "constraints":   ["technical or business constraint", ...],
  "pending_work":  ["outstanding item at project scope", ...],
  "notes":         "string | null — optional, keep short"
}
```

`stats` is **mechanical**: filled by the harness from the event log, never by the model. `threads_closed` are `project_threads.id` values closed during the session. Keep `pending` short — the real pending is `list_open_threads(project_id)`; `pending` in the summary is for items that don't warrant a proper thread.

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

- `set_focus`: once per real focus pivot. Cheaper and clearer than a full `set_working_state`.
- `open_thread`: the moment a real TODO appears during work. Do not batch or pre-plan a wall of speculative threads.
- `close_thread`: as soon as a thread is done or dropped. A thread that stays open past its actual life becomes a `stale` entry that clutters `list_open_threads`.
- `touch_thread`: when a decision/artifact addresses an open thread — keeps it out of the 30-day stale window.
- `add_*`: at the moment of the fact, not at the end. Interrupt resilience is the whole point.
- `checkpoint` / `save_session`: for the mechanical save flow, the harness fires on `SessionEnd`. Otherwise call `checkpoint` at the end of a **logical stage** — not by clock.
- `build_context`: at the start of a session (via harness), and again if the project pivots dramatically mid-session.
- `mark_stale_threads`: harness job, once a day per project, 30-day cutoff. Never called by the model.

## 8. Multi-client and concurrency

The binary is one process per client. Claude Code, Codex, opencode, Cursor each open their own MCP connection. They share the same `memory.db` file via SQLite's WAL mode:

- N readers + 1 writer concurrent: fine.
- Two writers at the same instant: SQLite serialises them via lock; the second one waits milliseconds.
- Two **different binary versions** opening the same DB at the same time: avoid. The newer one may apply a migration the older one doesn't know about. When upgrading the server, do the cutover across all clients in the same window.

The protocol document and rules document apply identically across all clients. Don't fork by provider.

## 9. Provider-agnostic rule

This protocol is independent of Claude, GPT, opencode, Codex, or any specific model family. Any agent using the MCP follows the same lifecycle: startup load, continuous updates, targeted retrieval, stale-memory correction, checkpoint on stage close. Differences between models (context window, tool-use style, reasoning depth) do not change the operational protocol — they may only affect verbosity of summaries.

If you find yourself writing model-specific guidance in this file, you're overfitting. Push it back to a model-specific prompt or the model's system instructions, not here.
