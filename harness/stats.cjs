// SessionStats collector core. Agnostic to client.
// State lives in per-session JSON files under $MCP_HARNESS_STATE_DIR
// (default: <this file's dir>/state). Hooks call increment(); the consumer
// (MCP tool get_session_stats) calls readSnapshot() to enrich and return.

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { requiresFocus, checkFocus } = require('./focus-gate.cjs');
const { READ_ONLY_BASH } = require(
  path.join(os.homedir(), '.config/agent-rules/skills/action-gating/hooks/claude-pre-tool.cjs')
);

const STATE_DIR = process.env.MCP_HARNESS_STATE_DIR
  || path.join(__dirname, 'state');

function statePath(session_id) {
  if (!session_id || typeof session_id !== 'string') {
    throw new Error('session_id required');
  }
  const safe = session_id.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(STATE_DIR, `${safe}.json`);
}

function nowIso() { return new Date().toISOString(); }

function emptyState(session_id, project_id = null) {
  return {
    session_id,
    project_id,
    started_at: nowIso(),
    started_at_ms: Date.now(),
    last_update_at: nowIso(),
    turns: 0,
    commits: 0,
    files_edited: [],       // dedup array of absolute paths
    // Raíces git que la sesión tocó, por commit o por edición. Es lo que usan
    // session-end.cjs y stats_derivation.rs para contar commits al cerrar:
    // sin esto corrían `git log` en el directorio del proceso, que podía ser
    // otro repo o ninguno.
    repos: [],
    repo_dirs: {},          // cache dir → raíz git (o null), para no llamar a git en cada Edit
    bash_effects: 0,
    memory_writes: 0,
    code_entities_touched: 0,
    tool_errors: 0,
  };
}

