//! Resumen de un proyecto: los números que contestan "¿cuánto se trabajó acá y
//! qué quedó?" sin abrir ninguna sección.
//!
//! Todo sale de una sola pasada por `sessions` más conteos sueltos. Los
//! minutos vienen del `stats.duration_min` que guardó cada sesión, que es
//! **reloj de pared** — desde que arrancó hasta que se cerró — así que se
//! informa cuántas sesiones tienen medición, no se promedia sobre las 140.

use anyhow::Result;
use rusqlite::params;
use serde::Serialize;

use super::Db;

#[derive(Debug, Clone, Serialize, Default)]
pub struct DiaActividad {
    pub fecha: String,
    pub sesiones: i64,
    pub minutos: i64,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct OrigenDecisiones {
    pub explicito: i64,
    pub implicito: i64,
    pub inferido: i64,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct ProjectDashboard {
    pub sesiones: i64,
    pub dias_activos: i64,
    pub primera: Option<String>,
    pub ultima: Option<String>,

    /// Cuántas sesiones tienen duración medida. El resto son anteriores a que
    /// el harness guardara stats: contarlas como 0 minutos ensuciaría el total.
    pub sesiones_medidas: i64,
    pub minutos_totales: i64,
    pub minutos_mediana: i64,
    pub minutos_max: i64,

    /// Sesiones que cerró el modelo con narrativa vs las que salvó el harness
    /// automáticamente. Mide cuánto del registro es relato y cuánto es rastro.
    pub con_cierre: i64,
    pub auto_guardadas: i64,

    pub decisiones: i64,
    pub origen: OrigenDecisiones,
    pub notas: i64,
    pub artefactos: i64,
    pub entidades_codigo: i64,
    pub hilos_abiertos: i64,

    pub commits: i64,
    pub archivos_editados: i64,

    /// Un renglón por día con actividad, ascendente. El calendario rellena los
    /// huecos: acá sólo viajan los días que existieron.
    pub dias: Vec<DiaActividad>,
}

fn contar(db: &Db, sql: &str, project_id: &str) -> Result<i64> {
    db.with(|conn| {
        let n: i64 = conn.query_row(sql, params![project_id], |r| r.get(0))?;
        Ok(n)
    })
}

pub fn for_project(db: &Db, project_id: &str) -> Result<ProjectDashboard> {
    let mut d = ProjectDashboard {
        decisiones: contar(
            db,
            "SELECT count(*) FROM decision_records WHERE project_id = ? AND status = 'active'",
            project_id,
        )?,
        notas: contar(db, "SELECT count(*) FROM notes WHERE project_id = ?", project_id)?,
        artefactos: contar(db, "SELECT count(*) FROM artifacts WHERE project_id = ?", project_id)?,
        entidades_codigo: contar(
            db,
            "SELECT count(*) FROM code_entities WHERE project_id = ?",
            project_id,
        )?,
        hilos_abiertos: contar(
            db,
            "SELECT count(*) FROM project_threads WHERE project_id = ? AND status = 'open'",
            project_id,
        )?,
        ..Default::default()
    };

    db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT origin, count(*) FROM decision_records
              WHERE project_id = ? AND status = 'active' GROUP BY origin",
        )?;
        let filas = stmt.query_map(params![project_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })?;
        for f in filas {
            let (origen, n) = f?;
            match origen.as_str() {
                "user_explicit" => d.origen.explicito = n,
                "user_implicit" => d.origen.implicito = n,
                _ => d.origen.inferido += n,
            }
        }
        Ok(())
    })?;

    // Una sola pasada por las sesiones: de cada una salen el día, los minutos,
    // los commits, los archivos y si la cerró el modelo o el harness.
    let mut duraciones: Vec<i64> = Vec::new();
    db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT created_at, summary FROM sessions
              WHERE project_id = ? ORDER BY created_at ASC",
        )?;
        let filas = stmt.query_map(params![project_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
        })?;

        for fila in filas {
            let (created_at, summary) = fila?;
            d.sesiones += 1;
            if d.primera.is_none() {
                d.primera = Some(created_at.clone());
            }
            d.ultima = Some(created_at.clone());

            let dia = created_at.get(..10).unwrap_or_default().to_string();
            let mut minutos = 0_i64;

            if let Some(json) = summary.as_deref() {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(json) {
                    if let Some(st) = v.get("stats") {
                        minutos = st.get("duration_min").and_then(|x| x.as_i64()).unwrap_or(0);
                        if minutos > 0 {
                            d.sesiones_medidas += 1;
                            d.minutos_totales += minutos;
                            d.minutos_max = d.minutos_max.max(minutos);
                            duraciones.push(minutos);
                        }
                        d.commits += st
                            .get("commits")
                            .and_then(|x| x.as_array())
                            .map(|a| a.len() as i64)
                            .unwrap_or(0);
                        d.archivos_editados += st
                            .get("files_edited")
                            .and_then(|x| x.as_array())
                            .map(|a| a.len() as i64)
                            .unwrap_or(0);
                    }
                    // El auto-guardado se reconoce por su propia nota: es el
                    // único que la escribe.
                    let auto = v
                        .get("notes")
                        .and_then(|x| x.as_str())
                        .is_some_and(|s| s.contains("auto-saved"));
                    if auto {
                        d.auto_guardadas += 1;
                    } else {
                        d.con_cierre += 1;
                    }
                }
            }

            match d.dias.last_mut() {
                Some(ultimo) if ultimo.fecha == dia => {
                    ultimo.sesiones += 1;
                    ultimo.minutos += minutos;
                }
                _ => d.dias.push(DiaActividad { fecha: dia, sesiones: 1, minutos }),
            }
        }
        Ok(())
    })?;

    d.dias_activos = d.dias.len() as i64;
    if !duraciones.is_empty() {
        duraciones.sort_unstable();
        d.minutos_mediana = duraciones[duraciones.len() / 2];
    }
    Ok(d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repo::{projects, sessions};
    use crate::summary::{SessionStats, SessionSummary};

    fn con_stats(goal: &str, duration_min: i64, commits: Vec<String>) -> SessionSummary {
        SessionSummary {
            goal: goal.into(),
            stats: Some(SessionStats { duration_min, commits, ..Default::default() }),
            ..Default::default()
        }
    }

    #[test]
    fn agrupa_sesiones_por_dia_y_suma_lo_medido() {
        let db = Db::new_in_memory().unwrap();
        let p = projects::upsert_force(&db, "p1", "", "development", &[]).unwrap();
        sessions::update_checkpoint(&db, "s1", &p.id, Some(&con_stats("uno", 60, vec![]))).unwrap();
        sessions::update_checkpoint(
            &db,
            "s2",
            &p.id,
            Some(&con_stats("dos", 120, vec!["abc".into()])),
        )
        .unwrap();

        let d = for_project(&db, &p.id).unwrap();
        assert_eq!(d.sesiones, 2);
        assert_eq!(d.sesiones_medidas, 2);
        assert_eq!(d.minutos_totales, 180);
        assert_eq!(d.commits, 1);
        // Las dos se crearon hoy: un solo día con dos sesiones.
        assert_eq!(d.dias.len(), 1);
        assert_eq!(d.dias[0].sesiones, 2);
        assert_eq!(d.dias[0].minutos, 180);
    }

    /// Una sesión sin duración no baja el promedio: no se cuenta como medida.
    #[test]
    fn una_sesion_sin_duracion_no_cuenta_como_medida() {
        let db = Db::new_in_memory().unwrap();
        let p = projects::upsert_force(&db, "p1", "", "development", &[]).unwrap();
        sessions::update_checkpoint(&db, "s1", &p.id, Some(&con_stats("sin medir", 0, vec![])))
            .unwrap();
        let d = for_project(&db, &p.id).unwrap();
        assert_eq!(d.sesiones, 1);
        assert_eq!(d.sesiones_medidas, 0);
        assert_eq!(d.minutos_totales, 0);
    }
}
