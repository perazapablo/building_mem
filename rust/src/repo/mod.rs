//! Repository layer: typed access to the SQLite store.
//!
//! Owns the single `Connection` behind a `Mutex` so we can hand `&Db` around
//! freely. SQLite does not benefit from concurrent writers here, and the
//! whole server is single-process.

use anyhow::Result;
use rusqlite::Connection;
use std::path::Path;
use std::sync::Mutex;

use crate::{db, migrations};

pub mod artifacts;
pub mod auto_link;
pub mod code_entities;
pub mod context;
pub mod counts;
pub mod decision_records;
pub mod decisions;
pub mod events;
pub mod fts;
pub mod identity;
pub mod links;
pub mod mutations;
pub mod notes;
pub mod project_paths;
pub mod project_threads;
pub mod projects;
pub mod relations;
pub mod search;
pub mod serialize;
pub mod session_focus;
pub mod sessions;
pub mod stats_derivation;
pub mod working_state;

pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self> {
        let mut conn = db::open(path)?;
        migrations::run(&mut conn)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    #[cfg(test)]
    pub fn new_in_memory() -> Result<Self> {
        let mut conn = Connection::open_in_memory()?;
        conn.pragma_update(None, "journal_mode", "MEMORY")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        migrations::run(&mut conn)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub(crate) fn with<R>(&self, f: impl FnOnce(&Connection) -> Result<R>) -> Result<R> {
        let guard = self.conn.lock().expect("db mutex poisoned");
        f(&guard)
    }

    pub(crate) fn with_mut<R>(&self, f: impl FnOnce(&mut Connection) -> Result<R>) -> Result<R> {
        let mut guard = self.conn.lock().expect("db mutex poisoned");
        f(&mut guard)
    }
}

pub(crate) fn parse_json_array(raw: &str) -> Vec<String> {
    if raw.is_empty() {
        return Vec::new();
    }
    serde_json::from_str(raw).unwrap_or_default()
}

pub(crate) fn serialize_json_array(items: &[String]) -> String {
    serde_json::to_string(items).unwrap_or_else(|_| "[]".to_string())
}

pub(crate) fn new_uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}
