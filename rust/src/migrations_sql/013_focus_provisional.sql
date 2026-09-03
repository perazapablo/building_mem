-- Un focus puede ser DECLARADO (el agente llamó set_focus sabiendo qué está
-- haciendo) o PROVISIONAL (derivado automáticamente del prompt del usuario por
-- el hook de arranque del turno).
--
-- Por qué existe la distinción: el gate que exigía set_focus antes de tocar
-- código cobraba un turno entero por cada cambio chico. Derivarlo del prompt
-- elimina ese costo y además produce un focus más honesto — sale de las
-- palabras del usuario, no de la paráfrasis del modelo. Pero un focus
-- provisional no vale lo mismo que uno declarado a la hora de leer el
-- historial, así que la diferencia se guarda en vez de perderse.
--
-- 0 = declarado (default: todo lo que ya existía fue puesto a mano)
-- 1 = provisional (derivado del prompt; lo pisa cualquier set_focus explícito)
ALTER TABLE session_focus ADD COLUMN provisional INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS session_focus_provisional_idx
  ON session_focus(project_id, provisional, updated_at);
