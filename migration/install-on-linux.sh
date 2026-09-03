#!/usr/bin/env bash
# Corre en Linux. Restaura config con paths reescritos a $HOME.
set -euo pipefail

STAGE="$(cd "$(dirname "$0")" && pwd)"
WIN_USER_PATH_UNIX="/c/Users/Desarrollos"
WIN_USER_PATH_WIN='C:\\Users\\Desarrollos'
WIN_USER_PATH_WIN_FS='C:/Users/Desarrollos'

# Auto-memory dir: Claude Code deriva el nombre del CWD.
# En Windows era C--Users-Desarrollos--config-mcp-learning
# En Linux será -home-<user>--config-mcp-learning (dashes reemplazan slashes).
LINUX_USER="$(id -un)"
NEW_AUTOMEM_DIRNAME="-home-${LINUX_USER}--config-mcp-learning"

echo ">> Instalando en \$HOME=$HOME  (usuario: $LINUX_USER)"
echo ">> Auto-memory se instalará como: ~/.claude/projects/$NEW_AUTOMEM_DIRNAME/memory/"
read -rp "Continuar? [y/N] " ans
[[ "$ans" =~ ^[Yy]$ ]] || { echo "Abortado."; exit 1; }

backup_if_exists() {
  local p="$1"
  if [ -e "$p" ]; then
    local bkp="${p}.bak.$(date +%s)"
    echo "   backup: $p -> $bkp"
    mv "$p" "$bkp"
  fi
}

rewrite_paths_inplace() {
  # $1 = archivo. Reescribe rutas Windows -> Linux.
  local f="$1"
  # Backslashes escapados (JSON): C:\\Users\\Desarrollos -> /home/user
  sed -i "s|${WIN_USER_PATH_WIN}|${HOME}|g" "$f" 2>/dev/null || true
  # Forward-slash (Bash/Windows mixto): C:/Users/Desarrollos -> /home/user
  sed -i "s|${WIN_USER_PATH_WIN_FS}|${HOME}|g" "$f" 2>/dev/null || true
  # Git Bash style: /c/Users/Desarrollos -> /home/user
  sed -i "s|${WIN_USER_PATH_WIN_FS//\//\\/}|${HOME//\//\\/}|g" "$f" 2>/dev/null || true
  sed -i "s|${WIN_USER_PATH_UNIX}|${HOME}|g" "$f" 2>/dev/null || true
  # Backslashes internos que sobrevivan (paths de hooks .cjs): \\ -> /
  # Solo dentro de líneas que ya mencionan $HOME para no romper otros escapes.
  sed -i "\|${HOME}|s|\\\\\\\\|/|g" "$f" 2>/dev/null || true
  sed -i "\|${HOME}|s|\\\\|/|g" "$f" 2>/dev/null || true
}

rewrite_dir() {
  local dir="$1"
  # Solo archivos de texto conocidos.
  find "$dir" -type f \( \
       -name '*.json' -o -name '*.md' -o -name '*.toml' \
    -o -name '*.cjs' -o -name '*.mjs' -o -name '*.js' -o -name '*.ts' \
    -o -name '*.sh' -o -name '*.ps1' -o -name '*.yml' -o -name '*.yaml' \
  \) -print0 | while IFS= read -r -d '' f; do
    if grep -q -e "$WIN_USER_PATH_WIN_FS" -e "$WIN_USER_PATH_UNIX" -e 'C:\\\\Users\\\\Desarrollos' "$f" 2>/dev/null; then
      rewrite_paths_inplace "$f"
    fi
  done
}

install_tree() {
  local src="$1" dst="$2"
  [ -d "$src" ] || return 0
  backup_if_exists "$dst"
  mkdir -p "$(dirname "$dst")"
  cp -a "$src" "$dst"
  rewrite_dir "$dst"
}

install_file() {
  local src="$1" dst="$2"
  [ -f "$src" ] || return 0
  backup_if_exists "$dst"
  mkdir -p "$(dirname "$dst")"
  cp -a "$src" "$dst"
  rewrite_paths_inplace "$dst"
}

echo "[1/6] ~/.config/agent-rules"
install_tree "$STAGE/dot-config/agent-rules" "$HOME/.config/agent-rules"

echo "[2/6] ~/.config/opencode"
install_tree "$STAGE/dot-config/opencode" "$HOME/.config/opencode"
install_file "$STAGE/dot-config/AGENTS.md" "$HOME/.config/AGENTS.md"

echo "[3/6] ~/.config/mcp-learning (repo + memory.db)"
install_tree "$STAGE/mcp-repo" "$HOME/.config/mcp-learning"

echo "[4/6] ~/.claude (settings, CLAUDE.md, skills)"
install_file "$STAGE/dot-claude/settings.json" "$HOME/.claude/settings.json"
install_file "$STAGE/dot-claude/CLAUDE.md" "$HOME/.claude/CLAUDE.md"
install_tree "$STAGE/dot-claude/skills" "$HOME/.claude/skills"

echo "[5/6] auto-memory -> ~/.claude/projects/$NEW_AUTOMEM_DIRNAME/memory/"
install_tree "$STAGE/auto-memory" "$HOME/.claude/projects/$NEW_AUTOMEM_DIRNAME/memory"

echo "[6/6] ~/.codex"
install_file "$STAGE/dot-codex/AGENTS.md" "$HOME/.codex/AGENTS.md"
install_file "$STAGE/dot-codex/config.toml" "$HOME/.codex/config.toml"

echo ""
echo "== Instalación base OK =="
echo ""
echo "Pasos manuales pendientes:"
echo ""
echo "1) Build del MCP Rust:"
echo "     cd ~/.config/mcp-learning/rust && cargo build --release"
echo ""
echo "2) Build del viewer Tauri (regenera iconos Linux):"
echo "     cd ~/.config/mcp-learning/viewer && npm install && npm run tauri build"
echo ""
echo "3) Verificar settings.json de Claude — la ruta al binario del MCP en"
echo "   ~/.claude/settings.json debe apuntar a:"
echo "     ~/.config/mcp-learning/rust/target/release/mcp-memory"
echo ""
echo "4) Verificar hooks .cjs en agent-rules/skills/*/hooks/ — los shebangs"
echo "   y rutas de node deben ser válidos en Linux (node ya en PATH)."
echo ""
echo "5) Probar Claude Code y opencode desde ~/.config/mcp-learning para"
echo "   confirmar que el project_id se resuelve OK (verifica que la BD"
echo "   memory.db se abre y list_projects devuelve el proyecto mcp_memory)."
echo ""
echo "6) Revisar backups .bak.* si algo quedó raro y necesitás rollback."
