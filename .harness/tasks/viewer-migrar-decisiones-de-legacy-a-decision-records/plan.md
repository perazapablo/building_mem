---
diff_scope:
  - viewer/src-tauri/src/commands.rs
  - viewer/src-tauri/src/lib.rs
  - viewer/src/app/core/models.ts
  - viewer/src/app/core/tauri.service.ts
  - viewer/src/app/shared/decision-record/**
  - viewer/src/app/sections/knowledge/**
  - viewer/src/app/sections/context-builder/**
  - viewer/src/app/shared/global-search/**
verification_criteria:
  - cargo check --manifest-path viewer/src-tauri/Cargo.toml
  - npm --prefix viewer run build
steps:
  - "1. Backend Tauri: 3 comandos nuevos sobre repo::decision_records (list_tips, chain, get) + registro en lib.rs."
  - "2. models.ts: tipos DecisionRecordRow/Alternative/Evidence; agregar el caso 'decision_record' a las uniones ContextItem y SearchAllResult."
  - "3. tauri.service.ts: listDecisionRecords / getDecisionChain / getDecisionRecord."
  - "4. Componente shared/decision-record: render de un record (statement, forces, alternatives con null visible, consequences, badges de origin/confidence/phase/importada)."
  - "5. Knowledge: el tab Decisions pasa a leer tips; filtros por origin/confidence reemplazan al de importance; panel de cadena tip-first al seleccionar."
  - "6. Context Builder y Global Search: cubrir el caso 'decision_record' en los switch que hoy devuelven undefined/vacío."
  - "7. Verificación: cargo check + ng build, y revisión visual de los 38 tips de mcp_memory y la cadena harness.alcance-v1."
---

# Plan — viewer: migrar decisiones de legacy a decision_records

Decisiones de Pablo que fijan el alcance (2026-09-03): migrar Knowledge + arreglar los dos consumidores
rotos; esconder la tabla legacy de la UI; badge para las 271 importadas; construir la vista de cadena ahora.

## Paso 1 — Backend Tauri (`viewer/src-tauri/`)

`commands.rs` gana tres comandos, calcados del patrón existente (`Result<Value, String>` vía `serde_json::to_value`):

```rust
list_decision_records(state, project_id: String)            -> decision_records::list_tips
get_decision_record(state, id: String)                      -> decision_records::get
get_decision_chain(state, project_id, topic_key, depth: Option<i64>) -> decision_records::chain
```

`project_id` acá es **obligatorio**, a diferencia de `list_decisions(Option<String>)`: `list_tips` no tiene
variante global. Las secciones que hoy llaman sin proyecto (ninguna de las tres del alcance) no se ven afectadas.
Registro de los tres en el `invoke_handler!` de `lib.rs`. No se toca `list_decisions`/`get_decision`: los siguen
usando Overview, History, Graph y Judgments, fuera de este alcance.

## Paso 2 — Tipos (`viewer/src/app/core/models.ts`)

```ts
export interface Alternative { option: string; rejected_because: string | null; }
export interface Evidence    { kind: 'path'|'commit'|'memory_ref'|'quote'; value: string; }
export interface DecisionRecordRow {
  id; project_id; topic_key; session_id; phase: string | null; created_at;
  statement; forces: string[]; alternatives: Alternative[]; consequences: string[];
  origin: 'user_explicit'|'user_implicit'|'agent_inferred';
  evidence: Evidence[]; confidence: 'decided'|'tentative';
  status: 'active'|'superseded'|'reverted';
  status_reason: string | null; closed_by_session: string | null;
  supersedes: string | null; superseded_by: string | null;
}
```

Y el caso faltante en las dos uniones, con los campos exactos que ya serializa el backend
(`ContextItem::DecisionRecord` en `context.rs:76`, `SearchAllResult::DecisionRecord` en `search.rs:66`).
Ninguno de los dos trae `importance`/`revision_count`/`updated_at`.

## Paso 3 — Servicio (`tauri.service.ts`)

Tres métodos espejo del paso 1. Se mantienen `listDecisions`/`getDecision` para los consumidores fuera de alcance.

## Paso 4 — `shared/decision-record/` (componente nuevo, archivos separados .ts/.html/.scss)

Interfaz mínima: `@Input() record: DecisionRecordRow`, `@Input() compact = false`.
Un solo componente sirve a la card de la lista (`compact`), al detalle y a cada eslabón de la cadena —
no hace falta un componente de cadena aparte: la cadena es un `*ngFor` de éste.

Render:
- `statement` como texto principal.
- `forces[]`, `consequences[]` como listas.
- `alternatives[]`: `option` + `rejected_because`; cuando es `null`, se muestra literal
  **"razón no registrada"**, no vacío. El null es señal, no hueco.
- Badges: `origin` (user_explicit / user_implicit / agent_inferred), `confidence`, `phase` si existe,
  `status` si no es active, y **"importada v11"** cuando `session_id === 'legacy-migration'`.
- `evidence[]` agrupada por `kind`. En las migradas, el `quote` es el `reasoning` legacy — se rotula como tal.

## Paso 5 — Knowledge

- `load()` llama `listDecisionRecords(p.id)`; se elimina `listDecisions`. La tabla legacy desaparece de la UI.
- El filtro `imp ≥` no aplica al modelo nuevo. Reemplazo: selects de `origin` y `confidence`.
  El filtro de status queda (`active` / todos) porque `decision_records.status` sí existe.
  Los filtros de importance siguen vigentes para los tabs Artifacts y Notes: pasan a mostrarse por tab.
- Texto buscable: `statement + forces + alternatives.option + consequences + topic_key`.
- Al seleccionar un record, el panel de detalle pide `getDecisionChain(project_id, topic_key)` y renderea
  tip-first. Con un solo eslabón no se muestra sección de cadena (ruido); con dos o más, la lista completa
  con el tip marcado y los superseded atenuados.
- Audit trail: `entityType='decision_record'` (los triggers de la 012 ya escriben esos eventos).
- Relaciones: se mantiene la llamada. Para las 40 nativas devuelve vacío y ya hay un estado "sin relaciones".

## Paso 6 — Context Builder y Global Search

- `context-builder.component.ts`: `itemPrimary()` → `statement`; `itemSecondary()` → primer `force`
  o la primera consecuencia (lo que dé más señal en una línea).
- `global-search.component.ts`: `snippet()` → `title`/`summary` que el backend ya manda para este tipo.
- `global-search.component.html`: etiqueta "Decisión (v12)" en el pill, caso `'decision_record'` en el
  `ngSwitch` del modal reusando `app-decision-record`, y los chips `importance`/`rev` condicionados —
  hoy se renderearían como `undefined` para este tipo.

## Paso 7 — Verificación

Los dos comandos del frontmatter, más comprobación manual contra la DB real:
38 tips en mcp_memory, cero filas legacy visibles, y la cadena `harness.alcance-v1` mostrando sus 2 eslabones.

## Fuera de alcance (queda como thread)

Overview, History, Graph y Judgments siguen leyendo `decisions`. Graph y Judgments además dependen de
`memory_relations`, que sigue usando `type='decision'` y no tiene una sola fila con `decision_record`:
migrarlos exige decidir qué pasa con las relaciones, y eso es una tarea propia.
