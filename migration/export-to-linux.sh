#!/usr/bin/env bash
# Corre en Windows (Git Bash / WSL) desde cualquier lado.
# Empaqueta configs portables + BD del MCP memory en un tarball.
set -euo pipefail

WIN_HOME="/c/Users/Desarrollos"
OUT_DIR="${1:-$WIN_HOME/claude-migration-bundle}"
STAGE="$OUT_DIR/stage"
TARBALL="$OUT_DIR/claude-migration-$(date +%Y%m%d-%H%M%S).tar.gz"

rm -rf "$STAGE"
mkdir -p "$STAGE"/{dot-claude,dot-codex,dot-config,mcp-repo,auto-memory}

# copy_tree SRC_DIR DST_DIR [extra tar --exclude args...]
# Copia contenido de SRC a DST usando tar-pipe (respeta excludes).
copy_tree() {
  local src="$1" dst="$2"; shift 2
  [ -d "$src" ] || { echo "  (skip: $src no existe)"; return 0; }
  mkdir -p "$dst"
  ( cd "$src" && tar -cf - "$@" . ) | ( cd "$dst" && tar -xf - )
}

echo "[1/7] agent-rules (skills, hooks, RULES.md)"
copy_tree "$WIN_HOME/.config/agent-rules" "$STAGE/dot-config/agent-rules" \
  --exclude='./vendor/node_modules' --exclude='./node_modules'

echo "[2/7] opencode config (sin DB ni node_modules)"
mkdir -p "$STAGE/dot-config/opencode"
for item in opencode.json AGENTS.md agents skills plugins package.json; do
  if [ -e "$WIN_HOME/.config/opencode/$item" ]; then
    cp -a "$WIN_HOME/.config/opencode/$item" "$STAGE/dot-config/opencode/"
  fi
done
[ -f "$WIN_HOME/.config/AGENTS.md" ] && cp "$WIN_HOME/.config/AGENTS.md" "$STAGE/dot-config/AGENTS.md"

echo "[3/7] repo mcp-learning (sin target/, node_modules/, dist/, memory.db*)"
# OJO con el anclaje de los excludes: un patron que arranca con './' es una RUTA
# desde el raiz del archivo, no un nombre. './node_modules' dejaba pasar
# 'harness/node_modules' (99 MB, 8789 archivos), que ademas de inflar el bundle
# hacia morir al tar a mitad de camino y truncaba todo lo que venia despues
# alfabeticamente: rust/, viewer/, migration/ y memory.db. Sin el './' matchea a
# cualquier profundidad, que es lo que se queria.
copy_tree "$WIN_HOME/.config/mcp-learning" "$STAGE/mcp-repo" \
  --exclude='./rust/target' \
  --exclude='./rust/target-check' \
  --exclude='./rust/target-*' \
  --exclude='./viewer/node_modules' \
  --exclude='./viewer/dist' \
  --exclude='./viewer/build' \
  --exclude='./viewer/.angular' \
  --exclude='./viewer/src-tauri/target' \
  --exclude='./viewer/src-tauri/gen' \
  --exclude='node_modules' \
  --exclude='./.git' \
  --exclude='./memory.db' \
  --exclude='./memory.db-shm' \
  --exclude='./memory.db-wal' \
  --exclude='./memory.db.bak-*' \
  --exclude='./harness/state' \
  --exclude='./migration-bundle' \
  --exclude='./migration/stage'

echo "[4/7] BD del MCP memory (SQLite portable)"
# Checkpoint del WAL: sin esto, lo último escrito vive en memory.db-wal
# (que NO viaja en el bundle) y se pierde en la migración.
DB_PATH="$WIN_HOME/.config/mcp-learning/memory.db"
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DB_PATH" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null || true
  echo "  checkpoint via sqlite3 OK"
elif node -e 'require("node:sqlite")' >/dev/null 2>&1; then
  # Node >= 22 trae node:sqlite built-in; no hace falta sqlite3 en el PATH.
  node -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    const n = db.prepare("SELECT count(*) AS n FROM projects").get().n;
    db.close();
    console.log("  checkpoint via node:sqlite OK (" + n + " proyectos)");
  ' "$DB_PATH"
else
  echo "  !! Sin sqlite3 ni node:sqlite: copio el .db sin checkpoint."
  echo "  !! Cerrá todo cliente MCP antes de confiar en esta copia."
fi
cp "$DB_PATH" "$STAGE/mcp-repo/memory.db"

echo "[5/7] ~/.claude (settings, CLAUDE.md, skills, .claude.json)"
cp "$WIN_HOME/.claude/settings.json" "$STAGE/dot-claude/settings.json"
cp "$WIN_HOME/.claude/CLAUDE.md" "$STAGE/dot-claude/CLAUDE.md"
copy_tree "$WIN_HOME/.claude/skills" "$STAGE/dot-claude/skills"
copy_tree "$WIN_HOME/.claude/agents" "$STAGE/dot-claude/agents"

