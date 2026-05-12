# Memory Protocol

This MCP memory database is the persistent source of truth for agent continuity.

Chat history is temporary context. Current code is immediate technical truth. The
database is durable memory across sessions. Use it continuously, not only at the
end of a conversation.

## Startup

At the start of a session:

1. Call `get_sessions` to detect recent work and possible continuity.
2. Identify or create the active project with `get_project` or `upsert_project`.
3. Load durable memory with `build_context`.
4. Use `search_all` when the answer may exist in memory but the entity type is
   unknown.

If DB memory and current code disagree, inspect current code and then update the
DB with `update_*` or `mark_obsolete`.

## During Work

Update memory while working whenever durable state changes.

Use:

- `set_working_state` when focus, open threads, or pinned entities change.
- `add_note` for atomic durable facts, constraints, preferences, or context.
- `add_decision` for technical, product, architecture, or workflow decisions.
- `add_artifact` for structured outputs such as plans, schemas, prompts, APIs,
  configs, or designs.
  - `add_code_entity` after inspecting code that should be answerable later... **CRITICAL: Do NOT dump raw source code. Extract and document only the semantic purpose, inputs, outputs, and side-effects.**
- `add_link` when two memory entities explain, depend on, implement, replace, or
  reference each other.

Do not store transcripts. Store compact facts that help future work.

## Retrieval

Use the smallest useful retrieval path:

- `build_context`: normal project memory load, token-aware.
- `search_all`: broad search across notes, decisions, artifacts, and code.
- `search_code_entities`: focused code memory search.
- `get_related`: graph traversal from a known entity.
- `get_audit_trail`: understand how a memory entity changed over time.

Default to active memory. Use `include_obsolete` only for history, audit, or
recovery.

## Updating Truth

Do not duplicate stale memory.

Use:

- `update_note`, `update_decision`, `update_artifact`, or `update_code_entity`
  when the same entity is still valid but needs correction or more precision.
- `mark_obsolete` when something was true before but no longer applies.
- `delete_*` only for garbage or accidental writes.

Current code overrides stale memory, but the database must be corrected after the
conflict is discovered.

## Checkpoint

**MANDATORY END OF STAGE PROTOCOL:** 
You MUST call checkpoint before closing a session, switching to a drastically different task, or finishing a major refactor.

Provide:

- `session_summary`: dense session index, about 300 tokens max. Include goal,
  tools/functions touched, decisions, changes, and final state.
- `context_summary`: compact stable project state. Include current capabilities,
  architecture, constraints, and pending work.

Do not include chat transcript or narrative.

The agent/model writes summaries. The MCP stores, searches, relates, audits, and
builds token-aware context.

## Provider Agnostic Rule

This protocol is independent of OpenAI, Anthropic, OpenCode, Claude Code, or
Codex. Any model using the MCP should follow the same lifecycle:

startup load, continuous updates, targeted retrieval, stale-memory correction,
and checkpoint on stage close.
