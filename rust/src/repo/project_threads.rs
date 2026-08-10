//! Threads with explicit lifecycle, scoped to a project (not a session).
//!
//! A thread is opened by a session and stays alive across sessions until
//! `close_thread` is called or `mark_stale_older_than` archives it by
//! inactivity. Sessions that touch a thread (via `touch`) bump
//! `updated_at`, keeping it out of stale territory.

use anyhow::Result;
use rusqlite::{params, OptionalExtension};
use serde::Serialize;

use super::{new_uuid, Db};

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ProjectThread {
    pub id: String,
    pub project_id: String,
    pub thread: String,
    pub status: String,
    pub opened_in: String,
    pub closed_in: Option<String>,
    pub close_reason: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub closed_at: Option<String>,
}

pub fn open(db: &Db, project_id: &str, thread: &str, session_id: &str) -> Result<ProjectThread> {
    let thread = thread.trim();
    if thread.is_empty() {
        anyhow::bail!("thread text is empty");
    }
    let id = new_uuid();
    db.with(|conn| {
        let exists: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM projects WHERE id = ?",
                params![project_id],
                |r| r.get(0),
            )
            .optional()?;
        if exists.is_none() {
            anyhow::bail!("project not found: {}", project_id);
        }
        conn.execute(
            "INSERT INTO project_threads (id, project_id, thread, opened_in)
             VALUES (?, ?, ?, ?)",
            params![id, project_id, thread, session_id],
        )?;
        Ok(())
    })?;
    get(db, &id)?.ok_or_else(|| anyhow::anyhow!("row disappeared after insert"))
}

pub fn close(
    db: &Db,
    thread_id: &str,
    status: &str,
    reason: Option<&str>,
    session_id: &str,
) -> Result<ProjectThread> {
    if !matches!(status, "done" | "dropped") {
        anyhow::bail!("close status must be 'done' or 'dropped', got {}", status);
    }
    db.with(|conn| {
        let n = conn.execute(
            "UPDATE project_threads
                SET status = ?,
                    closed_in = ?,
                    close_reason = ?,
                    closed_at = datetime('now'),
                    updated_at = datetime('now')
              WHERE id = ? AND status = 'open'",
            params![status, session_id, reason, thread_id],
        )?;
        if n == 0 {
            anyhow::bail!("thread not found or already closed: {}", thread_id);
        }
        Ok(())
    })?;
    get(db, thread_id)?.ok_or_else(|| anyhow::anyhow!("row disappeared after update"))
}

pub fn touch(db: &Db, thread_id: &str) -> Result<bool> {
    db.with(|conn| {
        let n = conn.execute(
            "UPDATE project_threads SET updated_at = datetime('now')
             WHERE id = ? AND status = 'open'",
            params![thread_id],
        )?;
        Ok(n > 0)
    })
}

pub fn get(db: &Db, thread_id: &str) -> Result<Option<ProjectThread>> {
    db.with(|conn| {
        let row = conn
            .query_row(
                "SELECT id, project_id, thread, status, opened_in, closed_in,
                        close_reason, created_at, updated_at, closed_at
                 FROM project_threads WHERE id = ?",
                params![thread_id],
                |r| {
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
                },
            )
            .optional()?;
        Ok(row)
    })
}

pub fn list_by_project(
    db: &Db,
    project_id: &str,
    status_filter: Option<&str>,
) -> Result<Vec<ProjectThread>> {
    db.with(|conn| {
        let (sql, has_filter) = if status_filter.is_some() {
            (
                "SELECT id, project_id, thread, status, opened_in, closed_in,
                        close_reason, created_at, updated_at, closed_at
                 FROM project_threads
                 WHERE project_id = ? AND status = ?
                 ORDER BY updated_at DESC",
                true,
            )
        } else {
            (
                "SELECT id, project_id, thread, status, opened_in, closed_in,
                        close_reason, created_at, updated_at, closed_at
                 FROM project_threads
                 WHERE project_id = ?
                 ORDER BY updated_at DESC",
                false,
            )
        };
        let mut stmt = conn.prepare(sql)?;
        let mapper = |r: &rusqlite::Row| {
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
        };
        let rows: Vec<ProjectThread> = if has_filter {
            stmt.query_map(params![project_id, status_filter.unwrap()], mapper)?
                .collect::<rusqlite::Result<_>>()?
        } else {
            stmt.query_map(params![project_id], mapper)?
                .collect::<rusqlite::Result<_>>()?
        };
        Ok(rows)
    })
}

