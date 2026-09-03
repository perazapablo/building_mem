//! Decision records: append-only ADR chains captured in the moment.
//!
//! Unlike `decisions` (legacy, frozen: topic_key upsert destroyed history),
//! a `topic_key` here identifies a CHAIN of immutable records linked by
//! `supersedes`/`superseded_by`. The single `active` record per
//! (project_id, topic_key) is the tip, enforced by a partial unique index.
//! Immutability is enforced by BEFORE UPDATE triggers — the repo layer
//! only ever inserts new records or writes the closure fields once.

use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::{new_uuid, Db};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Alternative {
    pub option: String,
    /// None = the rejection reason is genuinely unknown. Never fabricated
    /// to fill the field — a null here is signal, not a gap.
    #[serde(default)]
    pub rejected_because: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Evidence {
    /// path | commit | memory_ref | quote
    pub kind: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DecisionRecordRow {
    pub id: String,
    pub project_id: String,
    pub topic_key: String,
    pub session_id: String,
    pub phase: Option<String>,
    pub created_at: String,
    pub statement: String,
    pub forces: Vec<String>,
    pub alternatives: Vec<Alternative>,
    pub consequences: Vec<String>,
    pub origin: String,
    pub evidence: Vec<Evidence>,
    pub confidence: String,
    pub status: String,
    pub status_reason: Option<String>,
    pub closed_by_session: Option<String>,
    pub supersedes: Option<String>,
    pub superseded_by: Option<String>,
}

pub struct NewDecisionRecord<'a> {
    pub project_id: &'a str,
    pub topic_key: &'a str,
    pub session_id: &'a str,
    pub phase: Option<&'a str>,
    pub statement: &'a str,
    pub forces: &'a [String],
    pub alternatives: &'a [Alternative],
    pub consequences: &'a [String],
    pub origin: &'a str,
    pub evidence: &'a [Evidence],
    pub confidence: &'a str,
    pub supersedes: Option<&'a str>,
}

/// Outcome of `record`: either the new record (plus the id it closed, if it
/// superseded one), or a tip conflict the caller must resolve consciously.
#[derive(Debug)]
pub enum RecordOutcome {
    Recorded { record: DecisionRecordRow, superseded: Option<String> },
    /// An active tip exists for this chain and `supersedes` did not name it.
    /// Forces the caller to read what it is about to replace.
    TipConflict { tip_id: String, tip_statement: String, tip_created_at: String },
}

const COLUMNS: &str = "id, project_id, topic_key, session_id, phase, created_at, statement, \
     forces_json, alternatives_json, consequences_json, origin, evidence_json, confidence, \
     status, status_reason, closed_by_session, supersedes, superseded_by";

fn parse_vec<T: for<'de> Deserialize<'de>>(raw: &str) -> Vec<T> {
    serde_json::from_str(raw).unwrap_or_default()
}

fn map_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<DecisionRecordRow> {
    let forces_json: String = r.get(7)?;
    let alternatives_json: String = r.get(8)?;
    let consequences_json: String = r.get(9)?;
    let evidence_json: String = r.get(11)?;
    Ok(DecisionRecordRow {
        id: r.get(0)?,
        project_id: r.get(1)?,
        topic_key: r.get(2)?,
        session_id: r.get(3)?,
        phase: r.get(4)?,
        created_at: r.get(5)?,
        statement: r.get(6)?,
        forces: parse_vec(&forces_json),
        alternatives: parse_vec(&alternatives_json),
        consequences: parse_vec(&consequences_json),
        origin: r.get(10)?,
        evidence: parse_vec(&evidence_json),
        confidence: r.get(12)?,
        status: r.get(13)?,
        status_reason: r.get(14)?,
        closed_by_session: r.get(15)?,
        supersedes: r.get(16)?,
        superseded_by: r.get(17)?,
    })
}

fn get_in_conn(conn: &Connection, id: &str) -> Result<Option<DecisionRecordRow>> {
    let row = conn
        .query_row(
            &format!("SELECT {COLUMNS} FROM decision_records WHERE id = ?"),
            params![id],
            map_row,
        )
        .optional()?;
    Ok(row)
}

fn find_tip(conn: &Connection, project_id: &str, topic_key: &str) -> Result<Option<DecisionRecordRow>> {
    let row = conn
        .query_row(
            &format!(
                "SELECT {COLUMNS} FROM decision_records \
                 WHERE project_id = ? AND topic_key = ? AND status = 'active'"
            ),
            params![project_id, topic_key],
            map_row,
        )
        .optional()?;
    Ok(row)
}

/// What FTS indexes beyond the statement: forces, alternatives (options AND
/// rejection reasons — a rejected option must be findable a year later),
/// consequences. Evidence stays out: quotes would pollute ranking.
fn build_search_text(
    statement: &str,
    forces: &[String],
    alternatives: &[Alternative],
    consequences: &[String],
) -> String {
    let mut parts: Vec<&str> = vec![statement];
    parts.extend(forces.iter().map(String::as_str));
    for alt in alternatives {
        parts.push(&alt.option);
        if let Some(reason) = &alt.rejected_because {
            parts.push(reason);
        }
    }
    parts.extend(consequences.iter().map(String::as_str));
    parts.join(" ")
}

pub fn record(db: &Db, new: NewDecisionRecord<'_>) -> Result<RecordOutcome> {
    db.with_mut(|conn| {
        let tx = conn.transaction()?;

        let tip = find_tip(&tx, new.project_id, new.topic_key)?;
        match (&tip, new.supersedes) {
            // Starting a chain while claiming to supersede something: verify
            // the target exists, belongs to the same chain, and is the tip.
            (None, Some(target)) => {
                let existing = get_in_conn(&tx, target)?;
                match existing {
                    None => bail!("supersedes target not found: {target}"),
                    Some(row) => bail!(
                        "supersedes target {target} is not the active tip of chain '{}' (status: {})",
                        row.topic_key, row.status
                    ),
                }
            }
            (Some(t), Some(target)) if t.id != target => {
                return Ok(RecordOutcome::TipConflict {
                    tip_id: t.id.clone(),
                    tip_statement: t.statement.clone(),
                    tip_created_at: t.created_at.clone(),
                });
            }
            (Some(t), None) => {
                return Ok(RecordOutcome::TipConflict {
                    tip_id: t.id.clone(),
                    tip_statement: t.statement.clone(),
                    tip_created_at: t.created_at.clone(),
                });
            }
            _ => {}
        }

        let id = new_uuid();
        let search_text =
            build_search_text(new.statement, new.forces, new.alternatives, new.consequences);

        // Close the old tip BEFORE inserting: the partial unique index allows
        // only one active record per chain at any instant.
        let superseded = if let Some(t) = &tip {
            tx.execute(
                "UPDATE decision_records \
                 SET status = 'superseded', superseded_by = ?, closed_by_session = ? \
                 WHERE id = ? AND status = 'active'",
                params![id, new.session_id, t.id],
            )?;
            Some(t.id.clone())
        } else {
            None
        };

        tx.execute(
            "INSERT INTO decision_records (
                id, project_id, topic_key, session_id, phase, statement,
                forces_json, alternatives_json, consequences_json,
                origin, evidence_json, confidence, supersedes, search_text
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                id,
                new.project_id,
                new.topic_key,
                new.session_id,
                new.phase,
                new.statement,
                serde_json::to_string(new.forces)?,
                serde_json::to_string(new.alternatives)?,
                serde_json::to_string(new.consequences)?,
                new.origin,
                serde_json::to_string(new.evidence)?,
                new.confidence,
                new.supersedes,
                search_text,
            ],
        )?;

        let record = get_in_conn(&tx, &id)?
            .ok_or_else(|| anyhow::anyhow!("inserted decision_record not found: {id}"))?;
        tx.commit()?;
        Ok(RecordOutcome::Recorded { record, superseded })
    })
}

