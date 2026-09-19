//! Todo lo que dejó una sesión, junto: el relato ya vive en `sessions.summary`,
//! esto trae lo demás.
//!
//! Hay dos formas de atar algo a una sesión, y no valen lo mismo:
//!
//! - **Declarado**: `decision_records.session_id` y `project_threads.opened_in /
//!   closed_in` dicen explícitamente de qué sesión salieron.
//! - **Deducido por tiempo**: notas y artefactos no tienen ninguna columna que
//!   los ate a una sesión, así que sólo se pueden buscar por su `created_at`
//!   dentro de la ventana. Con sesiones largas o solapadas eso arrastra cosas
//!   de otra sesión, por eso el payload dice cuál es la ventana y el cliente lo
//!   muestra como deducido, no como hecho.

use anyhow::Result;
use rusqlite::{params, OptionalExtension};
use serde::Serialize;

use super::artifacts::ArtifactRow;
use super::decision_records::{self, DecisionRecordRow};
use super::notes::NoteRow;
use super::project_threads::ProjectThread;
use super::session_focus::{self, FocusEntry};
use super::{parse_json_array, Db};

#[derive(Debug, Clone, Serialize, Default)]
pub struct SessionBundle {
    pub session_id: String,
    pub project_id: Option<String>,
    /// Ventana usada para lo deducido. `desde` sale de `fin - duration_min`.
    pub desde: Option<String>,
    pub hasta: Option<String>,
    /// Falso cuando la sesión no tiene duración medida: ahí no hay ventana y
    /// notas y artefactos no se pueden deducir sin inventar.
    pub ventana_confiable: bool,

    pub decisiones: Vec<DecisionRecordRow>,
    pub hilos: Vec<ProjectThread>,
    pub notas: Vec<NoteRow>,
    pub artefactos: Vec<ArtifactRow>,
    pub focus: Vec<FocusEntry>,
}

/// "2026-09-11 17:36:38" menos N minutos, en el mismo formato de SQLite.
fn restar_minutos(conn: &rusqlite::Connection, fin: &str, minutos: i64) -> Option<String> {
    conn.query_row(
        "SELECT datetime(?, ?)",
        params![fin, format!("-{minutos} minutes")],
        |r| r.get::<_, String>(0),
    )
    .ok()
}

