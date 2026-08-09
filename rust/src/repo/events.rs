//! Read-only access to the events audit table. Writes happen inside
//! `mutations.rs` via SQL triggers / explicit inserts; this module only
//! exposes list/query helpers consumed by the viewer.

use anyhow::Result;
use rusqlite::params;
use serde::Serialize;
use serde_json::Value;

use super::Db;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct EventRow {
    pub id: String,
    pub entity_type: String,
    pub entity_id: String,
    pub op: String,
    pub payload_before: Option<Value>,
    pub payload_after: Option<Value>,
    pub ts: String,
}

fn map(r: &rusqlite::Row<'_>) -> rusqlite::Result<EventRow> {
    let before: Option<String> = r.get(4)?;
    let after: Option<String> = r.get(5)?;
    Ok(EventRow {
        id: r.get(0)?,
        entity_type: r.get(1)?,
        entity_id: r.get(2)?,
        op: r.get(3)?,
        payload_before: before.and_then(|s| serde_json::from_str(&s).ok()),
        payload_after: after.and_then(|s| serde_json::from_str(&s).ok()),
        ts: r.get(6)?,
    })
}

pub fn list_all(
    db: &Db,
    entity_type: Option<&str>,
    entity_id: Option<&str>,
    limit: i64,
) -> Result<Vec<EventRow>> {
    db.with(|conn| {
        let base = "SELECT id, entity_type, entity_id, op, payload_before, payload_after, ts FROM events";
        match (entity_type, entity_id) {
            (Some(et), Some(eid)) => {
                let sql = format!("{base} WHERE entity_type = ? AND entity_id = ? ORDER BY ts DESC LIMIT ?");
                let mut stmt = conn.prepare(&sql)?;
                let rows = stmt.query_map(params![et, eid, limit], map)?.collect::<rusqlite::Result<_>>()?;
                Ok(rows)
            }
            (Some(et), None) => {
                let sql = format!("{base} WHERE entity_type = ? ORDER BY ts DESC LIMIT ?");
                let mut stmt = conn.prepare(&sql)?;
                let rows = stmt.query_map(params![et, limit], map)?.collect::<rusqlite::Result<_>>()?;
                Ok(rows)
            }
            _ => {
                let sql = format!("{base} ORDER BY ts DESC LIMIT ?");
                let mut stmt = conn.prepare(&sql)?;
                let rows = stmt.query_map(params![limit], map)?.collect::<rusqlite::Result<_>>()?;
                Ok(rows)
            }
        }
    })
}
