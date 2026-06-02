//! Sessions: structured summary, index, checkpoint updates.

use anyhow::Result;
use rusqlite::{params, OptionalExtension};
use serde::Serialize;

use crate::summary::{parse_session_summary, serialize as serialize_summary, SessionSummary};

use super::{new_uuid, Db};

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SessionRow {
    pub id: String,
    pub title: String,
    pub summary: Option<SessionSummary>,
    pub project_id: Option<String>,
    pub created_at: String,
    pub updated_at: Option<String>,
}

fn map_row(
    id: String,
    title: String,
    summary_raw: Option<String>,
    project_id: Option<String>,
    created_at: String,
    updated_at: Option<String>,
) -> SessionRow {
    SessionRow {
        id,
        title,
        summary: parse_session_summary(summary_raw.as_deref()),
        project_id,
        created_at,
        updated_at,
    }
}

pub fn save(db: &Db, title: &str, summary: &SessionSummary, project_id: Option<&str>) -> Result<String> {
    db.with(|conn| {
        let id = new_uuid();
        conn.execute(
            "INSERT INTO sessions (id, title, summary, project_id) VALUES (?, ?, ?, ?)",
            params![id, title, serialize_summary(summary), project_id],
        )?;
        Ok(id)
    })
}

pub fn update(db: &Db, id: &str, summary: &SessionSummary) -> Result<()> {
    db.with(|conn| {
        conn.execute(
            "UPDATE sessions SET summary = ?, updated_at = datetime('now') WHERE id = ?",
            params![serialize_summary(summary), id],
        )?;
        Ok(())
    })
}

pub fn update_checkpoint(
    db: &Db,
    id: &str,
    project_id: &str,
    summary: Option<&SessionSummary>,
) -> Result<()> {
    db.with(|conn| {
        let summary_text = summary.map(serialize_summary);
        conn.execute(
            "UPDATE sessions
             SET project_id = ?,
                 summary = COALESCE(?, summary),
                 updated_at = datetime('now')
             WHERE id = ?",
            params![project_id, summary_text, id],
        )?;
        Ok(())
    })
}

pub fn list(db: &Db, limit: i64) -> Result<Vec<SessionRow>> {
    db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, title, summary, project_id, created_at, updated_at
             FROM sessions
             ORDER BY updated_at DESC
             LIMIT ?",
        )?;
        let rows: Vec<SessionRow> = stmt
            .query_map(params![limit], |r| {
                Ok(map_row(
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    })
}

pub fn get(db: &Db, session_id: &str) -> Result<Option<SessionRow>> {
    db.with(|conn| {
        let row = conn
            .query_row(
                "SELECT id, title, summary, project_id, created_at, updated_at
                 FROM sessions WHERE id = ?",
                params![session_id],
                |r| Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, Option<String>>(5)?,
                )),
            )
            .optional()?;
        Ok(row.map(|(id, title, summary, project_id, created_at, updated_at)| {
            map_row(id, title, summary, project_id, created_at, updated_at)
        }))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repo::projects;
    use crate::summary::SessionSummary;

    fn fresh() -> Db {
        Db::new_in_memory().unwrap()
    }

    fn sample_summary() -> SessionSummary {
        SessionSummary {
            goal: "test".into(),
            outcome: "passed".into(),
            pending: vec!["next".into()],
            ..Default::default()
        }
    }

    #[test]
    fn save_and_get_roundtrip() {
        let db = fresh();
        let id = save(&db, "title", &sample_summary(), None).unwrap();
        let got = get(&db, &id).unwrap().unwrap();
        assert_eq!(got.title, "title");
        assert_eq!(got.summary.as_ref().unwrap().goal, "test");
        assert!(got.project_id.is_none());
    }

    #[test]
    fn update_replaces_summary() {
        let db = fresh();
        let id = save(&db, "t", &sample_summary(), None).unwrap();
        let new_summary = SessionSummary { goal: "updated".into(), ..Default::default() };
        update(&db, &id, &new_summary).unwrap();
        let got = get(&db, &id).unwrap().unwrap();
        assert_eq!(got.summary.unwrap().goal, "updated");
    }

    #[test]
    fn checkpoint_associates_project_and_optional_summary() {
        let db = fresh();
        let id = save(&db, "t", &sample_summary(), None).unwrap();
        let p = projects::upsert(&db, "p1", "", "development", &[]).unwrap();

        update_checkpoint(&db, &id, &p.id, None).unwrap();
        let got = get(&db, &id).unwrap().unwrap();
        assert_eq!(got.project_id.as_deref(), Some(p.id.as_str()));
        assert_eq!(got.summary.as_ref().unwrap().goal, "test");

        let new_summary = SessionSummary { goal: "checkpointed".into(), ..Default::default() };
        update_checkpoint(&db, &id, &p.id, Some(&new_summary)).unwrap();
        let got = get(&db, &id).unwrap().unwrap();
        assert_eq!(got.summary.unwrap().goal, "checkpointed");
    }

    #[test]
    fn list_returns_most_recent_first() {
        let db = fresh();
        let id1 = save(&db, "first", &sample_summary(), None).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        let id2 = save(&db, "second", &sample_summary(), None).unwrap();
        let rows = list(&db, 10).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, id2);
        assert_eq!(rows[1].id, id1);
    }

    #[test]
    fn legacy_string_summary_is_wrapped() {
        let db = fresh();
        db.with(|conn| {
            conn.execute(
                "INSERT INTO sessions (id, title, summary) VALUES ('legacy', 't', 'free-form text')",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        let got = get(&db, "legacy").unwrap().unwrap();
        let s = got.summary.unwrap();
        assert_eq!(s.notes.as_deref(), Some("free-form text"));
        assert!(s.goal.is_empty());
    }
}
