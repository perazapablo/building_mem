# mcp-memory

Servidor MCP de memoria persistente para agentes de IA. Permite que Claude (u otro agente compatible con MCP) recuerde contexto entre sesiones usando una base de datos SQLite local.

## Qué hace

Expone tools MCP que el agente usa para guardar, recuperar y mantener memoria estructurada:

| Tool | Descripción |
|---|---|
| `get_sessions` | Lista sesiones recientes |
| `save_session` | Crea una nueva sesión |
| `update_session` | Actualiza el resumen de una sesión |
| `upsert_project` | Crea o actualiza un proyecto |
| `get_project` | Devuelve el detalle de un proyecto |
| `get_project_context` | Devuelve notes, decisions y artifacts de un proyecto |
| `build_context` | Construye contexto token-aware con notes, decisions, artifacts y code_entities |
| `set_working_state` / `get_working_state` | Guarda o recupera foco activo, threads abiertos y pins |
| `update_project_context_summary` | Actualiza el resumen compacto de contexto del proyecto |
| `checkpoint` | Consolida una sesión: summary denso, project context summary y contexto asociado |
| `add_note` | Guarda un hecho o contexto atómico |
| `add_decision` | Registra una decisión con su razonamiento |
| `add_artifact` | Guarda un output estructurado (schema, config, diseño) |
| `search_notes` | Búsqueda full-text sobre las notas |
| `search_all` | Búsqueda full-text unificada en notes, decisions, artifacts y code_entities |
| `add_code_entity` / `update_code_entity` | Registra o actualiza memoria estructurada de código |
| `get_code_entity` / `search_code_entities` | Consulta memoria de funciones, módulos, archivos, endpoints, configs o schemas |
| `get_code_entity_context` | Devuelve contexto de código activo para un proyecto y query |
| `add_link` | Conecta entidades del grafo de memoria |
| `get_related` | Recorre relaciones bidireccionales del grafo |
| `get_audit_trail` | Devuelve historial auditable de una entidad |
| `update_note` / `update_decision` / `update_artifact` | Actualiza entidades existentes |
| `delete_note` / `delete_decision` / `delete_artifact` | Borra entidades creadas por error |
| `mark_obsolete` | Marca entidades como obsoletas sin borrar historia |
| `audit_stale` | Lista entidades activas sin actualizar en N días |

La base de datos (`memory.db`) se crea automáticamente en la raíz del proyecto al primer uso.
Podés cambiar el path con `MCP_MEMORY_DB_PATH`, útil para tests o entornos separados.

El schema usa migraciones versionadas en `schema_migrations`. También mantiene un audit log append-only en `events` para inserts, updates y deletes de las entidades principales.

## Identidad de memoria

Las entidades de memoria usan control interno de identidad:

- `content_hash`: hash interno del contenido normalizado; evita duplicados textuales básicos.
- `topic_key`: llave semántica opcional. Si una entidad activa del mismo proyecto ya tiene el mismo `topic_key`, `add_*` actualiza esa fila en vez de insertar otra.
- `revision_count`: cuenta cuántas veces evolucionó esa entidad.

En `code_entities`, `topic_key` nunca queda vacío: si no se envía, el servidor lo deriva de `qualified_name` o `name`.

FTS5 indexa `topic_key`, por lo que `search_all` también puede encontrar memoria por tema.

## Requisitos

- Node.js 18+
- npm

## Instalación

```bash
git clone <url-del-repo>
cd mcp-memory
npm install
npm run build
```

## Configurar en Claude Code

Agregá el servidor en tu archivo de settings de Claude Code (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["/ruta/absoluta/a/mcp-memory/dist/server.js"]
    }
  }
}
```

Reemplazá `/ruta/absoluta/a/mcp-memory` con el path real donde clonaste el repositorio.

**Ejemplos por plataforma:**

- macOS/Linux: `/home/usuario/.config/mcp-memory/dist/server.js`
- Windows: `C:/Users/usuario/.config/mcp-memory/dist/server.js`

### Permitir los tools sin confirmación manual

Para que el agente pueda guardar y consultar memoria sin interrumpir la conversación, agregá los tools a `permissions.allow`:

```json
{
  "permissions": {
    "allow": [
      "mcp__memory__get_sessions",
      "mcp__memory__save_session",
      "mcp__memory__update_session",
      "mcp__memory__upsert_project",
      "mcp__memory__get_project",
      "mcp__memory__get_project_context",
      "mcp__memory__build_context",
      "mcp__memory__set_working_state",
      "mcp__memory__get_working_state",
      "mcp__memory__update_project_context_summary",
      "mcp__memory__checkpoint",
      "mcp__memory__add_note",
      "mcp__memory__add_decision",
      "mcp__memory__add_artifact",
      "mcp__memory__search_notes",
      "mcp__memory__search_all",
      "mcp__memory__add_code_entity",
      "mcp__memory__update_code_entity",
      "mcp__memory__get_code_entity",
      "mcp__memory__search_code_entities",
      "mcp__memory__get_code_entity_context",
      "mcp__memory__add_link",
      "mcp__memory__get_related",
      "mcp__memory__get_audit_trail"
    ]
  }
}
```

## Desarrollo

Para correr sin compilar (útil al modificar el código):

```bash
npm start
```

Usa `tsx` para ejecutar TypeScript directamente.