# ~/.claude.json: NO se copia entero (el destino tiene su propio estado de
# onboarding/auth). Se extrae solo lo portable para que el installer lo mergee.
if [ -f "$WIN_HOME/.claude.json" ] && command -v node >/dev/null 2>&1; then
  node -e '
    const fs = require("fs");
    const src = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const out = { mcpServers: src.mcpServers || {}, projects: {} };
    // De cada proyecto guardamos solo config real, no historial ni caches.
    const KEEP = ["mcpServers","allowedTools","enabledMcpjsonServers",
                  "disabledMcpjsonServers","hasTrustDialogAccepted",
                  "projectOnboardingSeenCount","enabledPlugins"];
    for (const [path, cfg] of Object.entries(src.projects || {})) {
      const slim = {};
      for (const k of KEEP) if (cfg[k] !== undefined) slim[k] = cfg[k];
      if (Object.keys(slim).length) out.projects[path] = slim;
    }
    fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 2));
    console.log("  claude.json portable: " + Object.keys(out.projects).length +
                " proyectos, " + Object.keys(out.mcpServers).length + " mcpServers");
  ' "$WIN_HOME/.claude.json" "$STAGE/dot-claude/claude.json.portable"
else
  echo "  (skip .claude.json: falta el archivo o node)"
fi

echo "[6/7] auto-memory de Claude Code (todos los proyectos)"
AUTOMEM_COUNT=0
for d in "$WIN_HOME"/.claude/projects/*/memory; do
  [ -d "$d" ] || continue
  proj="$(basename "$(dirname "$d")")"
  copy_tree "$d" "$STAGE/auto-memory/$proj"
  AUTOMEM_COUNT=$((AUTOMEM_COUNT + 1))
done
echo "  $AUTOMEM_COUNT directorios de auto-memory"

echo "[7/7] ~/.codex (AGENTS.md, config.toml)"
[ -f "$WIN_HOME/.codex/AGENTS.md" ] && cp "$WIN_HOME/.codex/AGENTS.md" "$STAGE/dot-codex/AGENTS.md"
[ -f "$WIN_HOME/.codex/config.toml" ] && cp "$WIN_HOME/.codex/config.toml" "$STAGE/dot-codex/config.toml"

cp "$(dirname "$0")/install-on-linux.sh" "$STAGE/install-on-linux.sh"
cp "$(dirname "$0")/merge-claude-json.cjs" "$STAGE/merge-claude-json.cjs"
chmod +x "$STAGE/install-on-linux.sh"

echo "==> Empaquetando..."
tar -czf "$TARBALL" -C "$STAGE" .

# --- Verificacion del artefacto ------------------------------------------
# Un bundle incompleto se ve exactamente igual que uno bueno: mismo nombre,
# extension valida, tamano plausible. El 2026-09-05 salio uno sin memory.db,
# sin rust/ y sin viewer/ porque el tar murio dentro de harness/node_modules, y
# el script igual imprimio OK. Se detecta aca, o se detecta en la maquina nueva
# sin la vieja para volver.
echo "==> Verificando el tarball..."
LISTING="$(mktemp)"
trap 'rm -f "$LISTING"' EXIT
tar -tzf "$TARBALL" > "$LISTING"

MISSING=0
require() {
  # $1 = patron grep (anclado), $2 = descripcion para el humano
  if ! grep -q "$1" "$LISTING"; then
    echo "  FALTA: $2"
    MISSING=$((MISSING + 1))
  fi
}

require '^\./mcp-repo/memory\.db$'           "memory.db (la BD del MCP)"
require '^\./mcp-repo/rust/Cargo\.toml$'     "rust/ (crate del servidor MCP)"
require '^\./mcp-repo/viewer/package\.json$' "viewer/"
require '^\./mcp-repo/migration/'            "migration/"
require '^\./merge-claude-json\.cjs$'        "merge-claude-json.cjs"
require '^\./install-on-linux\.sh$'          "install-on-linux.sh"
require '^\./dot-claude/settings\.json$'     "dot-claude/settings.json"
require '^\./dot-config/agent-rules/'        "dot-config/agent-rules/"
require '^\./auto-memory/'                   "auto-memory/"

# La BD es el unico contenido irrecuperable del bundle: todo lo demas se vuelve
# a clonar o a buildear. Se compara el tamano contra el original, porque una
# copia truncada aparece en el listado igual que una entera.
DB_IN_TAR="$(tar -tzvf "$TARBALL" | awk '$NF == "./mcp-repo/memory.db" { print $3 }')"
DB_REAL="$(wc -c < "$DB_PATH" | tr -d ' ')"
if [ -n "$DB_IN_TAR" ] && [ "$DB_IN_TAR" != "$DB_REAL" ]; then
  echo "  memory.db TRUNCADA: $DB_IN_TAR bytes en el bundle vs $DB_REAL en origen"
  MISSING=$((MISSING + 1))
fi

if [ "$MISSING" -gt 0 ]; then
  echo ""
  echo "!! BUNDLE INCOMPLETO ($MISSING faltantes). NO migres con este archivo."
  echo "!! Revisa la salida de arriba por errores de tar y volve a correr."
  rm -f "$TARBALL"
  exit 1
fi

echo "  OK: $(wc -l < "$LISTING" | tr -d ' ') entradas, memory.db $DB_REAL bytes."

SIZE=$(du -h "$TARBALL" | cut -f1)
echo ""
echo "OK -> $TARBALL ($SIZE)"
echo ""
echo "En Linux:"
echo "  mkdir -p ~/migration && tar -xzf $(basename "$TARBALL") -C ~/migration"
echo "  cd ~/migration && ./install-on-linux.sh"
