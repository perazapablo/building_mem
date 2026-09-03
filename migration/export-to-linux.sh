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

echo "[1/6] agent-rules (skills, hooks, RULES.md)"
copy_tree "$WIN_HOME/.config/agent-rules" "$STAGE/dot-config/agent-rules" \
  --exclude='./vendor/node_modules' --exclude='./node_modules'

echo "[2/6] opencode config (sin DB ni node_modules)"
mkdir -p "$STAGE/dot-config/opencode"
for item in opencode.json AGENTS.md agents skills plugins package.json; do
  if [ -e "$WIN_HOME/.config/opencode/$item" ]; then
    cp -a "$WIN_HOME/.config/opencode/$item" "$STAGE/dot-config/opencode/"
  fi
done
[ -f "$WIN_HOME/.config/AGENTS.md" ] && cp "$WIN_HOME/.config/AGENTS.md" "$STAGE/dot-config/AGENTS.md"

echo "[3/6] repo mcp-learning (sin target/, node_modules/, dist/, memory.db*)"
copy_tree "$WIN_HOME/.config/mcp-learning" "$STAGE/mcp-repo" \
  --exclude='./rust/target' \
  --exclude='./rust/target-check' \
  --exclude='./rust/target-*' \
  --exclude='./viewer/node_modules' \
  --exclude='./viewer/dist' \
  --exclude='./viewer/.angular' \
  --exclude='./viewer/src-tauri/target' \
  --exclude='./viewer/src-tauri/gen' \
  --exclude='./node_modules' \
  --exclude='./.git' \
  --exclude='./memory.db' \
  --exclude='./memory.db-shm' \
  --exclude='./memory.db-wal' \
  --exclude='./harness/state' \
  --exclude='./migration-bundle' \
  --exclude='./migration/stage'

echo "[4/6] BD del MCP memory (SQLite portable)"
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$WIN_HOME/.config/mcp-learning/memory.db" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null || true
else
  echo "  (sqlite3 no disponible: copio el .db como está — asegurate de no tener el MCP corriendo)"
fi
cp "$WIN_HOME/.config/mcp-learning/memory.db" "$STAGE/mcp-repo/memory.db"

echo "[5/6] ~/.claude (settings, CLAUDE.md, skills, auto-memory)"
cp "$WIN_HOME/.claude/settings.json" "$STAGE/dot-claude/settings.json"
cp "$WIN_HOME/.claude/CLAUDE.md" "$STAGE/dot-claude/CLAUDE.md"
copy_tree "$WIN_HOME/.claude/skills" "$STAGE/dot-claude/skills"
AUTOMEM_SRC="$WIN_HOME/.claude/projects/C--Users-Desarrollos--config-mcp-learning/memory"
copy_tree "$AUTOMEM_SRC" "$STAGE/auto-memory"

echo "[6/6] ~/.codex (AGENTS.md, config.toml)"
[ -f "$WIN_HOME/.codex/AGENTS.md" ] && cp "$WIN_HOME/.codex/AGENTS.md" "$STAGE/dot-codex/AGENTS.md"
[ -f "$WIN_HOME/.codex/config.toml" ] && cp "$WIN_HOME/.codex/config.toml" "$STAGE/dot-codex/config.toml"

cp "$(dirname "$0")/install-on-linux.sh" "$STAGE/install-on-linux.sh"
chmod +x "$STAGE/install-on-linux.sh"

echo "==> Empaquetando..."
tar -czf "$TARBALL" -C "$STAGE" .
SIZE=$(du -h "$TARBALL" | cut -f1)
echo ""
echo "OK -> $TARBALL ($SIZE)"
echo ""
echo "En Linux:"
echo "  mkdir -p ~/migration && tar -xzf $(basename "$TARBALL") -C ~/migration"
echo "  cd ~/migration && ./install-on-linux.sh"
