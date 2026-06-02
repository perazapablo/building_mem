use anyhow::Result;
use std::env;
use std::path::PathBuf;
use tracing_subscriber::EnvFilter;

use mcp_memory::{db, migrations};

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with_writer(std::io::stderr)
        .init();

    let db_path = env::args()
        .nth(1)
        .map(PathBuf::from)
        .or_else(|| env::var("MCP_MEMORY_DB_PATH").ok().map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("memory.db"));

    eprintln!("[migrate] db: {}", db_path.display());
    let mut conn = db::open(&db_path)?;
    let report = migrations::run(&mut conn)?;

    println!("applied_new: {:?}", report.applied_new);
    println!("already_present: {:?}", report.already_present);
    println!("checksums_rewritten: {:?}", report.checksums_rewritten);

    let count: i64 = conn.query_row("SELECT COUNT(*) FROM schema_migrations", [], |r| r.get(0))?;
    println!("schema_migrations rows: {}", count);

    Ok(())
}
