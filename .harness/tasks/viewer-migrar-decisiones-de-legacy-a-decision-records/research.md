---
goal: >
  Migrar el viewer de la tabla legacy `decisions` (congelada en v12) a `decision_records`:
  leer tips activos, renderear la estructura parseada en vez de texto plano, y ofrecer la
  vista de cadena tip-first equivalente a context_for_topic.
findings:
  - "El backend ya migró: build_context (context.rs:336) y search_all (search.rs:177) emiten type='decision_record'. El viewer no lo contempla."
  - "Bug vivo: ContextItem (models.ts:308) y SearchAllResult (models.ts:367) son uniones sin el caso 'decision_record', y los switch que las consumen no tienen default. Hoy Context Builder muestra undefined e itemPrimary/snippet devuelven vacío para cada tip."
  - "311 decision_records (307 active, 4 superseded). 271 son copias legacy identificables por session_id='legacy-migration'; 40 son nativas."
  - "decision_records ya contiene la historia legacy: la 012 conservó el id original, por eso las 271 migradas siguen matcheando memory_relations (type='decision'). Las 40 nativas no tienen ninguna relación."
  - "La tabla legacy sólo aporta como dato exclusivo 18 filas no-active (la 012 migró sólo las active) y los campos importance/revision_count/obsolete_reason, dropeados a propósito por el modelo nuevo."
  - "Sólo existe 1 cadena con más de un eslabón (harness.alcance-v1, n=2): la vista de cadena se construye casi sin datos de prueba."
  - "Los triggers de la 012 escriben events(entity_type='decision_record') — 315 filas. get_audit_trail del viewer funciona sin cambios."
  - "list_decisions/get_decision se consumen en 7 superficies: Knowledge, Overview, History, Graph, Judgments, Global Search y Context Builder."
open_questions:
  - "RESUELTA (Pablo, 2026-09-03): alcance = Knowledge + los dos consumidores rotos (Context Builder, Global Search). Overview/History/Graph/Judgments quedan como thread aparte."
  - "RESUELTA (Pablo, 2026-09-03): la tabla legacy se esconde de la UI; se aceptan como pérdida las 18 filas obsoletas no migradas."
  - "RESUELTA (Pablo, 2026-09-03): las migradas llevan badge 'importada v11' (session_id='legacy-migration') para que la ausencia de forces/alternatives se lea como dato faltante, no como decisión pobre."
  - "RESUELTA (Pablo, 2026-09-03): la vista de cadena se construye en esta tarea."
  - "ABIERTA: el filtro por importance desaparece con el modelo nuevo. Propuesta para el plan: reemplazarlo por filtros de origin + confidence + phase."
---

# Research — viewer: migrar decisiones de legacy a decision_records

Fase: exploration. Fuente del pedido: thread `9a8c0809`.

## 1. Estado del backend (ya migrado — el viewer quedó atrás)

`rust/src/repo/decision_records.rs` expone la API completa:

| fn | firma | uso previsto en el viewer |
|---|---|---|
| `list_tips(db, project_id)` | `Vec<DecisionRecordRow>` — status='active', created_at DESC | lista principal de Knowledge |
| `chain(db, project_id, topic_key, depth)` | `Vec<DecisionRecordRow>` tip-first siguiendo `supersedes` | vista de cadena (equivalente UI de `context_for_topic`) |
| `get(db, id)` | `Option<DecisionRecordRow>` | detalle / judgments |

`DecisionRecordRow` ya es estructura parseada (Rust deserializa los `*_json`):
`statement`, `forces: Vec<String>`, `alternatives: Vec<{option, rejected_because: Option<String>}>`,
`consequences: Vec<String>`, `origin`, `evidence: Vec<{kind, value}>`, `confidence`,
`status`, `status_reason`, `supersedes`, `superseded_by`, `phase`, `session_id`, `topic_key`, `created_at`.

**No hay `importance`, `updated_at`, `revision_count` ni `obsolete_reason`** — el modelo nuevo los dropeó a propósito
(`search.rs:139`: "decision_records dropped importance by design").

Otros módulos del crate que YA emiten `decision_record`:
- `repo/context.rs:336` — `build_context` carga los tips (`load_decision_records`) y renderea `ContextItem::DecisionRecord`.
- `repo/search.rs:177` — `search_all` indexa `decision_records_fts` y emite `SearchAllResult::DecisionRecord`
  (`#[serde(tag="type", rename_all="snake_case")]` → `type: "decision_record"`, con `title`/`summary`/`origin`/`confidence`/`phase`).

## 2. Datos reales en `memory.db` (2026-09-03)