/// Revert an active record: the decision was undone, not replaced.
/// `reason` is mandatory — a revert without a why is the same fabrication
/// hole the whole design exists to close.
pub fn revert(db: &Db, id: &str, reason: &str, session_id: &str) -> Result<DecisionRecordRow> {
    db.with_mut(|conn| {
        let tx = conn.transaction()?;
        let existing = match get_in_conn(&tx, id)? {
            Some(row) => row,
            None => bail!("decision_record not found: {id}"),
        };
        if existing.status != "active" {
            bail!(
                "decision_record {id} is not active (status: {}); closed records are frozen",
                existing.status
            );
        }
        tx.execute(
            "UPDATE decision_records \
             SET status = 'reverted', status_reason = ?, closed_by_session = ? \
             WHERE id = ?",
            params![reason, session_id, id],
        )?;
        let row = get_in_conn(&tx, id)?
            .ok_or_else(|| anyhow::anyhow!("decision_record vanished during revert: {id}"))?;
        tx.commit()?;
        Ok(row)
    })
}

pub fn get(db: &Db, id: &str) -> Result<Option<DecisionRecordRow>> {
    db.with(|conn| get_in_conn(conn, id))
}

/// The chain for a topic, tip-first, following `supersedes` backwards.
/// The tip is the active record, or — for a fully closed chain — the most
/// recently inserted one. `depth` limits how far back to walk (None = all).
pub fn chain(
    db: &Db,
    project_id: &str,
    topic_key: &str,
    depth: Option<i64>,
) -> Result<Vec<DecisionRecordRow>> {
    db.with(|conn| {
        let tip = match find_tip(conn, project_id, topic_key)? {
            Some(t) => Some(t),
            None => conn
                .query_row(
                    &format!(
                        "SELECT {COLUMNS} FROM decision_records \
                         WHERE project_id = ? AND topic_key = ? \
                         ORDER BY rowid DESC LIMIT 1"
                    ),
                    params![project_id, topic_key],
                    map_row,
                )
                .optional()?,
        };

        let max = depth.unwrap_or(i64::MAX).max(1);
        let mut out = Vec::new();
        let mut cursor = tip;
        while let Some(row) = cursor {
            let next_id = row.supersedes.clone();
            out.push(row);
            if out.len() as i64 >= max {
                break;
            }
            cursor = match next_id {
                Some(id) => get_in_conn(conn, &id)?,
                None => None,
            };
        }
        Ok(out)
    })
}

