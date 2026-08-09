# Memory Rules

Operational rules for using the MCP `memory` server. Compatible agents apply these without thinking.
For the "why" and edge cases, see `MEMORY_PROTOCOL.md`.

## Enforcement

El MCP `memory` es una BD, no un agente. La única safety real es que todas las tools requieren `project_id` explícito como parámetro: si vas a escribir, ya identificaste el proyecto. No hay hard-deny sobre `add_*`/`update_*`/`checkpoint`; el único gate del harness es `ask` en operaciones destructivas (`delete_*`, `mark_obsolete`).

**No hay lifecycle.** Llamá las tools cuando las necesites, siempre con `project_id` explícito. `get_sessions` está restringida a las últimas 5 sesiones del proyecto pasado; `search_all` exige `project_id` y devuelve snippets (~200 chars), no payloads. Si necesitás full payload, `get_note`/`get_artifact`/`get_code_entity`.

### One product, one project

A "project" in memory represents a **product** (the thing being built / maintained), not a checkout, folder, or repo. Multiple paths can map to the same project: separate frontend/backend repos, multiple clones, backup copies, fork branches in different directories — all belong to one project if they serve the same product.

To differentiate within a project, use:
- `tags` on `add_*` calls (e.g. `["backend"]`, `["frontend"]`, `["infra"]`).
- The `path` field on `add_code_entity` (already segregates by file location).
- `topic_key` for stable semantic identity that survives reorganization.

**Heuristic to decide "same project or new project":**
- Does it share product identity (name, domain, user-facing feature set)? → same project.
- Does it have an independent deploy lifecycle, its own product roadmap, separate stakeholders? → new project.
- A repo name with suffixes like `-admin`, `-backend`, `-mobile`, `-backup`, `-old`, `_v2`, or a folder under `BACKUP/`, `archive/`, `legacy/` is almost always the same project as the canonical one — verify in `list_projects` before creating.

When in doubt, prefer reusing an existing project over creating a new one. Splitting can be done later by tagging; merging duplicates is painful.

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

## Anti-duplicado: a nivel proyecto, no por entrada

El verdadero anti-duplicado es **a nivel proyecto**, no por entrada.

Flujo correcto:

1. **Confirmar el proyecto** una sola vez al inicio: `list_projects` → match por nombre/tags/path → `get_project(id)`. Si no hay match real → `upsert_project` (respetar `outcome`: `auto_merged` / `ambiguous` / `created`).
2. **Identificado el proyecto, avanzar directo** con `add_decision` / `add_artifact` / `add_code_entity` / `add_note`. **No** hacer `search_*` defensivo antes de cada `add_*`.
3. Usar `topic_key` consistente — el MCP deduplica por slug normalizado internamente.

Cuándo SÍ buscar antes de un `add_*`:
- Sospecha real de duplicado (mismo topic recién creado en esta sesión, edición sobre algo viejo).
- Update intencional de una entrada existente (`update_*` directo si ya tenés el id).

Cuándo NO buscar:
- "Por las dudas" antes de cada `add_*`. Eso es paranoia que gasta tokens.

Conflictos reales se resuelven con `update_*` o `mark_obsolete` cuando se detectan, no preventivamente en cada llamada.

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
