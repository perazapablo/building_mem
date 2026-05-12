'use strict';

let raw = '';
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw || '{}');
    const tool = input.tool_name || '';
    const params = input.tool_input || {};
    const cmd = (params.command || '').toString();

    if (tool !== 'Bash') { process.exit(0); }
    if (!/\bgit\s+commit\b/.test(cmd)) { process.exit(0); }

    const result = (input.tool_response && (input.tool_response.stdout || input.tool_response.output)) || '';
    const errored = input.tool_response && input.tool_response.is_error;
    if (errored) { process.exit(0); }

    const reminder = [
      '=== COMMIT DETECTADO — actualizar MCP memoria ahora ===',
      'Triggers obligatorios, en este orden:',
      '1. mark_obsolete sobre notes/decisions invalidadas por este commit',
      '   (reason="fixed in commit <hash>" o equivalente concreto).',
      '2. add_note con el cambio aplicado: path + qué cambió, una línea atómica.',
      '3. add_decision si el commit refleja una decisión técnica nueva.',
      '4. update_session con el summary actualizado de la sesión activa.',
      '',
      'Si no aplica alguno de los pasos, dejarlo explícito antes de seguir.',
      '======================================================='
    ].join('\n');

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { additionalContext: reminder }
    }));
  } catch (_e) {
    process.exit(0);
  }
});
