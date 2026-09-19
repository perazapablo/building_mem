-- El focus vivía en una sola fila por sesión (`session_focus.session_id` es
-- PRIMARY KEY), así que cada `set_focus` pisaba al anterior. Una sesión de dos
-- horas que declaró focus nueve veces dejaba una línea: la última.
--
-- Eso alcanzaba para el gate — que sólo pregunta "¿esta sesión declaró algo?" —
-- pero borraba lo único que contesta "¿qué se fue haciendo acá?". Y como la
-- fila tampoco distingue proyecto, un focus de un proyecto pisaba el de otro
-- cuando la sesión tocaba los dos.
--
-- Esta tabla es append-only: una fila por cada `set_focus`, con su hora y su
-- proyecto. `session_focus` queda como está y sigue siendo la fila "actual"
-- que lee el gate; acá se guarda el recorrido.
CREATE TABLE IF NOT EXISTS session_focus_log (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  focus       TEXT NOT NULL,
  provisional INTEGER NOT NULL DEFAULT 0,
  set_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS session_focus_log_session_idx
  ON session_focus_log(session_id, set_at);

CREATE INDEX IF NOT EXISTS session_focus_log_project_idx
  ON session_focus_log(project_id, set_at);

-- Lo que ya existe en `session_focus` entra como primera entrada del log: es
-- el único focus que sobrevivió de cada sesión vieja, y perderlo al migrar
-- sería repetir el error que esta migración viene a arreglar.
INSERT INTO session_focus_log (id, session_id, project_id, focus, provisional, set_at)
SELECT
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-a' ||
  substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
  session_id, project_id, focus, provisional, updated_at
FROM session_focus
WHERE NOT EXISTS (
  SELECT 1 FROM session_focus_log l WHERE l.session_id = session_focus.session_id
);
