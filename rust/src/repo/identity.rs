//! Active-row lookup by collision key.
//!
//! Mirrors `findActiveByTopic` and `findActiveByHash` in `src/db.ts`
//! L1114-1135. Both operate on a borrowed `&Connection` so callers that
//! already hold the `Db` mutex (e.g. inside `add_*`) can reuse them without
//! re-acquiring the lock.

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};

pub fn find_active_by_topic(
    conn: &Connection,
    table: &str,
    project_id: &str,
    topic_key: &str,
) -> Result<Option<String>> {
    let sql = format!(
        "SELECT id FROM {table}
         WHERE project_id = ? AND topic_key = ? AND status = 'active'
         ORDER BY revision_count DESC, COALESCE(updated_at, created_at) DESC
         LIMIT 1",
        table = table
    );
    let id = conn
        .query_row(&sql, params![project_id, topic_key], |r| r.get::<_, String>(0))
        .optional()?;
    Ok(id)
}

pub fn find_active_by_hash(
    conn: &Connection,
    table: &str,
    project_id: &str,
    content_hash: &str,
) -> Result<Option<String>> {
    let sql = format!(
        "SELECT id FROM {table}
         WHERE project_id = ? AND content_hash = ? AND status = 'active'
         ORDER BY revision_count DESC, COALESCE(updated_at, created_at) DESC
         LIMIT 1",
        table = table
    );
    let id = conn
        .query_row(&sql, params![project_id, content_hash], |r| r.get::<_, String>(0))
        .optional()?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repo::Db;

    fn fresh_with_project(name: &str) -> (Db, String) {
        let db = Db::new_in_memory().unwrap();
        let id = db
            .with(|conn| {
                let id = crate::repo::new_uuid();
                conn.execute(
                    "INSERT INTO projects (id, name) VALUES (?, ?)",
                    params![id, name],
                )?;
                Ok(id)
            })
            .unwrap();
        (db, id)
    }

    #[test]
    fn find_by_topic_returns_none_when_missing() {
        let (db, pid) = fresh_with_project("p1");
        db.with(|conn| {
            let r = find_active_by_topic(conn, "notes", &pid, "no-such")?;
            assert!(r.is_none());
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn find_by_topic_returns_active_only() {
        let (db, pid) = fresh_with_project("p1");
        db.with(|conn| {
            conn.execute(
                "INSERT INTO notes (id, project_id, content, topic_key, content_hash, status) VALUES ('n1', ?, 'x', 'k1', 'h1', 'active')",
                params![pid],
            )?;
            conn.execute(
                "INSERT INTO notes (id, project_id, content, topic_key, content_hash, status) VALUES ('n2', ?, 'y', 'k1', 'h2', 'obsolete')",
                params![pid],
            )?;
            let r = find_active_by_topic(conn, "notes", &pid, "k1")?;
            assert_eq!(r.as_deref(), Some("n1"));
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn find_by_hash_matches_active() {
        let (db, pid) = fresh_with_project("p1");
        db.with(|conn| {
            conn.execute(
                "INSERT INTO notes (id, project_id, content, content_hash, status) VALUES ('n1', ?, 'x', 'deadbeef', 'active')",
                params![pid],
            )?;
            let r = find_active_by_hash(conn, "notes", &pid, "deadbeef")?;
            assert_eq!(r.as_deref(), Some("n1"));
            let r = find_active_by_hash(conn, "notes", &pid, "nope")?;
            assert!(r.is_none());
            Ok(())
        })
        .unwrap();
    }
}
