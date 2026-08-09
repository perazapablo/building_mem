//! Memory relations: typed graph between entities with judgment workflow.
//! Mirrors `src/db.ts` L2447-2654.

use anyhow::Result;
use rusqlite::{params, params_from_iter, Connection, ToSql};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;

use super::Db;

pub const RELATION_TYPES: &[&str] = &[
    "implements",
    "depends_on",
    "conflicts_with",
    "replaces",
    "references",
    "structural_sibling",
    "topically_related",
    "variant_of",
    "semantically_related",
];

fn symmetric() -> HashSet<&'static str> {
    [
        "structural_sibling",
        "topically_related",
        "semantically_related",
        "variant_of",
        "conflicts_with",
    ]
    .into_iter()
    .collect()
}

/// Deterministic SHA256-based ID for a relation tuple. Mirrors
/// `computeRelationSyncId` in `src/db.ts` L2476. Symmetric relations sort
/// the endpoint keys so `(A→B, structural_sibling)` and
/// `(B→A, structural_sibling)` collapse to the same `sync_id`.
pub fn compute_relation_sync_id(
    source_type: &str,
    source_id: &str,
    target_type: &str,
    target_id: &str,
    relation: &str,
) -> String {
    let mut a = format!("{}:{}", source_type, source_id);
    let mut b = format!("{}:{}", target_type, target_id);
    if symmetric().contains(relation) && a > b {
        std::mem::swap(&mut a, &mut b);
    }
    let mut hasher = Sha256::new();
    hasher.update(format!("{}|{}|{}", a, b, relation).as_bytes());
    let hex = hex::encode(hasher.finalize());
    hex[..32].to_string()
}

#[derive(Debug, Clone, Default)]
pub struct UpsertRelationParams<'a> {
    pub sync_id: Option<&'a str>,
    pub source_type: &'a str,
    pub source_id: &'a str,
    pub target_type: &'a str,
    pub target_id: &'a str,
    pub relation: &'a str,
    pub reason: &'a str,
    pub evidence: &'a str,
    pub confidence: Option<f64>,
    pub judgment_status: Option<&'a str>,
    pub marked_by_actor: &'a str,
    pub marked_by_kind: Option<&'a str>,
    pub marked_by_model: &'a str,
    pub session_id: Option<&'a str>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Relation {
    pub sync_id: String,
    pub source_type: String,
    pub source_id: String,
    pub target_type: String,
    pub target_id: String,
    pub relation: String,
    pub reason: String,
    pub evidence: String,
    pub confidence: f64,
    pub judgment_status: String,
    pub marked_by_actor: String,
    pub marked_by_kind: String,
    pub marked_by_model: String,
    pub session_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AcceptedRelation {
    pub source_type: String,
    pub source_id: String,
    pub target_type: String,
    pub target_id: String,
    pub relation: String,
    pub confidence: f64,
}

