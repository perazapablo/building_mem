//! One-off maintenance binary: fuses one or more "duplicate" project_ids
//! into a single canonical project_id, then deletes the duplicates.
//!
//! Migrates `project_id` references in: sessions, notes, decisions,
//! artifacts, code_entities. Other tables (memory_relations, links,
//! working_state, events) reference entities by id, which doesn't change.
//!
//! Usage:
//!     cleanup-projects \
//!       [--db <path>] \
//!       --canonical <uuid> \
//!       --duplicates <uuid,uuid,...> \
//!       [--apply]
//!
//! Default is dry-run. Without --apply, no writes happen; the report
//! shows row counts that would be moved and the projects that would be
//! deleted. With --apply, the BD is copied to `<db>.bak.<ts>` first and
//! then the changes are applied inside a single transaction.

use anyhow::{anyhow, bail, Context, Result};
use rusqlite::{params_from_iter, ToSql};
use std::env;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use mcp_memory::db;

#[derive(Debug)]
struct Args {
    db_path: PathBuf,
    canonical: String,
    duplicates: Vec<String>,
    apply: bool,
}

fn parse_args() -> Result<Args> {
    let mut db_path: Option<PathBuf> = None;
    let mut canonical: Option<String> = None;
    let mut duplicates: Vec<String> = Vec::new();
    let mut apply = false;

    let mut it = env::args().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--db" => {
                db_path = Some(PathBuf::from(
                    it.next().ok_or_else(|| anyhow!("--db requiere un valor"))?,
                ));
            }
            "--canonical" => {
                canonical = Some(it.next().ok_or_else(|| anyhow!("--canonical requiere un valor"))?);
            }
            "--duplicates" => {
                let raw = it.next().ok_or_else(|| anyhow!("--duplicates requiere un valor"))?;
                duplicates = raw
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
            }
            "--apply" => apply = true,
            "--help" | "-h" => {
                print_usage();
                std::process::exit(0);
            }
            other => bail!("argumento desconocido: {other}"),
        }
    }

    let db_path = db_path
        .or_else(|| env::var("MCP_MEMORY_DB_PATH").ok().map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("memory.db"));
    let canonical = canonical.ok_or_else(|| anyhow!("--canonical es requerido"))?;
    if duplicates.is_empty() {
        bail!("--duplicates es requerido (lista separada por comas, ≥1)");
    }
    if duplicates.iter().any(|d| d == &canonical) {
        bail!("el canónico no puede estar en --duplicates");
    }

    Ok(Args { db_path, canonical, duplicates, apply })
}

fn print_usage() {
    eprintln!(
        "uso: cleanup-projects [--db <path>] --canonical <uuid> --duplicates <uuid,uuid,...> [--apply]\n\
         \n\
         Sin --apply corre en dry-run. Con --apply hace backup y aplica en transacción."
    );
}

fn timestamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Simple compact stamp; no timezone gymnastics needed for a backup label.
    format!("{secs}")
}

fn backup(db_path: &Path) -> Result<PathBuf> {
    let bak = db_path.with_extension(format!(
        "{}.bak.{}",
        db_path.extension().and_then(|s| s.to_str()).unwrap_or("db"),
        timestamp()
    ));
    std::fs::copy(db_path, &bak)
        .with_context(|| format!("copiando {} → {}", db_path.display(), bak.display()))?;
    Ok(bak)
}

const ENTITY_TABLES: &[&str] = &["sessions", "notes", "decisions", "artifacts", "code_entities"];

fn count_for(
    conn: &rusqlite::Connection,
    table: &str,
    project_id: &str,
) -> Result<i64> {
    let sql = format!("SELECT COUNT(*) FROM {table} WHERE project_id = ?");
    let n: i64 = conn.query_row(&sql, [project_id], |r| r.get(0))?;
    Ok(n)
}

fn project_exists(conn: &rusqlite::Connection, id: &str) -> Result<Option<String>> {
    let row: Option<String> = conn
        .query_row(
            "SELECT name FROM projects WHERE id = ?",
            [id],
            |r| r.get(0),
        )
        .ok();
    Ok(row)
}

