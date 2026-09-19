use anyhow::Result;
use mcp_memory::repo::Db;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

pub struct DbState {
    inner: Mutex<DbSlot>,
}

pub struct DbSlot {
    path: PathBuf,
    db: Db,
}

impl DbState {
    pub fn new(path: PathBuf) -> Result<Self> {
        let db = Db::open(&path)?;
        Ok(Self {
            inner: Mutex::new(DbSlot { path, db }),
        })
    }

    pub fn lock(&self) -> MutexGuard<'_, DbSlot> {
        self.inner.lock().expect("db state poisoned")
    }

    pub fn open(&self, path: PathBuf) -> Result<()> {
        let db = Db::open(&path)?;
        let mut guard = self.lock();
        guard.path = path;
        guard.db = db;
        Ok(())
    }
}

impl DbSlot {
    pub fn db(&self) -> &Db {
        &self.db
    }

    pub fn path_str(&self) -> String {
        self.path.display().to_string()
    }
}

/// Sin path compilado: la variable de entorno gana, y el fallback se arma
/// desde el home del usuario en tiempo de ejecución.
pub fn default_db_path() -> PathBuf {
    if let Ok(p) = std::env::var("MCP_MEMORY_DB_PATH") {
        return PathBuf::from(p);
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    PathBuf::from(home)
        .join(".config")
        .join("mcp-learning")
        .join("memory.db")
}