/// In-transaction upsert. Mirrors `upsertRelationInternal` in `src/db.ts`
/// L2509. The ON CONFLICT clause preserves a `'rejected'` judgment status
/// against later overwrites — once a relation is rejected it stays rejected
/// unless explicitly judged again.
pub fn upsert_in_tx(conn: &Connection, p: &UpsertRelationParams<'_>) -> Result<String> {
    let sync_id = match p.sync_id {
        Some(s) => s.to_string(),
        None => compute_relation_sync_id(
            p.source_type,
            p.source_id,
            p.target_type,
            p.target_id,
            p.relation,
        ),
    };
    conn.execute(
        "INSERT INTO memory_relations
            (sync_id, source_type, source_id, target_type, target_id, relation, reason, evidence,
             confidence, judgment_status, marked_by_actor, marked_by_kind, marked_by_model,
             session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(sync_id) DO UPDATE SET
            source_type      = excluded.source_type,
            source_id        = excluded.source_id,
            target_type      = excluded.target_type,
            target_id        = excluded.target_id,
            relation         = excluded.relation,
            reason           = excluded.reason,
            evidence         = excluded.evidence,
            confidence       = excluded.confidence,
            judgment_status  = CASE WHEN memory_relations.judgment_status = 'rejected'
                                    THEN memory_relations.judgment_status
                                    ELSE excluded.judgment_status END,
            marked_by_actor  = excluded.marked_by_actor,
            marked_by_kind   = excluded.marked_by_kind,
            marked_by_model  = excluded.marked_by_model,
            session_id       = excluded.session_id,
            updated_at       = datetime('now')",
        params![
            sync_id,
            p.source_type,
            p.source_id,
            p.target_type,
            p.target_id,
            p.relation,
            p.reason,
            p.evidence,
            p.confidence.unwrap_or(0.5),
            p.judgment_status.unwrap_or("pending"),
            p.marked_by_actor,
            p.marked_by_kind.unwrap_or("auto"),
            p.marked_by_model,
            p.session_id,
        ],
    )?;
    Ok(sync_id)
}

pub fn upsert(db: &Db, p: &UpsertRelationParams<'_>) -> Result<String> {
    db.with(|conn| upsert_in_tx(conn, p))
}

pub fn list_all(db: &Db, limit: i64) -> Result<Vec<Relation>> {
    db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT sync_id, source_type, source_id, target_type, target_id, relation,
                    reason, evidence, confidence, judgment_status,
                    marked_by_actor, marked_by_kind, marked_by_model,
                    session_id, created_at, updated_at
             FROM memory_relations
             ORDER BY updated_at DESC, created_at DESC
             LIMIT ?",
        )?;
        let rows: Vec<Relation> = stmt
            .query_map(params![limit], map_relation)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

pub fn judge(
    db: &Db,
    sync_id: &str,
    status: &str,
    marked_by_actor: &str,
    marked_by_kind: &str,
    marked_by_model: &str,
) -> Result<()> {
    db.with(|conn| {
        conn.execute(
            "UPDATE memory_relations
             SET judgment_status = ?, marked_by_actor = ?, marked_by_kind = ?, marked_by_model = ?,
                 updated_at = datetime('now')
             WHERE sync_id = ?",
            params![status, marked_by_actor, marked_by_kind, marked_by_model, sync_id],
        )?;
        Ok(())
    })
}

#[derive(Debug, Clone, Default)]
pub struct RelationFilters<'a> {
    pub judgment_status: Option<&'a str>,
    pub relation: Option<&'a str>,
    pub limit: Option<i64>,
}

