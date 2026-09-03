# Migración Windows -> Linux

Empaqueta y restaura toda la config de agentes (Claude Code, opencode, Codex),
`agent-rules`, el repo `mcp-learning` y la BD SQLite del MCP `memory`.

## Qué incluye

| Origen (Windows) | Destino (Linux) |
|---|---|
| `~/.config/agent-rules/` (sin node_modules) | `~/.config/agent-rules/` |
| `~/.config/opencode/{opencode.json,agents,skills,plugins,AGENTS.md,package.json}` | `~/.config/opencode/` |
| `~/.config/AGENTS.md` | `~/.config/AGENTS.md` |
| `~/.config/mcp-learning/` (sin `target/`, `node_modules/`, `.git`, `harness/state/`) | `~/.config/mcp-learning/` |
| `~/.config/mcp-learning/memory.db` (checkpointed) | `~/.config/mcp-learning/memory.db` |
| `~/.claude/{settings.json,CLAUDE.md,skills/}` | `~/.claude/…` |
| `~/.claude/projects/C--Users-Desarrollos--config-mcp-learning/memory/` | `~/.claude/projects/-home-<user>--config-mcp-learning/memory/` |
| `~/.codex/{AGENTS.md,config.toml}` | `~/.codex/…` |

## Qué NO incluye (por diseño)

- `rust/target/`, `viewer/node_modules/`, `viewer/dist/`, `viewer/src-tauri/target/` — se rebuildea en Linux.
- Iconos Windows del viewer (`.ico`, `.icns`) — Tauri los regenera.
- Sesiones históricas de Claude Code (`~/.claude/projects/*/*.jsonl`, `~/.claude/sessions/`) — ruido, no config.
- Cachés (`~/.claude/{cache,image-cache,shell-snapshots,…}`).
- BDs internas de opencode (`~/.config/opencode/DB/`) — se regeneran.
- BDs internas de Codex (`~/.codex/{logs_*,state_*,memories_*,goals_*}.sqlite`).
- `.git/` del repo (cloná limpio si querés, o traelo aparte).

## Uso

**En Windows** (Git Bash):

```bash
cd ~/.config/mcp-learning/migration
bash export-to-linux.sh
```

Genera `migration-bundle/claude-migration-<timestamp>.tar.gz`.

**En Linux**:

```bash
mkdir -p ~/migration
tar -xzf claude-migration-<timestamp>.tar.gz -C ~/migration
cd ~/migration
./install-on-linux.sh
```

El instalador:
- Hace backup (`.bak.<epoch>`) de cualquier archivo existente que vaya a sobrescribir.
- Reescribe rutas Windows -> `$HOME` en archivos de texto (json/md/toml/cjs/sh/…).
- Renombra el dir de auto-memory de Claude Code para que matchee el path Linux.

## Post-instalación

Los pasos manuales están al final del `install-on-linux.sh`:

1. `cargo build --release` en `rust/`.
2. `npm install && npm run tauri build` en `viewer/`.
3. Verificar que `~/.claude/settings.json` apunta al binario Rust en la ruta Linux.
4. Verificar que los hooks `.cjs` en `agent-rules/skills/*/hooks/` corren con `node`.
5. Probar `list_projects` para confirmar que la BD abre OK.

## Rollback

Todos los archivos que existían pre-instalación quedaron como `<archivo>.bak.<epoch>`.
Para revertir un archivo: `mv archivo.bak.<epoch> archivo`.
