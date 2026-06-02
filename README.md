# mcp-memory

Servidor MCP de memoria persistente para agentes compatibles con MCP. La
implementacion activa vive en Rust y usa SQLite local para compartir continuidad
entre Codex, Claude Code y otros clientes por medio de procesos `stdio`
independientes.

## Capacidades

El servidor expone tools para:

- administrar sesiones y proyectos;
- guardar notes, decisions, artifacts y code entities;
- construir contexto token-aware con prioridades y pins;
- mantener working state por sesion;
- buscar con FTS5;
- relacionar entidades y revisar relaciones detectadas automaticamente;
- auditar cambios, marcar memoria obsoleta y consolidar checkpoints.

La base se configura con `MCP_MEMORY_DB_PATH`. Define siempre esta variable en
clientes MCP: el fallback queda junto al ejecutable y es util solamente para
pruebas aisladas.

`MCP_MEMORY_TOKENIZER` acepta:

- `generic:conservative`
- `anthropic:claude`
- `openai:o200k_base`
- `openai:cl100k_base`

La version Rust actual registra el identificador seleccionado, pero todos los
modelos usan temporalmente el mismo estimador conservador. Esto permite cambiar
el tokenizer real mas adelante sin migrar identidades.

## Requisitos

- Rust estable con Cargo
- SQLite no requiere instalacion separada: `rusqlite` compila SQLite embebido

## Build Y Validacion

```powershell
cargo test --manifest-path rust/Cargo.toml
cargo build --release --manifest-path rust/Cargo.toml
```

El ejecutable resultante queda en:

```text
rust/target/release/mcp-memory.exe
```

## Configurar En Codex

Agrega el servidor a `~/.codex/config.toml`:

```toml
[mcp_servers.memory]
command = "C:\\Users\\usuario\\.config\\mcp-learning\\rust\\target\\release\\mcp-memory.exe"
args = []

[mcp_servers.memory.env]
MCP_MEMORY_DB_PATH = "C:\\Users\\usuario\\.config\\mcp-learning\\memory.db"
MCP_MEMORY_TOKENIZER = "openai:o200k_base"
```

Reinicia Codex despues de modificar la configuracion para que abra una conexion
nueva contra el binario Rust.

## Configurar En Claude Code

Claude Code usa el mismo ejecutable y la misma base:

```json
{
  "mcpServers": {
    "memory": {
      "type": "stdio",
      "command": "C:/Users/usuario/.config/mcp-learning/rust/target/release/mcp-memory.exe",
      "args": [],
      "env": {
        "MCP_MEMORY_DB_PATH": "C:/Users/usuario/.config/mcp-learning/memory.db",
        "MCP_MEMORY_TOKENIZER": "anthropic:claude"
      }
    }
  }
}
```

## Configurar En OpenCode

OpenCode tambien usa el mismo ejecutable y la misma base. Como puede alternar
modelos de distintos proveedores, el default conservador es la opcion estable:

```json
{
  "mcp": {
    "memory": {
      "type": "local",
      "command": [
        "C:/Users/usuario/.config/mcp-learning/rust/target/release/mcp-memory.exe"
      ],
      "environment": {
        "MCP_MEMORY_DB_PATH": "C:/Users/usuario/.config/mcp-learning/memory.db",
        "MCP_MEMORY_TOKENIZER": "generic:conservative"
      }
    }
  }
}
```

## Protocolo Operativo

Lee [MEMORY_RULES.md](MEMORY_RULES.md) para las reglas de uso cotidiano y
[MEMORY_PROTOCOL.md](MEMORY_PROTOCOL.md) para el modelo mental, lifecycle,
relaciones y resolucion de conflictos.

