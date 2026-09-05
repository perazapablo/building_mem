#!/usr/bin/env node
// Mergea la config portable exportada desde Windows dentro del ~/.claude.json
// del destino, sin pisar el estado de auth/onboarding que ya vive ahi.
//
//   node merge-claude-json.cjs <claude.json.portable> <destino/.claude.json>

const fs = require('fs');
const os = require('os');

const HOME = os.homedir();
const [portablePath, targetPath] = process.argv.slice(2);

if (!portablePath || !targetPath) {
  console.error('uso: merge-claude-json.cjs <portable> <target>');
  process.exit(1);
}

const toLinux = (s) =>
  s
    .replace(/C:[\\/]{1,2}Users[\\/]{1,2}Desarrollos/gi, HOME)
    .replace(/\/c\/Users\/Desarrollos/gi, HOME)
    .replace(/\\\\/g, '/')
    .replace(/\\/g, '/')
    .replace(/mcp-memory\.exe/g, 'mcp-memory');

const deep = (v) =>
  typeof v === 'string'
    ? toLinux(v)
    : Array.isArray(v)
      ? v.map(deep)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)]))
        : v;

const src = deep(JSON.parse(fs.readFileSync(portablePath, 'utf8')));

let dst = {};
try {
  dst = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
} catch {
  // No existe o esta corrupto: arrancamos de cero, el login lo repuebla.
}

dst.mcpServers = { ...(dst.mcpServers || {}), ...(src.mcpServers || {}) };
dst.projects = dst.projects || {};

let merged = 0;
let skipped = 0;
for (const [path, cfg] of Object.entries(src.projects || {})) {
  // Solo proyectos cuyo path existe en Linux; el resto es ruido de Windows.
  if (!fs.existsSync(path)) {
    skipped++;
    continue;
  }
  dst.projects[path] = { ...(dst.projects[path] || {}), ...cfg };
  merged++;
}

fs.writeFileSync(targetPath, JSON.stringify(dst, null, 2));

console.log('   mcpServers: ' + Object.keys(dst.mcpServers).join(', '));
console.log('   proyectos mergeados: ' + merged + ' (omitidos por path inexistente: ' + skipped + ')');