```
decision_records:        311   (307 active, 4 superseded)
  · session_id='legacy-migration':  271  ← copias de decisions migradas por 012
  · nativas (decision_record tool):  40
decisions (legacy):      289   (271 migradas + 18 no migradas: la 012 sólo tomó las active)
proyecto mcp_memory:      38 tips  vs  27 decisions legacy
cadenas con >1 eslabón:    1  (harness.alcance-v1, n=2)
origin:      agent_inferred 274 · user_explicit 36 · user_implicit 1
confidence:  decided 311 (ninguna tentative todavía)
phase:       null 277 · planning 23 · implementation 11
```

**Hallazgo que decide el punto (d) del thread:** las migradas son identificables sin heurística —
`session_id = 'legacy-migration'` da exactamente 271. La migración (`012_decision_records.sql:124`) mapeó
`decisions.reasoning` → `evidence_json` como `{kind:"quote"}`, dejó `forces/alternatives/consequences` en `[]`,
`origin='agent_inferred'`, `topic_key` vacío → `'legacy-' || d.id`, y conservó el `id` original.
Es decir: **`decision_records` ya contiene la historia legacy**. La tabla `decisions` sólo aporta,
como información exclusiva, las 18 filas no-active y los campos `importance`/`revision_count`/`obsolete_reason`.

## 3. Superficie del viewer afectada (más grande que Knowledge)

`list_decisions` / `get_decision` (Tauri) → `decisions::list_all` / `decisions::get`. Consumidores:

| Sección | Uso | Impacto |
|---|---|---|
| `sections/knowledge` | tab Decisions: lista + detalle + filtro por importance | reescritura del render (el objetivo del thread) |
| `sections/overview` | conteo/últimas decisiones | cambia la fuente |
| `sections/history` | `decisionsById` para resolver `SessionSummary.decisions_ref[]` | los refs nuevos son ids de decision_records |
| `sections/graph` | nodos `decision:<id>` | `memory_relations` sigue usando `source/target_type='decision'` (70 decision→decision, 53 note→decision…) |
| `sections/judgments` | `getDecision(id)` para el preview de la relación | ídem: los ids relacionados son legacy |
| `shared/global-search` | `snippet()` sobre `SearchAllResult` | **roto hoy** |
| `sections/context-builder` | `itemPrimary()/itemSecondary()` sobre `ContextItem` | **roto hoy** |

### Bug vivo ya presente (no lo introduce esta tarea, lo revela)

`viewer/src/app/core/models.ts:308` (`ContextItem`) y `:367` (`SearchAllResult`) son uniones discriminadas que
**no contemplan `'decision_record'`**, y los `switch` que las consumen no tienen `default`:
- `context-builder.component.ts:102` → `itemPrimary()` devuelve `undefined` para cada tip.
- `global-search.component.ts:160` → `snippet()` devuelve `''`.

O sea: hoy el Context Builder y el buscador global ya reciben tips del backend y los muestran en blanco.

## 4. Infra que sí sirve tal cual

- **Audit trail**: los triggers de la 012 escriben `events(entity_type='decision_record')` — hay 315 filas.
  `get_audit_trail(type, id)` del viewer funciona sin cambios pasándole `'decision_record'`.
- **Relaciones**: `memory_relations` NO tiene ninguna fila con type `decision_record`. Un tip nativo no tiene
  relaciones que mostrar; el panel de relaciones queda vacío para las 40 nativas y poblado para las 271 migradas
  (que conservaron el id legacy → las relaciones viejas siguen matcheando por id).

## 5. Decisiones abiertas para planning (las resuelve Pablo)

1. **Tabla legacy**: ¿esconderla del todo (decision_records ya la contiene, salvo 18 filas obsoletas),
   o dejar una vista "pre-v12" de solo lectura?
2. **Migradas vs nativas**: ¿badge visible ("importada de v11", detectable por `session_id='legacy-migration'`)
   o tratarlas igual? Son el 87% del total y no tienen forces/alternatives/consequences.
3. **Filtro por importance**: desaparece del modelo. ¿Se reemplaza por filtro de `origin` + `confidence` + `phase`,
   o simplemente se saca?
4. **Alcance de esta tarea**: ¿sólo Knowledge (a+b+c del thread), o también los dos consumidores rotos
   (Context Builder y Global Search) y los otros cuatro (Overview/History/Graph/Judgments)?
5. **Vista de cadena**: con 1 sola cadena de 2 eslabones en la DB, ¿se construye ahora igual (el thread la marca
   como "el valor del modelo nuevo") o se difiere?
