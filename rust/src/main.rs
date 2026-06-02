use anyhow::Result;
use std::env;
use std::path::PathBuf;
use std::sync::Arc;
use tracing::info;
use tracing_subscriber::EnvFilter;

use mcp_memory::repo::Db;
use mcp_memory::tools::MemoryService;
use rmcp::{transport::stdio, ServiceExt};

#[tokio::main]
async fn main() -> Result<()> {
    // stdout is reserved for the MCP JSON-RPC stream; logs go to stderr.
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_writer(std::io::stderr)
        .init();

    let db_path = env::var("MCP_MEMORY_DB_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| default_db_path());

    info!(path = %db_path.display(), "opening database");
    let db = Arc::new(Db::open(&db_path)?);

    info!("starting MCP server on stdio");
    let service = MemoryService::new(db).serve(stdio()).await?;
    service.waiting().await?;
    Ok(())
}

fn default_db_path() -> PathBuf {
    let exe = env::current_exe().unwrap_or_else(|_| PathBuf::from("."));
    let parent = exe
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    parent.join("memory.db")
}
