# Memory Rules

Operational rules for using the MCP `memory` server. Compatible agents apply these without thinking.
For the "why" and edge cases, see `MEMORY_PROTOCOL.md`.

## Lifecycle (mandatory)

- **INICIO**: `get_sessions` → identify/create project (`upsert_project`) → `build_context(project_id, token_budget=4000)` → `set_working_state` if focus is known.
- **DURANTE**: call `add_*` at the moment of deciding/creating, never at the end of the session.
- **CIERRE**: `checkpoint(SessionSummary)` + iterate `get_pending_judgments` → `judge_relation` on each.

## Decision matrix

| To store                     | Tool               | Hard criterion                                       |
|------------------------------|--------------------|------------------------------------------------------|
| technical decision           | `add_decision`     | explicit trade-off + rejected alternative            |
| durable artifact             | `add_artifact`     | schema / plan / config / prompt with own identity    |
| code symbol                  | `add_code_entity`  | fn / struct / module / endpoint navigable by path    |
| atomic observation           | `add_note`         | the rest, max 1 sentence                             |

If two columns fit, pick the more specific one (`add_decision` > `add_note`).

## Structured summaries (fill, do not invent fields)

```json
SessionSummary: {
  "goal": "",
  "outcome": "",
  "decisions_ref": [],
  "artifacts_ref": [],
  "pending": [],
  "blockers": [],
  "notes": null
}

ContextSummary: {
  "capabilities": [],
  "architecture": "",
  "constraints": [],
  "pending_work": [],
  "notes": null
}
```

`decisions_ref` and `artifacts_ref` are IDs returned by `add_decision` / `add_artifact`.
Never duplicate the content of a decision inside the summary — reference it.

## Anti-patterns (DO NOT store)

- Chat transcript or conversation narrative.
- Raw source code (use `add_code_entity` with semantic `summary`, not the code body).
- Trivial decisions (formatting, local variable naming).
- Information derivable by reading the repo (file structure, imports, public APIs already obvious).
- Ephemeral state (use `set_working_state`, not `add_note`).

## Relations

After any `add_*`, the server auto-creates relations (structural_sibling, topically_related, variant_of, semantically_related) in `pending` state. **Do not process them inline.**

At session close, batch:

```
get_pending_judgments(project_id) → for each: judge_relation(sync_id, "accepted" | "rejected")
```

Accept if the suggested relation is correct; reject if false positive. Skip silently if unsure — defaults to pending.

## Conflict: memory vs code

**Code always wins.** If memory contradicts the repo:

1. `update_<entity>` with the current truth, **or**
2. `mark_obsolete(type, id, reason="superseded by <code ref>")`

Never trust memory over a direct file read. Never block on the discrepancy — fix it and continue.

## Retrieval cheat-sheet

- Need durable project state? → `build_context` (token-aware).
- Looking for something specific, unknown type? → `search_all`.
- Looking for a function/symbol? → `search_code_entities`.
- Have an entity, want its neighborhood? → `get_related`.
- Want to understand how an entity evolved? → `get_audit_trail`.

Default excludes obsolete. Use `include_obsolete=true` only for history/audit/recovery.
