//! Per-session focus. Decoupled from `working_state` so callers can update
//! it atomically without touching pinned ids or (legacy) thread strings.

use anyhow::Result;
use rusqlite::{params, OptionalExtension};
use serde::Serialize;

use super::Db;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SessionFocus {
    pub session_id: String,
    pub project_id: String,
    pub focus: String,
    pub set_at: String,
    pub updated_at: String,
    /// true = derivado automáticamente del prompt del usuario por el hook de
    /// arranque de turno; false = el agente lo declaró con set_focus.
    ///
    /// La distinción existe porque el focus automático eliminó el gate que
    /// cobraba un turno por cada cambio chico, pero un focus derivado no vale
    /// lo mismo que uno declarado al leer el historial: guardar cuál es cuál
    /// mantiene esa diferencia visible en vez de fingir que no existe.
    pub provisional: bool,
}

pub fn set(db: &Db, session_id: &str, project_id: &str, focus: &str) -> Result<SessionFocus> {
    let focus = focus.trim();
    if focus.is_empty() {
        anyhow::bail!("focus is empty");
    }
    db.with(|conn| {
        // provisional = 0 siempre: este es el camino explícito. Un set_focus
        // del agente asciende un focus provisional a declarado.
        conn.execute(
            "INSERT INTO session_focus (session_id, project_id, focus, provisional)
             VALUES (?, ?, ?, 0)
             ON CONFLICT(session_id) DO UPDATE SET
               focus       = excluded.focus,
               project_id  = excluded.project_id,
               provisional = 0,
               updated_at  = datetime('now')",
            params![session_id, project_id, focus],
        )?;
        Ok(())
    })?;
    get(db, session_id)?.ok_or_else(|| anyhow::anyhow!("row disappeared after upsert"))
}

pub fn get(db: &Db, session_id: &str) -> Result<Option<SessionFocus>> {
    db.with(|conn| {
        let row = conn
            .query_row(
                "SELECT session_id, project_id, focus, set_at, updated_at, provisional
                 FROM session_focus WHERE session_id = ?",
                params![session_id],
                |r| {
                    Ok(SessionFocus {
                        session_id: r.get(0)?,
                        project_id: r.get(1)?,
                        focus: r.get(2)?,
                        set_at: r.get(3)?,
                        updated_at: r.get(4)?,
                        provisional: r.get(5)?,
                    })
                },
            )
            .optional()?;
        Ok(row)
    })
}

pub fn get_latest_for_project(db: &Db, project_id: &str) -> Result<Option<SessionFocus>> {
    db.with(|conn| {
        let row = conn
            .query_row(
                "SELECT session_id, project_id, focus, set_at, updated_at, provisional
                 FROM session_focus
                 WHERE project_id = ?
                 ORDER BY updated_at DESC
                 LIMIT 1",
                params![project_id],
                |r| {
                    Ok(SessionFocus {
                        session_id: r.get(0)?,
                        project_id: r.get(1)?,
                        focus: r.get(2)?,
                        set_at: r.get(3)?,
                        updated_at: r.get(4)?,
                        provisional: r.get(5)?,
                    })
                },
            )
            .optional()?;
        Ok(row)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> Db {
        Db::new_in_memory().unwrap()
    }

    #[test]
    fn set_and_get_roundtrip() {
        let db = fresh();
        set(&db, "s1", "p1", "impl X").unwrap();
        let f = get(&db, "s1").unwrap().unwrap();
        assert_eq!(f.focus, "impl X");
        assert_eq!(f.project_id, "p1");
    }

    #[test]
    fn set_empty_focus_errors() {
        let db = fresh();
        assert!(set(&db, "s1", "p1", "   ").is_err());
    }

    #[test]
    fn set_upserts_same_session() {
        let db = fresh();
        set(&db, "s1", "p1", "first").unwrap();
        set(&db, "s1", "p1", "second").unwrap();
        let f = get(&db, "s1").unwrap().unwrap();
        assert_eq!(f.focus, "second");
    }

    #[test]
    fn latest_for_project_returns_most_recent() {
        let db = fresh();
        set(&db, "s1", "p1", "a").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        set(&db, "s2", "p1", "b").unwrap();
        let latest = get_latest_for_project(&db, "p1").unwrap().unwrap();
        assert_eq!(latest.session_id, "s2");
        assert_eq!(latest.focus, "b");
    }

    #[test]
    fn set_marca_declarado() {
        let db = fresh();
        let f = set(&db, "s1", "p1", "impl X").unwrap();
        assert!(!f.provisional, "un set_focus explícito nunca es provisional");
    }

    #[test]
    fn set_asciende_un_focus_provisional() {
        // El hook deja un focus derivado del prompt; el agente después declara
        // el suyo. El explícito gana y deja de ser provisional.
        let db = fresh();
        db.with(|conn| {
            conn.execute(
                "INSERT INTO session_focus (session_id, project_id, focus, provisional)
                 VALUES ('s1', 'p1', 'del prompt', 1)",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        assert!(get(&db, "s1").unwrap().unwrap().provisional);

        let f = set(&db, "s1", "p1", "declarado a mano").unwrap();
        assert!(!f.provisional);
        assert_eq!(f.focus, "declarado a mano");
    }

    #[test]
    fn get_missing_returns_none() {
        let db = fresh();
        assert!(get(&db, "nope").unwrap().is_none());
        assert!(get_latest_for_project(&db, "nope").unwrap().is_none());
    }
}
