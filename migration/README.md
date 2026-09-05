# Migración Windows -> Linux

Empaqueta y restaura toda la config de agentes (Claude Code, opencode, Codex),
`agent-rules`, el repo `mcp-learning` y la BD SQLite del MCP `memory`.

## Qué incluye

| Origen (Windows) | Destino (Linux) |
|---|---|
| `~/.config/agent-rules/` (sin node_modules) | `~/.config/agent-rules/` |
| `~/.config/opencode/{opencode.json,agents,skills,plugins,AGENTS.md,package.json}` | `~/.config/opencode/` |
| `~/.config/AGENTS.md` | `~/.config/AGENTS.md` |
| `~/.config/mcp-learning/` (sin `target/`, `node_modules/`, `build/`, `.git`, `harness/state/`) | `~/.config/mcp-learning/` |
| `~/.config/mcp-learning/memory.db` (checkpointed) | `~/.config/mcp-learning/memory.db` |
| `~/.claude/{settings.json,CLAUDE.md,skills/,agents/}` | `~/.claude/…` |
| `~/.claude.json` — **solo `mcpServers` + config por proyecto** | mergeado en `~/.claude.json` |
| `~/.claude/projects/*/memory/` — **los 13 directorios** | `~/.claude/projects/-home-<user>-…/memory/` |
| `~/.codex/{AGENTS.md,config.toml}` | `~/.codex/…` |

## Qué NO incluye (por diseño)

- `rust/target/`, `viewer/node_modules/`, `viewer/dist/`, `viewer/build/`,
  `viewer/src-tauri/target/` — se rebuildea en Linux (~12.8 GB regenerables).
- Iconos Windows del viewer (`.ico`, `.icns`) — Tauri los regenera.
- `~/.claude/.credentials.json` — token de auth. **Hay que volver a loguearse.**
- Sesiones históricas de Claude Code (`~/.claude/projects/*/*.jsonl`, ~151 MB) — ruido.
- Cachés (`~/.claude/{cache,image-cache,shell-snapshots,file-history,plugins}`).
  Los plugins se redescargan solos desde `enabledPlugins` en `settings.json`.
- BDs internas de opencode (`~/.config/opencode/DB/`) y de Codex
  (`~/.codex/{logs_*,state_*,memories_*,goals_*,queue_*}.sqlite`).
- `.git/` del repo (cloná limpio desde `github.com/perazapablo/building_mem.git`).

## Por qué `~/.claude.json` se mergea y no se copia

Ese archivo mezcla dos cosas: config portable (`mcpServers`, ajustes por
proyecto) y estado de la máquina (OAuth, onboarding, `machineID`, cachés de
features). Copiarlo entero te lleva al Linux un `userID` y un estado de auth que
no corresponden. El export extrae solo lo portable a `claude.json.portable`, y
`merge-claude-json.cjs` lo inyecta en el destino sin tocar el resto.

De los 83 proyectos, el merge conserva solo aquellos cuyo path **existe en
Linux**. El resto (`C:\Users\Pablo\UNI`, etc.) se descarta como ruido.

## Traducción de nombres de auto-memory

Claude Code deriva el nombre del directorio del CWD, reemplazando separadores
por guiones:

```
Windows: C--Users-Desarrollos--config-mcp-learning
Linux:   -home-<user>--config-mcp-learning
```

El installer traduce el prefijo `C--Users-Desarrollos` -> `-home-<user>`. Los
directorios de otros paths (`C--Users-Pablo-UNI`, `C--Users-pablo-pcoriente-BACKUP`)
no tienen equivalente automático: se copian con el nombre original y quedan
inertes hasta que renombres a mano si volvés a trabajar en ese path.

## Uso

**En Windows** (Git Bash):

```bash
cd ~/.config/mcp-learning/migration
bash export-to-linux.sh
```

Genera `~/claude-migration-bundle/claude-migration-<timestamp>.tar.gz`.

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
- Reescribe `mcp-memory.exe` -> `mcp-memory` (cargo en Linux no produce `.exe`).
- Mergea `~/.claude.json` en vez de pisarlo (backup en `~/.claude.json.premerge`).
- Traduce los nombres de directorio del auto-memory.

## Post-instalación

Los pasos manuales están al final del `install-on-linux.sh`:

1. `cargo build --release` en `rust/` — verificar que produce `mcp-memory` sin `.exe`.
2. `npm install && npm run tauri build` en `viewer/`.
3. **Login de Claude Code** (`claude`) — las credenciales no se migran.
4. `grep -n 'mcp-memory' ~/.claude/settings.json ~/.claude.json`.
5. `grep -rn 'C:' ~/.claude/settings.json ~/.config/agent-rules/` debe salir vacío.
6. Probar `list_projects` para confirmar que la BD abre OK.

## `agent-rules` viaja por git, no por el tarball

`~/.config/agent-rules/` es un repo propio:
`github.com/perazapablo/agent-rules` (privado). En el destino conviene clonarlo
en vez de dejar que el installer lo extraiga:

```bash
git clone --recurse-submodules https://github.com/perazapablo/agent-rules.git ~/.config/agent-rules
```

El `--recurse-submodules` importa: `vendor/mattpocock-skills` es un submódulo y
sin él las skills de vendor quedan como directorios vacíos.

El tarball igual lo incluye, como respaldo para el caso de no tener acceso al
repo durante la migración. Si clonás, dejá que el installer sobrescriba y después
verificá con `git -C ~/.config/agent-rules status` que no quedaron cambios
locales inesperados.

## Rollback

Todos los archivos que existían pre-instalación quedaron como `<archivo>.bak.<epoch>`,
y `~/.claude.json` como `~/.claude.json.premerge`.
Para revertir: `mv archivo.bak.<epoch> archivo`.
