//! Row counts per table. Used by the viewer footer for sanity checks.

use anyhow::Result;
use serde::Serialize;

use super::Db;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TableCounts {
    pub projects: i64,
    pub sessions: i64,
    pub notes: i64,
    pub decisions: i64,
    pub artifacts: i64,
    pub code_entities: i64,
    pub links: i64,
    pub memory_relations: i64,
    pub working_state: i64,
    pub events: i64,
}

pub fn table_counts(db: &Db) -> Result<TableCounts> {
    db.with(|conn| {
        let one = |t: &str| -> Result<i64> {
            let n: i64 =
                conn.query_row(&format!("SELECT COUNT(*) FROM {}", t), [], |r| r.get(0))?;
            Ok(n)
        };
        Ok(TableCounts {
            projects: one("projects")?,
            sessions: one("sessions")?,
            notes: one("notes")?,
            decisions: one("decisions")?,
            artifacts: one("artifacts")?,
            code_entities: one("code_entities")?,
            links: one("links")?,
            memory_relations: one("memory_relations")?,
            working_state: one("working_state")?,
            events: one("events")?,
        })
    })
}
