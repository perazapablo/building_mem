// Mutation-gate core. Agnostic to client.
//
// Decides whether a tool call mutates the workspace (and therefore must be
// preceded by an explicit mcp__memory__set_focus for this session), and builds
// the deny message the adapter surfaces to the model.
//
// Programmatic:
//   const { isMutation, evaluate, denyMessage } = require('.../mutation-gate.cjs');
//
// Contract:
//   isMutation(tool_name, tool_input) -> bool
//
//   evaluate({ tool_name, tool_input, cwd, session_id }) ->
//     { gated: bool, reason?: string, project_id?: string }
//       gated=true  → the adapter must block and show `reason`
//       gated=false → let it through (not a mutation, unmapped cwd, no
//                     session_id, infra error, or focus already declared)
//
// Fail-open by design: anything the gate cannot decide with confidence lets
// the call through. A false block costs the user a turn; a false pass only
// costs traceability on one session.

const path = require('node:path');
const os = require('node:os');
const { checkFocusForSession } = require('./focus-gate.cjs');
const { resolveCwd } = require('./mapper.cjs');
const { isReadOnlyBash } = require(
  path.join(os.homedir(), '.config/agent-rules/skills/action-gating/hooks/claude-pre-tool.cjs')
);

// Tool names are normalised by the adapter before reaching here (opencode's
// lowercase `bash`/`edit`/`write` → Claude's `Bash`/`Edit`/`Write`).
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'BashOutput']);

function isMutation(tool_name, tool_input) {
  if (WRITE_TOOLS.has(tool_name)) return true;
  if (tool_name === 'Bash') {
    const cmd = String(tool_input?.command || '').trim();
    if (!cmd) return false;
    if (isReadOnlyBash(cmd)) return false;
    return true;
  }
  return false;
}

function denyMessage({ session_id, project_id, tool_name, tool_input }) {
  const cmd = tool_name === 'Bash'
    ? ` (\`${String(tool_input?.command || '').slice(0, 80)}\`)`
    : '';
  return `[harness] BLOQUEO: esta sesión (${String(session_id).slice(0, 8)}) aún no declaró focus en el MCP memory. ` +
    `Antes de modificar código, llamá mcp__memory__set_focus({ session_id: "${session_id}", project_id: "${project_id}", focus: "<qué estás haciendo AHORA en 1 línea>" }). ` +
    `Esto es obligatorio para que el trabajo de esta sesión quede trazable. ` +
    `Tool bloqueada: ${tool_name}${cmd}.`;
}

function evaluate({ tool_name, tool_input, cwd, session_id }) {
  if (!isMutation(tool_name, tool_input)) return { gated: false };

  const r = resolveCwd(cwd || process.cwd());
  if (!r.matched) return { gated: false };   // no project scope to anchor focus to
  if (!session_id) return { gated: false };  // fail-open

  const f = checkFocusForSession(r.project_id, session_id);
  if (f.error) return { gated: false };      // fail-open on infra errors
  if (f.has_focus) return { gated: false };

  return {
    gated: true,
    project_id: r.project_id,
    reason: denyMessage({ session_id, project_id: r.project_id, tool_name, tool_input }),
  };
}

module.exports = { isMutation, evaluate, denyMessage, WRITE_TOOLS, SHELL_TOOLS };
