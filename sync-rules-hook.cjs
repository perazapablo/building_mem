#!/usr/bin/env node
// PostToolUse hook (matcher Write|Edit).
// Si la herramienta tocó RULES.md, copia el canon a ~/.codex/AGENTS.md.
//
// Claude Code y opencode leen RULES.md por referencia (@import); Codex no
// soporta imports, así que necesita una copia literal.
//
// Antes esto delegaba en `pwsh -File sync-rules.ps1`, cuyo cuerpo entero era un
// Copy-Item. Eso ataba el hook a PowerShell — que en Linux no está garantizado —
// y a una ruta absoluta de esta máquina. La copia se hace acá, en el node que ya
// está corriendo: un proceso menos, un archivo menos, y corre en cualquier SO.

const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME = os.homedir();
const CANON = path.join(HOME, ".config", "agent-rules", "RULES.md");
const TARGET = path.join(HOME, ".codex", "AGENTS.md");

// Comparación de rutas: separadores unificados, y case-insensitive SOLO en
// Windows. En Linux `RULES.md` y `rules.md` son archivos distintos y colapsar
// mayúsculas dispararía el sync sobre el archivo equivocado.
const norm = (p) => {
  const unified = String(p).split("\\").join("/");
  return process.platform === "win32" ? unified.toLowerCase() : unified;
};

const emit = (msg) => {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: msg,
    },
  }));
};

let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  let payload;
  try { payload = JSON.parse(raw || "{}"); } catch { payload = {}; }

  const filePath = (payload?.tool_input?.file_path || "").toString();
  if (norm(filePath) !== norm(CANON)) {
    process.stdout.write("");
    return;
  }

  try {
    if (!fs.existsSync(CANON)) {
      emit(`RULES.md sync FALLÓ: no existe el canon ${CANON}`);
      return;
    }
    fs.mkdirSync(path.dirname(TARGET), { recursive: true });
    fs.copyFileSync(CANON, TARGET);
    emit(`RULES.md editado → AGENTS.md sincronizado (Codex). ${CANON} -> ${TARGET}`);
  } catch (err) {
    emit(`RULES.md sync FALLÓ: ${err.message}`);
  }
});
