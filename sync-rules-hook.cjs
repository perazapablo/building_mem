#!/usr/bin/env node
// PostToolUse hook (matcher Write|Edit).
// Si la herramienta tocó RULES.md, dispara sync-rules.ps1 para copiar el canon a ~/.codex/AGENTS.md.

const { execFile } = require("child_process");
const path = require("path");

let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  let payload;
  try { payload = JSON.parse(raw || "{}"); } catch { payload = {}; }

  const filePath = (payload?.tool_input?.file_path || "").toString();
  const canonPath = "C:\\Users\\Desarrollos\\.config\\agent-rules\\RULES.md";

  // Comparar normalizado (Windows: paths case-insensitive, mix de barras).
  const norm = (p) => p.replace(/\//g, "\\").toLowerCase();
  if (norm(filePath) !== norm(canonPath)) {
    process.stdout.write("");
    return;
  }

  execFile(
    "pwsh",
    ["-NoProfile", "-File", "C:\\Users\\Desarrollos\\.config\\agent-rules\\sync-rules.ps1"],
    { timeout: 5000 },
    (err, stdout, stderr) => {
      const msg = err
        ? `RULES.md sync FALLÓ: ${err.message}${stderr ? `\n${stderr}` : ""}`
        : `RULES.md editado → AGENTS.md sincronizado (Codex). ${stdout.trim()}`;
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: msg
        }
      }));
    }
  );
});