/// Active tips for a project, most recent first. What a context assembler
/// injects: the current state of every open chain, without history.
pub fn list_tips(db: &Db, project_id: &str) -> Result<Vec<DecisionRecordRow>> {
    db.with(|conn| {
        let mut stmt = conn.prepare(&format!(
            "SELECT {COLUMNS} FROM decision_records \
             WHERE project_id = ? AND status = 'active' \
             ORDER BY created_at DESC"
        ))?;
        let rows = stmt
            .query_map(params![project_id], map_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repo::projects;

    fn setup() -> (Db, String) {
        let db = Db::new_in_memory().unwrap();
        let p = projects::upsert_force(&db, "test-project", "", "development", &[]).unwrap();
        (db, p.id)
    }

    fn base_record<'a>(project_id: &'a str, topic_key: &'a str) -> NewDecisionRecord<'a> {
        NewDecisionRecord {
            project_id,
            topic_key,
            session_id: "sess-1",
            phase: Some("planning"),
            statement: "use charges API only in phase 1",
            forces: &[],
            alternatives: &[],
            consequences: &[],
            origin: "user_explicit",
            evidence: &[],
            confidence: "decided",
            supersedes: None,
        }
    }

    fn recorded(outcome: RecordOutcome) -> DecisionRecordRow {
        match outcome {
            RecordOutcome::Recorded { record, .. } => record,
            RecordOutcome::TipConflict { tip_id, .. } => {
                panic!("expected Recorded, got TipConflict with {tip_id}")
            }
        }
    }

    #[test]
    fn record_starts_chain() {
        let (db, pid) = setup();
        let row = recorded(record(&db, base_record(&pid, "openpay.scope")).unwrap());
        assert_eq!(row.status, "active");
        assert_eq!(row.supersedes, None);
        assert_eq!(row.topic_key, "openpay.scope");
    }

    #[test]
    fn second_record_without_supersedes_conflicts() {
        let (db, pid) = setup();
        let first = recorded(record(&db, base_record(&pid, "openpay.scope")).unwrap());
        match record(&db, base_record(&pid, "openpay.scope")).unwrap() {
            RecordOutcome::TipConflict { tip_id, .. } => assert_eq!(tip_id, first.id),
            RecordOutcome::Recorded { .. } => panic!("expected TipConflict"),
        }
    }

    #[test]
    fn supersede_closes_old_tip_in_one_tx() {
        let (db, pid) = setup();
        let first = recorded(record(&db, base_record(&pid, "openpay.scope")).unwrap());
        let mut second = base_record(&pid, "openpay.scope");
        second.statement = "add hosted checkout as fallback";
        second.supersedes = Some(&first.id);
        let outcome = record(&db, second).unwrap();
        let (new_row, superseded) = match outcome {
            RecordOutcome::Recorded { record, superseded } => (record, superseded),
            _ => panic!("expected Recorded"),
        };
        assert_eq!(superseded.as_deref(), Some(first.id.as_str()));
        assert_eq!(new_row.supersedes.as_deref(), Some(first.id.as_str()));

        let old = get(&db, &first.id).unwrap().unwrap();
        assert_eq!(old.status, "superseded");
        assert_eq!(old.superseded_by.as_deref(), Some(new_row.id.as_str()));
    }

    #[test]
    fn supersede_non_tip_fails() {
        let (db, pid) = setup();
        let first = recorded(record(&db, base_record(&pid, "openpay.scope")).unwrap());
        let mut second = base_record(&pid, "openpay.scope");
        second.supersedes = Some(&first.id);
        let second_row = recorded(record(&db, second).unwrap());

        // Superseding the already-closed first record must fail: only the tip.
        let mut third = base_record(&pid, "openpay.scope");
        third.supersedes = Some(&first.id);
        match record(&db, third).unwrap() {
            RecordOutcome::TipConflict { tip_id, .. } => assert_eq!(tip_id, second_row.id),
            RecordOutcome::Recorded { .. } => panic!("expected TipConflict"),
        }
    }

    #[test]
    fn revert_requires_active_and_sets_reason() {
        let (db, pid) = setup();
        let row = recorded(record(&db, base_record(&pid, "openpay.scope")).unwrap());
        let reverted = revert(&db, &row.id, "business dropped subscriptions", "sess-2").unwrap();
        assert_eq!(reverted.status, "reverted");
        assert_eq!(reverted.status_reason.as_deref(), Some("business dropped subscriptions"));
        assert_eq!(reverted.closed_by_session.as_deref(), Some("sess-2"));
        // Closed records are frozen: second revert fails.
        assert!(revert(&db, &row.id, "again", "sess-2").is_err());
    }

    #[test]
    fn immutability_trigger_blocks_content_updates() {
        let (db, pid) = setup();
        let row = recorded(record(&db, base_record(&pid, "openpay.scope")).unwrap());
        let result = db.with(|conn| {
            conn.execute(
                "UPDATE decision_records SET statement = 'rewritten history' WHERE id = ?",
                params![row.id],
            )?;
            Ok(())
        });
        assert!(result.is_err(), "content UPDATE must be rejected by trigger");
    }

    #[test]
    fn chain_walks_tip_first() {
        let (db, pid) = setup();
        let first = recorded(record(&db, base_record(&pid, "openpay.scope")).unwrap());
        let mut second = base_record(&pid, "openpay.scope");
        second.supersedes = Some(&first.id);
        let second_row = recorded(record(&db, second).unwrap());

        let chain_rows = chain(&db, &pid, "openpay.scope", None).unwrap();
        assert_eq!(chain_rows.len(), 2);
        assert_eq!(chain_rows[0].id, second_row.id);
        assert_eq!(chain_rows[1].id, first.id);

        let limited = chain(&db, &pid, "openpay.scope", Some(1)).unwrap();
        assert_eq!(limited.len(), 1);
        assert_eq!(limited[0].id, second_row.id);
    }

    #[test]
    fn legacy_active_decisions_migrate_as_single_link_chains() {
        let (db, pid) = setup();
        // Simulate a pre-v12 database: drop the v12 objects and its
        // schema_migrations row, then populate legacy `decisions`.
        db.with_mut(|conn| {
            conn.execute_batch(
                "DROP TABLE decision_records_fts;
                 DROP TABLE decision_records;
                 DELETE FROM schema_migrations WHERE version = 12;",
            )?;
            Ok(())
        })
        .unwrap();

        let with_topic = crate::repo::decisions::add(
            &db, &pid, "use charges API", "recurrence has no browser", Some(4), Some("openpay-scope"),
        )
        .unwrap();
        let no_topic = crate::repo::decisions::add(
            &db, &pid, "schema from business model", "subscriptions drive tables", None, None,
        )
        .unwrap();
        let obsolete = crate::repo::decisions::add(
            &db, &pid, "dead decision", "superseded reasoning", None, Some("dead-topic"),
        )
        .unwrap();
        crate::repo::mutations::mark_obsolete(&db, "decision", &obsolete, "outdated").unwrap();

        db.with_mut(|conn| {
            crate::migrations::run(conn)?;
            Ok(())
        })
        .unwrap();

        // Active rows migrated as single-link chains keeping their ids.
        let migrated = get(&db, &with_topic).unwrap().unwrap();
        assert_eq!(migrated.status, "active");
        assert_eq!(migrated.topic_key, "openpay-scope");
        assert_eq!(migrated.origin, "agent_inferred");
        assert_eq!(migrated.session_id, "legacy-migration");
        assert_eq!(migrated.evidence.len(), 1);
        assert_eq!(migrated.evidence[0].kind, "quote");
        assert_eq!(migrated.evidence[0].value, "recurrence has no browser");

        let fallback = get(&db, &no_topic).unwrap().unwrap();
        assert_eq!(fallback.topic_key, format!("legacy-{no_topic}"));

        // Obsolete rows stay behind in the frozen legacy table.
        assert!(get(&db, &obsolete).unwrap().is_none());

        // Migrated content is FTS-searchable via search_text (reasoning included).
        let hits = crate::repo::search::search_all(&db, "recurrence browser", &pid, 10, false)
            .unwrap();
        assert!(hits
            .results
            .iter()
            .any(|r| matches!(r, crate::repo::search::SearchAllResult::DecisionRecord { id, .. } if id == &with_topic)));

        // And the migrated record behaves as a real chain tip: superseding works.
        let mut next = base_record(&pid, "openpay-scope");
        next.supersedes = Some(&with_topic);
        let new_tip = recorded(record(&db, next).unwrap());
        let old = get(&db, &with_topic).unwrap().unwrap();
        assert_eq!(old.status, "superseded");
        assert_eq!(old.superseded_by.as_deref(), Some(new_tip.id.as_str()));
    }

    #[test]
    fn alternatives_allow_null_rejected_because() {
        let (db, pid) = setup();
        let alts = vec![Alternative {
            option: "hosted checkout".to_string(),
            rejected_because: None,
        }];
        let mut new = base_record(&pid, "openpay.checkout");
        new.alternatives = &alts;
        new.confidence = "tentative";
        let row = recorded(record(&db, new).unwrap());
        assert_eq!(row.alternatives.len(), 1);
        assert_eq!(row.alternatives[0].rejected_because, None);
    }
}