/// Move `open` threads older than `days` into `stale` status. Non-destructive;
/// the harness / viewer highlights them so a human decides.
pub fn mark_stale_older_than(db: &Db, project_id: &str, days: i64) -> Result<usize> {
    if days <= 0 {
        anyhow::bail!("days must be > 0");
    }
    db.with(|conn| {
        let n = conn.execute(
            "UPDATE project_threads
                SET status = 'stale', updated_at = datetime('now')
              WHERE project_id = ?
                AND status = 'open'
                AND julianday('now') - julianday(updated_at) > ?",
            params![project_id, days as f64],
        )?;
        Ok(n)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> Db {
        let db = Db::new_in_memory().unwrap();
        db.with(|conn| {
            conn.execute("INSERT INTO projects (id, name) VALUES ('p1', 'demo')", [])?;
            Ok(())
        })
        .unwrap();
        db
    }

    #[test]
    fn open_creates_row_status_open() {
        let db = fresh();
        let t = open(&db, "p1", "impl foo", "s1").unwrap();
        assert_eq!(t.status, "open");
        assert_eq!(t.opened_in, "s1");
        assert!(t.closed_at.is_none());
    }

    #[test]
    fn close_marks_done_or_dropped() {
        let db = fresh();
        let t = open(&db, "p1", "impl foo", "s1").unwrap();
        let closed = close(&db, &t.id, "done", Some("shipped"), "s2").unwrap();
        assert_eq!(closed.status, "done");
        assert_eq!(closed.closed_in.as_deref(), Some("s2"));
        assert_eq!(closed.close_reason.as_deref(), Some("shipped"));
        assert!(closed.closed_at.is_some());
    }

    #[test]
    fn close_rejects_invalid_status() {
        let db = fresh();
        let t = open(&db, "p1", "x", "s1").unwrap();
        let err = close(&db, &t.id, "open", None, "s2").unwrap_err();
        assert!(err.to_string().contains("must be"));
    }

    #[test]
    fn close_twice_fails() {
        let db = fresh();
        let t = open(&db, "p1", "x", "s1").unwrap();
        close(&db, &t.id, "done", None, "s2").unwrap();
        let err = close(&db, &t.id, "done", None, "s3").unwrap_err();
        assert!(err.to_string().contains("not found or already closed"));
    }

    #[test]
    fn touch_only_open() {
        let db = fresh();
        let t = open(&db, "p1", "x", "s1").unwrap();
        assert!(touch(&db, &t.id).unwrap());
        close(&db, &t.id, "done", None, "s2").unwrap();
        assert!(!touch(&db, &t.id).unwrap());
    }

    #[test]
    fn list_by_status() {
        let db = fresh();
        let a = open(&db, "p1", "a", "s1").unwrap();
        let b = open(&db, "p1", "b", "s1").unwrap();
        close(&db, &a.id, "done", None, "s2").unwrap();
        let opens = list_by_project(&db, "p1", Some("open")).unwrap();
        assert_eq!(opens.len(), 1);
        assert_eq!(opens[0].id, b.id);
        let all = list_by_project(&db, "p1", None).unwrap();
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn mark_stale_rejects_nonpositive_days() {
        let db = fresh();
        assert!(mark_stale_older_than(&db, "p1", 0).is_err());
    }
}
