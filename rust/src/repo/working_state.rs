//! Working state per session: focus, open threads, pinned IDs.
//!
//! Upsert by `session_id` (PK). `build_context` reads pinned IDs from here
//! to prioritise relevant entities within the token budget.

use anyhow::Result;
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use std::collections::HashSet;

use super::{parse_json_array, serialize_json_array, Db};

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct WorkingState {
    pub session_id: String,
    pub focus: String,
    pub open_threads: Vec<String>,
    pub pinned_ids: Vec<String>,
    pub updated_at: String,
}

pub fn set(
    db: &Db,
    session_id: &str,
    focus: &str,
    open_threads: &[String],
    pinned_ids: &[String],
) -> Result<()> {
    db.with(|conn| {
        conn.execute(
            "INSERT INTO working_state (session_id, focus, open_threads, pinned_ids, updated_at)
             VALUES (?, ?, ?, ?, datetime('now'))
             ON CONFLICT(session_id) DO UPDATE SET
               focus = excluded.focus,
               open_threads = excluded.open_threads,
               pinned_ids = excluded.pinned_ids,
               updated_at = datetime('now')",
            params![
                session_id,
                focus,
                serialize_json_array(open_threads),
                serialize_json_array(pinned_ids)
            ],
        )?;
        Ok(())
    })
}

pub fn list_all(db: &Db) -> Result<Vec<WorkingState>> {
    db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT session_id, focus, open_threads, pinned_ids, updated_at
             FROM working_state
             ORDER BY updated_at DESC",
        )?;
        let rows: Vec<WorkingState> = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })?
            .map(|res| {
                res.map(|(session_id, focus, ot, pi, updated_at)| WorkingState {
                    session_id,
                    focus,
                    open_threads: parse_json_array(&ot),
                    pinned_ids: parse_json_array(&pi),
                    updated_at,
                })
            })
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    })
}

pub fn get(db: &Db, session_id: &str) -> Result<Option<WorkingState>> {
    db.with(|conn| {
        let row = conn
            .query_row(
                "SELECT session_id, focus, open_threads, pinned_ids, updated_at
                 FROM working_state WHERE session_id = ?",
                params![session_id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                    ))
                },
            )
            .optional()?;
        Ok(row.map(|(session_id, focus, ot, pi, updated_at)| WorkingState {
            session_id,
            focus,
            open_threads: parse_json_array(&ot),
            pinned_ids: parse_json_array(&pi),
            updated_at,
        }))
    })
}

/// Returns the union of pinned IDs for one session (when provided), or the
/// union across all working_state rows (legacy global behaviour).
pub fn pinned_ids(db: &Db, session_id: Option<&str>) -> Result<HashSet<String>> {
    db.with(|conn| {
        let mut set = HashSet::new();
        if let Some(sid) = session_id {
            if let Some(raw) = conn
                .query_row(
                    "SELECT pinned_ids FROM working_state WHERE session_id = ?",
                    params![sid],
                    |r| r.get::<_, String>(0),
                )
                .optional()?
            {
                for id in parse_json_array(&raw) {
                    set.insert(id);
                }
            }
        } else {
            let mut stmt = conn.prepare(
                "SELECT pinned_ids FROM working_state ORDER BY updated_at DESC",
            )?;
            let raws: Vec<String> = stmt
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<_>>()?;
            for raw in raws {
                for id in parse_json_array(&raw) {
                    set.insert(id);
                }
            }
        }
        Ok(set)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> Db {
        Db::new_in_memory().unwrap()
    }

    #[test]
    fn set_creates_then_updates() {
        let db = fresh();
        set(&db, "s1", "focus-1", &["t1".into()], &["p1".into()]).unwrap();
        let w = get(&db, "s1").unwrap().unwrap();
        assert_eq!(w.focus, "focus-1");
        assert_eq!(w.open_threads, vec!["t1".to_string()]);
        assert_eq!(w.pinned_ids, vec!["p1".to_string()]);

        set(&db, "s1", "focus-2", &[], &["p2".into(), "p3".into()]).unwrap();
        let w = get(&db, "s1").unwrap().unwrap();
        assert_eq!(w.focus, "focus-2");
        assert!(w.open_threads.is_empty());
        assert_eq!(w.pinned_ids, vec!["p2".to_string(), "p3".into()]);
    }

    #[test]
    fn get_missing_returns_none() {
        let db = fresh();
        assert!(get(&db, "no-such").unwrap().is_none());
    }

    #[test]
    fn pinned_ids_per_session() {
        let db = fresh();
        set(&db, "s1", "", &[], &["a".into(), "b".into()]).unwrap();
        set(&db, "s2", "", &[], &["b".into(), "c".into()]).unwrap();

        let p1 = pinned_ids(&db, Some("s1")).unwrap();
        assert_eq!(p1, ["a".to_string(), "b".into()].into_iter().collect());

        let global = pinned_ids(&db, None).unwrap();
        assert_eq!(
            global,
            ["a".to_string(), "b".into(), "c".into()].into_iter().collect()
        );
    }
}
