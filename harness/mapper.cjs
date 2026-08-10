// CWD -> project_id resolver. Agnostic to client (Claude, opencode, ...).
// Reads project_paths from the MCP memory SQLite DB in readonly mode.
//
// Programmatic use:
//   const { resolveCwd } = require('.../harness/mapper.cjs');
//   const r = resolveCwd(process.cwd());
//
// CLI use:
//   node mapper.cjs                 # uses process.cwd()
//   node mapper.cjs --cwd <path>    # explicit
//   node mapper.cjs --pretty        # pretty-print output
//
// Output JSON shape:
//   { matched: bool, project_id?: string, project_name?: string,
//     cwd: string, path_key: string, db_path: string, message: string }

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DEFAULT_DB = process.env.MCP_MEMORY_DB_PATH
  || 'C:/Users/Desarrollos/.config/mcp-learning/memory.db';

function canonicalize(p) {
  return String(p ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function resolveCwd(cwd, dbPath = DEFAULT_DB) {
  const path_key = canonicalize(cwd);
  const out = { matched: false, cwd: String(cwd ?? ''), path_key, db_path: dbPath, message: '' };

  if (!path_key) {
    out.message = 'empty cwd';
    return out;
  }
  if (!fs.existsSync(dbPath)) {
    out.message = `DB not found at ${dbPath}. Set MCP_MEMORY_DB_PATH or start the MCP server once.`;
    return out;
  }

  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare(
      `SELECT pp.project_id, p.name AS project_name
         FROM project_paths pp
         JOIN projects p ON p.id = pp.project_id
        WHERE pp.path_key = ?`
    ).get(path_key);

    if (row) {
      out.matched = true;
      out.project_id = row.project_id;
      out.project_name = row.project_name;
      out.message = `resolved: ${row.project_name} (${row.project_id})`;
    } else {
      out.message =
        `CWD "${cwd}" is not registered in project_paths. ` +
        `Run mcp__memory__list_projects to find the right project, then ` +
        `mcp__memory__add_project_path({ project_id, path: "${cwd}" }) — or ` +
        `mcp__memory__upsert_project if this is a new project. ` +
        `Until mapped, memory writes have no scope anchor.`;
    }
  } catch (e) {
    out.message = `DB error: ${e.message}`;
  } finally {
    try { db && db.close(); } catch {}
  }
  return out;
}

function parseArgs(argv) {
  const args = { cwd: process.cwd(), pretty: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cwd') args.cwd = argv[++i];
    else if (a === '--pretty') args.pretty = true;
  }
  return args;
}

if (require.main === module) {
  const { cwd, pretty } = parseArgs(process.argv);
  const r = resolveCwd(cwd);
  process.stdout.write(pretty ? JSON.stringify(r, null, 2) + '\n' : JSON.stringify(r) + '\n');
  process.exit(0);
}

module.exports = { resolveCwd, canonicalize, DEFAULT_DB };
