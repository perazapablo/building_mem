#!/usr/bin/env bash
# Corre en Linux. Restaura config con paths reescritos a $HOME.
set -euo pipefail

STAGE="$(cd "$(dirname "$0")" && pwd)"
WIN_USER_PATH_UNIX="/c/Users/Desarrollos"
WIN_USER_PATH_WIN='C:\\Users\\Desarrollos'
WIN_USER_PATH_WIN_FS='C:/Users/Desarrollos'

# Auto-memory dir: Claude Code deriva el nombre del CWD.
# En Windows: C--Users-Desarrollos--config-mcp-learning
# En Linux:   -home-<user>--config-mcp-learning (dashes reemplazan slashes).
LINUX_USER="$(id -un)"

echo ">> Instalando en \$HOME=$HOME  (usuario: $LINUX_USER)"
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
  sed -i "s|${WIN_USER_PATH_UNIX}|${HOME}|g" "$f" 2>/dev/null || true
  # Backslashes internos que sobrevivan (paths de hooks .cjs): \\ -> /
  # Solo dentro de lineas que ya mencionan $HOME para no romper otros escapes.
  sed -i "\|${HOME}|s|\\\\\\\\|/|g" "$f" 2>/dev/null || true
  sed -i "\|${HOME}|s|\\\\|/|g" "$f" 2>/dev/null || true
  # Binario Windows -> Linux: cargo build en Linux no produce .exe.
  sed -i 's|mcp-memory\.exe|mcp-memory|g' "$f" 2>/dev/null || true
}

rewrite_dir() {
  local dir="$1"
  # Solo archivos de texto conocidos.
  find "$dir" -type f \( \
       -name '*.json' -o -name '*.md' -o -name '*.toml' \
    -o -name '*.cjs' -o -name '*.mjs' -o -name '*.js' -o -name '*.ts' \
    -o -name '*.sh' -o -name '*.ps1' -o -name '*.yml' -o -name '*.yaml' \
  \) -print0 | while IFS= read -r -d '' f; do
    if grep -q -e "$WIN_USER_PATH_WIN_FS" -e "$WIN_USER_PATH_UNIX" \
               -e 'C:\\\\Users\\\\Desarrollos' -e 'mcp-memory\.exe' "$f" 2>/dev/null; then
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

echo "[1/7] ~/.config/agent-rules"
install_tree "$STAGE/dot-config/agent-rules" "$HOME/.config/agent-rules"

echo "[2/7] ~/.config/opencode"
install_tree "$STAGE/dot-config/opencode" "$HOME/.config/opencode"
install_file "$STAGE/dot-config/AGENTS.md" "$HOME/.config/AGENTS.md"

echo "[3/7] ~/.config/mcp-learning (repo + memory.db)"
install_tree "$STAGE/mcp-repo" "$HOME/.config/mcp-learning"

echo "[4/7] ~/.claude (settings, CLAUDE.md, skills, agents)"
install_file "$STAGE/dot-claude/settings.json" "$HOME/.claude/settings.json"
install_file "$STAGE/dot-claude/CLAUDE.md" "$HOME/.claude/CLAUDE.md"
install_tree "$STAGE/dot-claude/skills" "$HOME/.claude/skills"
install_tree "$STAGE/dot-claude/agents" "$HOME/.claude/agents"

echo "[5/7] merge de ~/.claude.json (mcpServers + config de proyectos)"
# NO se sobrescribe: el .claude.json del destino tiene su propio estado de
# auth/onboarding. Solo se mergean mcpServers y la config por proyecto,
# con las rutas Windows traducidas a $HOME.
PORTABLE="$STAGE/dot-claude/claude.json.portable"
if [ -f "$PORTABLE" ] && command -v node >/dev/null 2>&1; then
  [ -f "$HOME/.claude.json" ] && cp "$HOME/.claude.json" "$HOME/.claude.json.premerge"
  node "$STAGE/merge-claude-json.cjs" "$PORTABLE" "$HOME/.claude.json"
else
  echo "   (skip: falta claude.json.portable o node)"
fi

echo "[6/7] auto-memory -> ~/.claude/projects/*/memory/"
# Traduccion del nombre de directorio: Claude Code lo deriva del CWD
# reemplazando separadores por guiones. C--Users-Desarrollos-X -> -home-<user>-X
if [ -d "$STAGE/auto-memory" ]; then
  for src in "$STAGE"/auto-memory/*; do
    [ -d "$src" ] || continue
    win_name="$(basename "$src")"
    case "$win_name" in
      C--Users-Desarrollos*)
        linux_name="-home-${LINUX_USER}${win_name#C--Users-Desarrollos}"
        ;;
      *)
        # Path fuera del home de Windows (otro usuario/disco): sin equivalente
        # automatico. Se preserva con el nombre original.
        linux_name="$win_name"
        echo "   (sin equivalente Linux, se preserva tal cual: $win_name)"
        ;;
    esac
    echo "   $win_name -> $linux_name"
    install_tree "$src" "$HOME/.claude/projects/$linux_name/memory"
  done
fi

echo "[7/7] ~/.codex"
install_file "$STAGE/dot-codex/AGENTS.md" "$HOME/.codex/AGENTS.md"
install_file "$STAGE/dot-codex/config.toml" "$HOME/.codex/config.toml"

echo ""
echo "== Instalacion base OK =="
echo ""
echo "Pasos manuales pendientes:"
echo ""
echo "1) Build del MCP Rust:"
echo "     cd ~/.config/mcp-learning/rust && cargo build --release"
echo "   Verifica que produce: rust/target/release/mcp-memory (sin .exe)"
echo ""
echo "2) Build del viewer Tauri (regenera iconos Linux):"
echo "     cd ~/.config/mcp-learning/viewer && npm install && npm run tauri build"
echo ""
echo "3) Login de Claude Code (las credenciales NO se migran):"
echo "     claude   # y segui el flujo de auth"
echo ""
echo "4) Verificar rutas del MCP:"
echo "     grep -n 'mcp-memory' ~/.claude/settings.json ~/.claude.json"
echo ""
echo "5) Verificar que no quedaron rutas Windows:"
echo "     grep -rn 'C:' ~/.claude/settings.json ~/.config/agent-rules/ || echo limpio"
echo ""
echo "6) Probar desde ~/.config/mcp-learning que list_projects abre la BD."
echo ""
echo "7) Rollback: los archivos previos quedaron como <archivo>.bak.<epoch>"
echo "   y ~/.claude.json.premerge para el merge de claude.json."