pub fn for_session(db: &Db, session_id: &str) -> Result<SessionBundle> {
    let mut b = SessionBundle { session_id: session_id.to_string(), ..Default::default() };

    let (project_id, hasta, duracion) = db.with(|conn| {
        let fila = conn
            .query_row(
                "SELECT project_id, COALESCE(updated_at, created_at), summary
                   FROM sessions WHERE id = ?",
                params![session_id],
                |r| {
                    Ok((
                        r.get::<_, Option<String>>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .optional()?;
        let Some((pid, fin, summary)) = fila else {
            return Ok((None, None, 0_i64));
        };
        let duracion = summary
            .as_deref()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
            .and_then(|v| v.get("stats")?.get("duration_min")?.as_i64())
            .unwrap_or(0);
        Ok((pid, Some(fin), duracion))
    })?;

    b.project_id = project_id.clone();
    b.hasta = hasta.clone();
    b.ventana_confiable = duracion > 0;
    if let (Some(fin), true) = (hasta.as_deref(), duracion > 0) {
        b.desde = db.with(|conn| Ok(restar_minutos(conn, fin, duracion)))?;
    }

    // --- declarado: sale con nombre y apellido de la propia fila ---

    let ids: Vec<String> = db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id FROM decision_records
              WHERE session_id = ? ORDER BY created_at ASC",
        )?;
        let v = stmt
            .query_map(params![session_id], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(v)
    })?;
    for id in ids {
        if let Some(d) = decision_records::get(db, &id)? {
            b.decisiones.push(d);
        }
    }

    b.hilos = db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, project_id, thread, status, opened_in, closed_in,
                    close_reason, created_at, updated_at, closed_at
               FROM project_threads
              WHERE opened_in = ?1 OR closed_in = ?1
              ORDER BY created_at ASC",
        )?;
        let v = stmt
            .query_map(params![session_id], |r| {
                Ok(ProjectThread {
                    id: r.get(0)?,
                    project_id: r.get(1)?,
                    thread: r.get(2)?,
                    status: r.get(3)?,
                    opened_in: r.get(4)?,
                    closed_in: r.get(5)?,
                    close_reason: r.get(6)?,
                    created_at: r.get(7)?,
                    updated_at: r.get(8)?,
                    closed_at: r.get(9)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(v)
    })?;

    b.focus = session_focus::history(db, session_id)?;

    // --- deducido: sólo si hay ventana y proyecto ---

    let (Some(pid), Some(desde), Some(hasta)) = (project_id, b.desde.clone(), b.hasta.clone())
    else {
        return Ok(b);
    };

    b.notas = db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, project_id, content, tags, topic_key, revision_count, status,
                    importance, obsolete_reason, token_count, tokenizer_model, content_hash,
                    created_at, updated_at
               FROM notes
              WHERE project_id = ? AND created_at BETWEEN ? AND ?
              ORDER BY created_at ASC",
        )?;
        let v = stmt
            .query_map(params![pid, desde, hasta], |r| {
                Ok(NoteRow {
                    id: r.get(0)?,
                    project_id: r.get(1)?,
                    content: r.get(2)?,
                    tags: parse_json_array(&r.get::<_, String>(3)?),
                    topic_key: r.get(4)?,
                    revision_count: r.get(5)?,
                    status: r.get(6)?,
                    importance: r.get(7)?,
                    obsolete_reason: r.get(8)?,
                    token_count: r.get(9)?,
                    tokenizer_model: r.get(10)?,
                    content_hash: r.get(11)?,
                    created_at: r.get(12)?,
                    updated_at: r.get(13)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(v)
    })?;

    b.artefactos = db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, project_id, type, content, topic_key, revision_count, status,
                    importance, obsolete_reason, token_count, tokenizer_model, content_hash,
                    created_at, updated_at
               FROM artifacts
              WHERE project_id = ? AND created_at BETWEEN ? AND ?
              ORDER BY created_at ASC",
        )?;
        let v = stmt
            .query_map(params![pid, desde, hasta], |r| {
                Ok(ArtifactRow {
                    id: r.get(0)?,
                    project_id: r.get(1)?,
                    artifact_type: r.get(2)?,
                    content: r.get(3)?,
                    topic_key: r.get(4)?,
                    revision_count: r.get(5)?,
                    status: r.get(6)?,
                    importance: r.get(7)?,
                    obsolete_reason: r.get(8)?,
                    token_count: r.get(9)?,
                    tokenizer_model: r.get(10)?,
                    content_hash: r.get(11)?,
                    created_at: r.get(12)?,
                    updated_at: r.get(13)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(v)
    })?;

    Ok(b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repo::{notes, project_threads, projects, sessions};
    use crate::summary::{SessionStats, SessionSummary};

    fn sesion_de(db: &Db, sid: &str, pid: &str, minutos: i64) {
        let s = SessionSummary {
            goal: "trabajo".into(),
            stats: Some(SessionStats { duration_min: minutos, ..Default::default() }),
            ..Default::default()
        };
        sessions::update_checkpoint(db, sid, pid, Some(&s)).unwrap();
    }

    #[test]
    fn trae_los_hilos_que_la_sesion_abrio() {
        let db = Db::new_in_memory().unwrap();
        let p = projects::upsert_force(&db, "p1", "", "development", &[]).unwrap();
        sesion_de(&db, "s1", &p.id, 60);
        project_threads::open(&db, &p.id, "revisar el viewer", "s1").unwrap();
        project_threads::open(&db, &p.id, "de otra sesión", "s2").unwrap();

        let b = for_session(&db, "s1").unwrap();
        assert_eq!(b.hilos.len(), 1);
        assert_eq!(b.hilos[0].thread, "revisar el viewer");
        assert!(b.ventana_confiable);
    }

    /// Sin duración no hay ventana: antes que deducir notas de una franja
    /// inventada, no se deduce nada y se dice que la ventana no sirve.
    #[test]
    fn sin_duracion_no_deduce_notas() {
        let db = Db::new_in_memory().unwrap();
        let p = projects::upsert_force(&db, "p1", "", "development", &[]).unwrap();
        sesion_de(&db, "s1", &p.id, 0);
        notes::add(&db, &p.id, "una nota de hoy", &["x".to_string()], None, None).unwrap();

        let b = for_session(&db, "s1").unwrap();
        assert!(!b.ventana_confiable);
        assert!(b.desde.is_none());
        assert!(b.notas.is_empty());
    }

    #[test]
    fn con_ventana_trae_las_notas_de_esa_franja() {
        let db = Db::new_in_memory().unwrap();
        let p = projects::upsert_force(&db, "p1", "", "development", &[]).unwrap();
        notes::add(&db, &p.id, "nota dentro de la ventana", &["x".to_string()], None, None)
            .unwrap();
        sesion_de(&db, "s1", &p.id, 120);

        let b = for_session(&db, "s1").unwrap();
        assert_eq!(b.notas.len(), 1);
        assert_eq!(b.notas[0].content, "nota dentro de la ventana");
    }

    #[test]
    fn una_sesion_inexistente_no_rompe() {
        let db = Db::new_in_memory().unwrap();
        let b = for_session(&db, "no-existe").unwrap();
        assert_eq!(b.session_id, "no-existe");
        assert!(b.project_id.is_none());
        assert!(b.decisiones.is_empty());
    }
}
