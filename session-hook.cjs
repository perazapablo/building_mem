'use strict';

var DB_PATH = 'C:/Users/Desarrollos/.config/mcp-learning/memory.db';
var MOD_PATH = 'C:/Users/Desarrollos/.config/mcp-learning/node_modules/better-sqlite3';

try {
  var Database = require(MOD_PATH);
  var db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  var rows = db.prepare('SELECT title, project_id, summary, created_at FROM sessions ORDER BY created_at DESC LIMIT 7').all();
  db.close();

  if (!rows || rows.length === 0) {
    process.exit(0);
  }

  var lines = ['=== SESIONES RECIENTES (MCP Memory) ==='];

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var date = '????-??-??';
    if (row.created_at) {
      date = row.created_at.slice(0, 10);
    }
    lines.push('[' + date + '] ' + row.title + ' — project_id: ' + row.project_id);
    if (row.summary) {
      var brief = row.summary.length > 120 ? row.summary.slice(0, 117) + '...' : row.summary;
      lines.push('  ' + brief);
    }
    lines.push('');
  }

  lines.push('Para detalle del proyecto: llamá get_project_context(project_id)');
  lines.push('===');

  console.log(JSON.stringify({ hookSpecificOutput: { additionalContext: lines.join('\n') } }));

} catch (err) {
  process.exit(0);
}