pub fn get_for_entity(
    db: &Db,
    entity_type: &str,
    entity_id: &str,
    filters: &RelationFilters<'_>,
) -> Result<Vec<Relation>> {
    let mut conditions: Vec<&str> = vec![
        "((source_type = ? AND source_id = ?) OR (target_type = ? AND target_id = ?))",
    ];
    let mut sql_params: Vec<Box<dyn ToSql>> = vec![
        Box::new(entity_type.to_string()),
        Box::new(entity_id.to_string()),
        Box::new(entity_type.to_string()),
        Box::new(entity_id.to_string()),
    ];
    if let Some(s) = filters.judgment_status {
        conditions.push("judgment_status = ?");
        sql_params.push(Box::new(s.to_string()));
    }
    if let Some(r) = filters.relation {
        conditions.push("relation = ?");
        sql_params.push(Box::new(r.to_string()));
    }
    let limit = filters.limit.unwrap_or(50);
    sql_params.push(Box::new(limit));

    let sql = format!(
        "SELECT sync_id, source_type, source_id, target_type, target_id, relation,
                reason, evidence, confidence, judgment_status,
                marked_by_actor, marked_by_kind, marked_by_model,
                session_id, created_at, updated_at
         FROM memory_relations
         WHERE {}
         ORDER BY confidence DESC, updated_at DESC
         LIMIT ?",
        conditions.join(" AND ")
    );

    db.with(|conn| {
        let mut stmt = conn.prepare(&sql)?;
        let refs: Vec<&dyn ToSql> = sql_params.iter().map(|b| b.as_ref() as &dyn ToSql).collect();
        let rows: Vec<Relation> = stmt
            .query_map(params_from_iter(refs.iter()), map_relation)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

pub fn get_pending_judgments(
    db: &Db,
    project_id: Option<&str>,
    limit: i64,
) -> Result<Vec<Relation>> {
    db.with(|conn| {
        if let Some(pid) = project_id {
            let mut stmt = conn.prepare(
                "SELECT r.sync_id, r.source_type, r.source_id, r.target_type, r.target_id,
                        r.relation, r.reason, r.evidence, r.confidence,
                        r.judgment_status, r.marked_by_actor, r.marked_by_kind, r.marked_by_model,
                        r.session_id, r.created_at, r.updated_at
                 FROM memory_relations r
                 WHERE r.judgment_status = 'pending'
                   AND (
                     (r.source_type = 'note'        AND r.source_id IN (SELECT id FROM notes        WHERE project_id = ?))
                     OR (r.source_type = 'decision'   AND r.source_id IN (SELECT id FROM decisions    WHERE project_id = ?))
                     OR (r.source_type = 'artifact'   AND r.source_id IN (SELECT id FROM artifacts    WHERE project_id = ?))
                     OR (r.source_type = 'code_entity' AND r.source_id IN (SELECT id FROM code_entities WHERE project_id = ?))
                   )
                 ORDER BY r.confidence DESC, r.created_at DESC
                 LIMIT ?",
            )?;
            let rows: Vec<Relation> = stmt
                .query_map(params![pid, pid, pid, pid, limit], map_relation)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        } else {
            let mut stmt = conn.prepare(
                "SELECT sync_id, source_type, source_id, target_type, target_id, relation,
                        reason, evidence, confidence, judgment_status,
                        marked_by_actor, marked_by_kind, marked_by_model,
                        session_id, created_at, updated_at
                 FROM memory_relations
                 WHERE judgment_status = 'pending'
                 ORDER BY confidence DESC, created_at DESC
                 LIMIT ?",
            )?;
            let rows: Vec<Relation> = stmt
                .query_map(params![limit], map_relation)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        }
    })
}

/// All accepted relations touching any of the given IDs. Used by
/// `build_context` to drive conflict exclusion and graph expansion.
pub fn get_accepted_relations_for_ids(
    conn: &Connection,
    ids: &[String],
) -> Result<Vec<AcceptedRelation>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = vec!["?"; ids.len()].join(",");
    let sql = format!(
        "SELECT source_type, source_id, target_type, target_id, relation, confidence
         FROM memory_relations
         WHERE judgment_status = 'accepted'
           AND (source_id IN ({ph}) OR target_id IN ({ph}))",
        ph = placeholders
    );
    let mut stmt = conn.prepare(&sql)?;
    // SQLite binds positionally — we duplicate the slice once for each IN clause.
    let mut all_params: Vec<&dyn ToSql> = Vec::with_capacity(ids.len() * 2);
    for id in ids {
        all_params.push(id as &dyn ToSql);
    }
    for id in ids {
        all_params.push(id as &dyn ToSql);
    }
    let rows: Vec<AcceptedRelation> = stmt
        .query_map(params_from_iter(all_params.iter()), |r| {
            Ok(AcceptedRelation {
                source_type: r.get(0)?,
                source_id: r.get(1)?,
                target_type: r.get(2)?,
                target_id: r.get(3)?,
                relation: r.get(4)?,
                confidence: r.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn map_relation(r: &rusqlite::Row<'_>) -> rusqlite::Result<Relation> {
    Ok(Relation {
        sync_id: r.get(0)?,
        source_type: r.get(1)?,
        source_id: r.get(2)?,
        target_type: r.get(3)?,
        target_id: r.get(4)?,
        relation: r.get(5)?,
        reason: r.get(6)?,
        evidence: r.get(7)?,
        confidence: r.get(8)?,
        judgment_status: r.get(9)?,
        marked_by_actor: r.get(10)?,
        marked_by_kind: r.get(11)?,
        marked_by_model: r.get(12)?,
        session_id: r.get(13)?,
        created_at: r.get(14)?,
        updated_at: r.get(15)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> Db {
        Db::new_in_memory().unwrap()
    }

    fn sample_params<'a>(
        st: &'a str,
        si: &'a str,
        tt: &'a str,
        ti: &'a str,
        rel: &'a str,
    ) -> UpsertRelationParams<'a> {
        UpsertRelationParams {
            source_type: st,
            source_id: si,
            target_type: tt,
            target_id: ti,
            relation: rel,
            reason: "",
            evidence: "",
            confidence: Some(0.7),
            judgment_status: Some("pending"),
            marked_by_actor: "agent",
            marked_by_kind: Some("auto"),
            marked_by_model: "",
            ..Default::default()
        }
    }

    #[test]
    fn compute_sync_id_is_symmetric_for_symmetric_relations() {
        let a = compute_relation_sync_id("note", "x", "note", "y", "structural_sibling");
        let b = compute_relation_sync_id("note", "y", "note", "x", "structural_sibling");
        assert_eq!(a, b);
    }

    #[test]
    fn compute_sync_id_is_directed_for_directed_relations() {
        let a = compute_relation_sync_id("note", "x", "note", "y", "implements");
        let b = compute_relation_sync_id("note", "y", "note", "x", "implements");
        assert_ne!(a, b);
    }

    #[test]
    fn sync_id_is_32_hex_chars() {
        let id = compute_relation_sync_id("a", "1", "b", "2", "references");
        assert_eq!(id.len(), 32);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn upsert_idempotent() {
        let db = fresh();
        let p = sample_params("note", "n1", "note", "n2", "implements");
        let sid1 = upsert(&db, &p).unwrap();
        let sid2 = upsert(&db, &p).unwrap();
        assert_eq!(sid1, sid2);

        let count: i64 = db
            .with(|conn| {
                Ok(conn.query_row("SELECT COUNT(*) FROM memory_relations", [], |r| r.get(0))?)
            })
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn upsert_preserves_rejected_against_overwrite() {
        let db = fresh();
        let p = sample_params("note", "n1", "note", "n2", "implements");
        let sid = upsert(&db, &p).unwrap();
        judge(&db, &sid, "rejected", "human", "human", "").unwrap();

        // Re-upserting with pending must NOT downgrade the rejected status.
        upsert(&db, &p).unwrap();
        let r = get_for_entity(&db, "note", "n1", &RelationFilters::default()).unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].judgment_status, "rejected");
    }

    #[test]
    fn judge_changes_status() {
        let db = fresh();
        let sid = upsert(
            &db,
            &sample_params("note", "n1", "note", "n2", "implements"),
        )
        .unwrap();
        judge(&db, &sid, "accepted", "human", "human", "claude").unwrap();
        let r = get_for_entity(&db, "note", "n1", &RelationFilters::default()).unwrap();
        assert_eq!(r[0].judgment_status, "accepted");
    }

    #[test]
    fn get_for_entity_filters_by_status_and_relation() {
        let db = fresh();
        upsert(
            &db,
            &sample_params("note", "x", "note", "y", "implements"),
        )
        .unwrap();
        upsert(
            &db,
            &sample_params("note", "x", "note", "z", "depends_on"),
        )
        .unwrap();

        let all = get_for_entity(&db, "note", "x", &RelationFilters::default()).unwrap();
        assert_eq!(all.len(), 2);

        let only_impl = get_for_entity(
            &db,
            "note",
            "x",
            &RelationFilters { relation: Some("implements"), ..Default::default() },
        )
        .unwrap();
        assert_eq!(only_impl.len(), 1);
        assert_eq!(only_impl[0].relation, "implements");
    }

    #[test]
    fn get_pending_judgments_returns_only_pending() {
        let db = fresh();
        let sid1 = upsert(
            &db,
            &sample_params("note", "x", "note", "y", "implements"),
        )
        .unwrap();
        let _sid2 = upsert(
            &db,
            &sample_params("note", "x", "note", "z", "depends_on"),
        )
        .unwrap();
        judge(&db, &sid1, "accepted", "human", "human", "").unwrap();

        let pending = get_pending_judgments(&db, None, 50).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].relation, "depends_on");
    }

    #[test]
    fn accepted_relations_for_ids() {
        let db = fresh();
        let sid_ok = upsert(
            &db,
            &sample_params("note", "x", "note", "y", "implements"),
        )
        .unwrap();
        let sid_pending = upsert(
            &db,
            &sample_params("note", "x", "note", "z", "depends_on"),
        )
        .unwrap();
        judge(&db, &sid_ok, "accepted", "human", "human", "").unwrap();
        let _ = sid_pending;

        let ids = vec!["x".to_string()];
        let got = db
            .with(|conn| get_accepted_relations_for_ids(conn, &ids))
            .unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].relation, "implements");
    }
}