fn main() -> Result<()> {
    if env::args().any(|a| a == "--list") {
        let db_path = env::args()
            .skip_while(|a| a != "--db")
            .nth(1)
            .map(PathBuf::from)
            .or_else(|| env::var("MCP_MEMORY_DB_PATH").ok().map(PathBuf::from))
            .unwrap_or_else(|| PathBuf::from("memory.db"));
        let conn = db::open(&db_path)?;
        let mut stmt = conn.prepare(
            "SELECT id, name, project_type, created_at FROM projects ORDER BY name, created_at",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?;
        println!("{:<38} {:<32} {:<14} {}", "id", "name", "type", "created_at");
        println!("{}", "-".repeat(110));
        for r in rows {
            let (id, name, ptype, created) = r?;
            println!("{:<38} {:<32} {:<14} {}", id, name, ptype, created);
        }
        return Ok(());
    }

    let args = parse_args()?;

    eprintln!("[cleanup] db: {}", args.db_path.display());
    eprintln!("[cleanup] canonical: {}", args.canonical);
    eprintln!("[cleanup] duplicates: {:?}", args.duplicates);
    eprintln!("[cleanup] mode: {}", if args.apply { "APPLY" } else { "dry-run" });

    let mut conn = db::open(&args.db_path)?;

    // Validations
    let canon_name = project_exists(&conn, &args.canonical)?
        .ok_or_else(|| anyhow!("canónico {} no existe en projects", args.canonical))?;
    eprintln!("[cleanup] canónico OK: {} ({})", args.canonical, canon_name);

    for d in &args.duplicates {
        match project_exists(&conn, d)? {
            Some(name) => eprintln!("[cleanup] duplicado OK: {d} ({name})"),
            None => eprintln!("[cleanup] WARN: duplicado {d} no existe (se ignora en DELETE)"),
        }
    }

    // Pre-counts
    println!("\n=== pre ===");
    print_counts(&conn, &args.canonical, &args.duplicates)?;

    if !args.apply {
        // Show what UPDATEs would move.
        println!("\n=== a mover (dry-run) ===");
        for table in ENTITY_TABLES {
            for d in &args.duplicates {
                let n = count_for(&conn, table, d)?;
                if n > 0 {
                    println!("  UPDATE {table} ← {d}: {n} filas");
                }
            }
        }
        println!("\n[dry-run] sin cambios aplicados. Re-ejecutar con --apply para escribir.");
        return Ok(());
    }

    // APPLY
    let bak = backup(&args.db_path)?;
    eprintln!("[cleanup] backup: {}", bak.display());

    let tx = conn.transaction()?;

    let placeholders = std::iter::repeat("?")
        .take(args.duplicates.len())
        .collect::<Vec<_>>()
        .join(",");
    let mut params_vec: Vec<&dyn ToSql> = Vec::with_capacity(args.duplicates.len() + 1);
    let canon: &dyn ToSql = &args.canonical;
    params_vec.push(canon);
    for d in &args.duplicates {
        params_vec.push(d as &dyn ToSql);
    }

    let mut moved_total = 0i64;
    for table in ENTITY_TABLES {
        let sql = format!(
            "UPDATE {table} SET project_id = ? WHERE project_id IN ({placeholders})"
        );
        let n = tx.execute(&sql, params_from_iter(params_vec.iter()))?;
        println!("[update {table}] {n} filas");
        moved_total += n as i64;
    }

    // Delete duplicate projects
    let delete_sql = format!("DELETE FROM projects WHERE id IN ({placeholders})");
    let del_params: Vec<&dyn ToSql> = args.duplicates.iter().map(|d| d as &dyn ToSql).collect();
    let n_del = tx.execute(&delete_sql, params_from_iter(del_params.iter()))?;
    println!("[delete projects] {n_del} filas");

    tx.commit()?;

    // Post-counts
    println!("\n=== post ===");
    print_counts(&conn, &args.canonical, &args.duplicates)?;

    println!(
        "\n[done] {moved_total} filas movidas a canónico, {n_del} proyectos eliminados. Backup: {}",
        bak.display()
    );

    Ok(())
}

fn print_counts(
    conn: &rusqlite::Connection,
    canonical: &str,
    duplicates: &[String],
) -> Result<()> {
    let header = format!(
        "{:<40} {:>8} {:>8} {:>8} {:>8} {:>8}",
        "project_id", "sess", "notes", "dec", "art", "code"
    );
    println!("{header}");
    println!("{}", "-".repeat(header.len()));

    let mut all_ids = vec![canonical.to_string()];
    all_ids.extend(duplicates.iter().cloned());
    for id in &all_ids {
        let exists = project_exists(conn, id)?.is_some();
        let s = count_for(conn, "sessions", id)?;
        let n = count_for(conn, "notes", id)?;
        let d = count_for(conn, "decisions", id)?;
        let a = count_for(conn, "artifacts", id)?;
        let c = count_for(conn, "code_entities", id)?;
        let label = if exists { id.clone() } else { format!("{id} (deleted)") };
        println!("{:<40} {:>8} {:>8} {:>8} {:>8} {:>8}", label, s, n, d, a, c);
    }
    Ok(())
}
