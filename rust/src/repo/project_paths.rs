//! Multi-path bindings per project. The `path_key` column is the
//! canonical form used for matching (lowercase, forward slashes, no
//! trailing slash). Callers submit whatever they have; the server
//! canonicalises before storing and looking up.

use anyhow::Result;
use rusqlite::{params, OptionalExtension};
use serde::Serialize;

use super::{new_uuid, Db};

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ProjectPath {
    pub id: String,
    pub project_id: String,
    pub path: String,
    pub path_key: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ResolvedPath {
    pub project_id: String,
    pub matched_path: String,
    pub matched_key: String,
}

pub fn canonicalize(path: &str) -> String {
    let trimmed = path.trim();
    let unified = trimmed.replace('\\', "/");
    let stripped = unified.trim_end_matches('/').to_string();
    stripped.to_lowercase()
}

pub fn add(db: &Db, project_id: &str, path: &str) -> Result<ProjectPath> {
    let key = canonicalize(path);
    if key.is_empty() {
        anyhow::bail!("path is empty");
    }
    db.with(|conn| {
        // Verify project exists (FK will fail otherwise, but message is nicer).
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
        // If the key already exists, return whatever is there (no-op idempotent).
        if let Some(existing) = conn
            .query_row(
                "SELECT id, project_id, path, path_key, created_at
                 FROM project_paths WHERE path_key = ?",
                params![key],
                |r| {
                    Ok(ProjectPath {
                        id: r.get(0)?,
                        project_id: r.get(1)?,
                        path: r.get(2)?,
                        path_key: r.get(3)?,
                        created_at: r.get(4)?,
                    })
                },
            )
            .optional()?
        {
            if existing.project_id != project_id {
                anyhow::bail!(
                    "path already bound to a different project (id={}, path={})",
                    existing.project_id,
                    existing.path
                );
            }
            return Ok(existing);
        }
        let id = new_uuid();
        conn.execute(
            "INSERT INTO project_paths (id, project_id, path, path_key)
             VALUES (?, ?, ?, ?)",
            params![id, project_id, path, key],
        )?;
        Ok(ProjectPath {
            id,
            project_id: project_id.to_string(),
            path: path.to_string(),
            path_key: key,
            created_at: String::new(),
        })
    })
}

pub fn resolve(db: &Db, path: &str) -> Result<Option<ResolvedPath>> {
    let key = canonicalize(path);
    if key.is_empty() {
        return Ok(None);
    }
    db.with(|conn| {
        let row = conn
            .query_row(
                "SELECT project_id, path, path_key
                 FROM project_paths WHERE path_key = ?",
                params![key],
                |r| {
                    Ok(ResolvedPath {
                        project_id: r.get(0)?,
                        matched_path: r.get(1)?,
                        matched_key: r.get(2)?,
                    })
                },
            )
            .optional()?;
        Ok(row)
    })
}

pub fn list_for_project(db: &Db, project_id: &str) -> Result<Vec<ProjectPath>> {
    db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, project_id, path, path_key, created_at
             FROM project_paths
             WHERE project_id = ?
             ORDER BY created_at ASC",
        )?;
        let rows = stmt
            .query_map(params![project_id], |r| {
                Ok(ProjectPath {
                    id: r.get(0)?,
                    project_id: r.get(1)?,
                    path: r.get(2)?,
                    path_key: r.get(3)?,
                    created_at: r.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

pub fn remove(db: &Db, path: &str) -> Result<bool> {
    let key = canonicalize(path);
    if key.is_empty() {
        return Ok(false);
    }
    db.with(|conn| {
        let n = conn.execute(
            "DELETE FROM project_paths WHERE path_key = ?",
            params![key],
        )?;
        Ok(n > 0)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> Db {
        let db = Db::new_in_memory().unwrap();
        db.with(|conn| {
            conn.execute(
                "INSERT INTO projects (id, name) VALUES ('p1', 'demo')",
                [],
            )?;
            Ok(())
        })
        .unwrap();
        db
    }

    #[test]
    fn canonicalize_normalises_slashes_case_and_trailing() {
        assert_eq!(canonicalize("C:\\Foo\\Bar\\"), "c:/foo/bar");
        assert_eq!(canonicalize("/home/User/Repo/"), "/home/user/repo");
        assert_eq!(canonicalize("  C:/x  "), "c:/x");
    }

    #[test]
    fn add_and_resolve_roundtrip() {
        let db = fresh();
        add(&db, "p1", "C:/Users/Foo/proj").unwrap();
        let r = resolve(&db, "c:\\users\\foo\\proj").unwrap().unwrap();
        assert_eq!(r.project_id, "p1");
    }

    #[test]
    fn add_same_path_same_project_is_idempotent() {
        let db = fresh();
        let a = add(&db, "p1", "/x/y").unwrap();
        let b = add(&db, "p1", "/x/y").unwrap();
        assert_eq!(a.id, b.id);
    }

    #[test]
    fn add_same_path_different_project_errors() {
        let db = fresh();
        db.with(|c| {
            c.execute("INSERT INTO projects (id, name) VALUES ('p2', 'other')", [])?;
            Ok(())
        })
        .unwrap();
        add(&db, "p1", "/x/y").unwrap();
        let err = add(&db, "p2", "/x/y").unwrap_err();
        assert!(err.to_string().contains("already bound"));
    }

    #[test]
    fn resolve_missing_returns_none() {
        let db = fresh();
        assert!(resolve(&db, "/nope").unwrap().is_none());
    }

    #[test]
    fn remove_deletes() {
        let db = fresh();
        add(&db, "p1", "/x/y").unwrap();
        assert!(remove(&db, "/x/y").unwrap());
        assert!(resolve(&db, "/x/y").unwrap().is_none());
    }

    #[test]
    fn list_for_project_returns_bindings() {
        let db = fresh();
        add(&db, "p1", "/a").unwrap();
        add(&db, "p1", "/b").unwrap();
        let all = list_for_project(&db, "p1").unwrap();
        assert_eq!(all.len(), 2);
    }
}