function readState(session_id) {
  const p = statePath(session_id);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(session_id, obj) {
  const p = statePath(session_id);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  obj.last_update_at = nowIso();
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  return obj;
}

function initState(session_id, project_id = null) {
  const existing = readState(session_id);
  if (existing) {
    if (project_id && !existing.project_id) {
      existing.project_id = project_id;
      writeState(session_id, existing);
    }
    return existing;
  }
  return writeState(session_id, emptyState(session_id, project_id));
}

// `git commit`, también con opciones globales antes del subcomando
// (`git -C <repo> commit`, `git -c user.name=x commit`). Antes la regex exigía
// `git` pegado a `commit`, y los commits hechos con `-C` —la forma de commitear
// en otro repo sin moverse— no se contaban.
const GIT_COMMIT = /\bgit(?:\s+-[Cc]\s+(?:"[^"]+"|'[^']+'|\S+))*\s+commit\b/;

/**
 * El directorio donde corre un `git commit`: el de `git -C <dir>`, el del
 * último `cd <dir>` antes del commit, o el cwd del hook. Una sesión puede
 * commitear en varios repos desde una misma terminal, así que el cwd sólo no
 * alcanza.
 */
function dirDelCommit(cmd, cwd) {
  const base = cwd || process.cwd();
  const sinComillas = (s) => s.replace(/^['"]|['"]$/g, '');
  const expandir = (s) => (s.startsWith('~') ? path.join(os.homedir(), s.slice(1)) : s);

  const conC = /\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)/.exec(cmd);
  if (conC) return path.resolve(base, expandir(sinComillas(conC[1])));

  const idx = cmd.search(GIT_COMMIT);
  const antes = idx >= 0 ? cmd.slice(0, idx) : cmd;
  const cds = [...antes.matchAll(/(?:^|[;&|]\s*)cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)/g)];
  if (cds.length) return path.resolve(base, expandir(sinComillas(cds[cds.length - 1][1])));

  return base;
}

/** Raíz git de un directorio, o null si no está dentro de un repo. */
function repoDe(dir) {
  let d = dir;
  // Un archivo recién creado en una carpeta nueva: subir hasta algo que exista.
  while (d && !fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
  try {
    const out = execFileSync('git', ['-C', d, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

// classify a PostToolUse payload → list of mutations to apply to state.
// Returns array of { field, op, value? } — op ∈ {'inc', 'add_path', 'add_repo'}.
function classify(payload) {
  const tool = payload?.tool_name || '';
  const input = payload?.tool_input || {};
  const response = payload?.tool_response;
  const isError = response && (response.is_error === true
    || (typeof response === 'object' && response.error != null));

  const muts = [];
  if (isError) muts.push({ field: 'tool_errors', op: 'inc' });

  if (tool === 'Write' || tool === 'Edit' || tool === 'NotebookEdit') {
    const fp = input.file_path || input.notebook_path;
    if (fp) {
      muts.push({ field: 'files_edited', op: 'add_path', value: fp });
      muts.push({ field: 'repos', op: 'add_repo', value: path.dirname(fp) });
    }
    return muts;
  }

  if (tool === 'Bash') {
    const cmd = String(input.command || '').trim();
    if (!cmd) return muts;
    if (READ_ONLY_BASH.some((re) => re.test(cmd))) return muts;
    if (GIT_COMMIT.test(cmd)) {
      muts.push({ field: 'commits', op: 'inc' });
      muts.push({ field: 'repos', op: 'add_repo', value: dirDelCommit(cmd, payload?.cwd) });
    } else {
      muts.push({ field: 'bash_effects', op: 'inc' });
    }
    return muts;
  }

  if (tool.startsWith('mcp__memory__')) {
    if (tool === 'mcp__memory__add_code_entity' || tool === 'mcp__memory__update_code_entity') {
      muts.push({ field: 'code_entities_touched', op: 'inc' });
    }
    if (requiresFocus(tool)) {
      muts.push({ field: 'memory_writes', op: 'inc' });
    }
    return muts;
  }

  return muts;
}

function applyMutations(state, muts) {
  for (const m of muts) {
    if (m.op === 'inc') {
      state[m.field] = (state[m.field] || 0) + 1;
    } else if (m.op === 'add_path') {
      if (!Array.isArray(state[m.field])) state[m.field] = [];
      if (!state[m.field].includes(m.value)) state[m.field].push(m.value);
    } else if (m.op === 'add_repo') {
      if (!Array.isArray(state.repos)) state.repos = [];
      if (!state.repo_dirs || typeof state.repo_dirs !== 'object') state.repo_dirs = {};
      if (!(m.value in state.repo_dirs)) state.repo_dirs[m.value] = repoDe(m.value);
      const repo = state.repo_dirs[m.value];
      if (repo && !state.repos.includes(repo)) state.repos.push(repo);
    }
  }
  return state;
}

// Convenience: for a hook that received a PostToolUse payload.
function recordToolUse(session_id, payload) {
  const state = initState(session_id);
  const muts = classify(payload);
  if (!muts.length) return state;
  applyMutations(state, muts);
  return writeState(session_id, state);
}

function incrementTurns(session_id) {
  const state = initState(session_id);
  state.turns = (state.turns || 0) + 1;
  return writeState(session_id, state);
}

// Snapshot for the MCP tool consumer. Enriches with duration_min and
// last_focus (via focus-gate.checkFocus). project_id override: use passed
// arg if provided, else stored one, else null.
function readSnapshot(session_id, project_id_override = null) {
  const state = readState(session_id);
  if (!state) return null;
  const project_id = project_id_override || state.project_id || null;
  const startedMs = Number.isFinite(state.started_at_ms)
    ? state.started_at_ms
    : Date.parse(state.started_at);
  const duration_min = Number.isFinite(startedMs)
    ? Math.round((Date.now() - startedMs) / 60000)
    : null;

  let last_focus = null;
  if (project_id) {
    const f = checkFocus(project_id);
    if (f.has_focus) {
      last_focus = {
        focus: f.focus,
        set_at: f.set_at,
        updated_at: f.updated_at,
        session_id: f.session_id,
      };
    }
  }

  return {
    session_id: state.session_id,
    project_id,
    started_at: state.started_at,
    last_update_at: state.last_update_at,
    duration_min,
    turns: state.turns || 0,
    commits: state.commits || 0,
    files_edited: Array.isArray(state.files_edited) ? state.files_edited.length : 0,
    files_edited_paths: state.files_edited || [],
    bash_effects: state.bash_effects || 0,
    memory_writes: state.memory_writes || 0,
    code_entities_touched: state.code_entities_touched || 0,
    tool_errors: state.tool_errors || 0,
    last_focus,
  };
}

module.exports = {
  STATE_DIR,
  statePath,
  emptyState,
  readState,
  writeState,
  initState,
  classify,
  applyMutations,
  dirDelCommit,
  repoDe,
  recordToolUse,
  incrementTurns,
  readSnapshot,
};

// CLI: node stats.cjs <cmd> [args...]
//   init <session_id> [project_id]
//   record <session_id>            (reads PostToolUse payload from stdin)
//   turn <session_id>
//   snapshot <session_id> [project_id]
//   dump <session_id>
if (require.main === module) {
  const [cmd, sid, arg2] = process.argv.slice(2);
  const readStdinJson = () => new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (buf += c));
    process.stdin.on('end', () => {
      try { resolve(JSON.parse(buf || '{}')); } catch { resolve({}); }
    });
  });

  (async () => {
    if (!cmd) { console.error('usage: stats.cjs <init|record|turn|snapshot|dump> <session_id> [arg]'); process.exit(2); }
    if (!sid) { console.error('session_id required'); process.exit(2); }
    switch (cmd) {
      case 'init':     console.log(JSON.stringify(initState(sid, arg2 || null), null, 2)); break;
      case 'record':   console.log(JSON.stringify(recordToolUse(sid, await readStdinJson()), null, 2)); break;
      case 'turn':     console.log(JSON.stringify(incrementTurns(sid), null, 2)); break;
      case 'snapshot': console.log(JSON.stringify(readSnapshot(sid, arg2 || null), null, 2)); break;
      case 'dump':     console.log(JSON.stringify(readState(sid), null, 2)); break;
      default: console.error(`unknown cmd: ${cmd}`); process.exit(2);
    }
  })();
}
