#!/usr/bin/env node
// PostToolUse:Bash hook. If the executed command was a git commit,
// inject a reminder to record the decision/artifact in MCP memory NOW.

let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  let payload;
  try { payload = JSON.parse(raw || "{}"); } catch { payload = {}; }

  const command = payload?.tool_input?.command || "";
  const isGitCommit = /\bgit\s+commit\b/.test(command);

  if (!isGitCommit) {
    process.stdout.write("");
    return;
  }

  const additionalContext = `Commit detectado. Si esta sesión tomó una decisión técnica o produjo un artefacto durable:
- Llamar mcp__memory__add_decision o mcp__memory__add_artifact AHORA, con referencia al commit hash.
- Antes: search_* del topic para evitar duplicado. Si existe → update_*.
- No batchear al final de sesión.`;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext
    }
  }));
});
