//! Graph links + audit trail. Mirrors `addLink`/`getRelated`/`getAuditTrail`
//! in `src/db.ts` L1936-2443.

use anyhow::Result;
use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

use super::{new_uuid, Db};

const ENTITY_TABLES: &[(&str, &str)] = &[
    ("note", "notes"),
    ("decision", "decisions"),
    ("artifact", "artifacts"),
    ("code_entity", "code_entities"),
    ("project", "projects"),
    ("session", "sessions"),
];

fn table_for(entity_type: &str) -> Option<&'static str> {
    ENTITY_TABLES
        .iter()
        .find(|(t, _)| *t == entity_type)
        .map(|(_, table)| *table)
}

fn entity_key(t: &str, id: &str) -> String {
    format!("{}:{}", t, id)
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Link {
    pub id: String,
    pub from_type: String,
    pub from_id: String,
    pub to_type: String,
    pub to_id: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct EntityEntry {
    pub key: String,
    #[serde(rename = "type")]
    pub entity_type: String,
    pub entity: Option<Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RootNode {
    #[serde(rename = "type")]
    pub entity_type: String,
    pub id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct GetRelatedResponse {
    pub root: RootNode,
    pub depth: i64,
    pub links: Vec<Link>,
    pub entities: Vec<EntityEntry>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AuditEvent {
    pub id: String,
    pub entity_type: String,
    pub entity_id: String,
    pub op: String,
    pub payload_before: Option<Value>,
    pub payload_after: Option<Value>,
    pub ts: String,
}

pub fn list_all(db: &Db) -> Result<Vec<Link>> {
    db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, from_type, from_id, to_type, to_id, created_at
             FROM links
             ORDER BY created_at DESC",
        )?;
        let rows: Vec<Link> = stmt
            .query_map([], |r| {
                Ok(Link {
                    id: r.get(0)?,
                    from_type: r.get(1)?,
                    from_id: r.get(2)?,
                    to_type: r.get(3)?,
                    to_id: r.get(4)?,
                    created_at: r.get(5)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    })
}

pub fn add_link(
    db: &Db,
    from_type: &str,
    from_id: &str,
    to_type: &str,
    to_id: &str,
) -> Result<String> {
    db.with(|conn| {
        let id = new_uuid();
        conn.execute(
            "INSERT INTO links (id, from_type, from_id, to_type, to_id) VALUES (?, ?, ?, ?, ?)",
            params![id, from_type, from_id, to_type, to_id],
        )?;
        Ok(id)
    })
}

fn resolve_entity(conn: &Connection, entity_type: &str, id: &str) -> Result<Option<Value>> {
    let Some(table) = table_for(entity_type) else {
        return Ok(None);
    };
    let sql = format!("SELECT * FROM {} WHERE id = ?", table);
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(params![id])?;
    if let Some(row) = rows.next()? {
        let mut obj = serde_json::Map::new();
        let col_count = row.as_ref().column_count();
        for i in 0..col_count {
            let name = row.as_ref().column_name(i)?.to_string();
            let value: Value = match row.get_ref(i)? {
                rusqlite::types::ValueRef::Null => Value::Null,
                rusqlite::types::ValueRef::Integer(n) => Value::Number(n.into()),
                rusqlite::types::ValueRef::Real(f) => serde_json::Number::from_f64(f)
                    .map(Value::Number)
                    .unwrap_or(Value::Null),
                rusqlite::types::ValueRef::Text(s) => {
                    Value::String(String::from_utf8_lossy(s).into_owned())
                }
                rusqlite::types::ValueRef::Blob(b) => Value::String(format!("<blob:{}b>", b.len())),
            };
            obj.insert(name, value);
        }
        Ok(Some(Value::Object(obj)))
    } else {
        Ok(None)
    }
}

pub fn get_related(
    db: &Db,
    entity_type: &str,
    entity_id: &str,
    depth: i64,
) -> Result<GetRelatedResponse> {
    let max_depth = depth.max(0);
    db.with(|conn| {
        let mut visited: HashSet<String> = HashSet::new();
        let mut seen_links: HashSet<String> = HashSet::new();
        let mut links: Vec<Link> = Vec::new();
        let mut entities: HashMap<String, EntityEntry> = HashMap::new();
        let mut entity_order: Vec<String> = Vec::new();

        let root_key = entity_key(entity_type, entity_id);
        visited.insert(root_key.clone());
        let root_entity = resolve_entity(conn, entity_type, entity_id)?;
        entities.insert(
            root_key.clone(),
            EntityEntry {
                key: root_key.clone(),
                entity_type: entity_type.to_string(),
                entity: root_entity,
            },
        );
        entity_order.push(root_key.clone());

        let mut frontier: Vec<(String, String)> = vec![(entity_type.to_string(), entity_id.to_string())];

        for _ in 0..max_depth {
            let mut next_frontier: Vec<(String, String)> = Vec::new();
            for (node_type, node_id) in &frontier {
                let mut stmt = conn.prepare(
                    "SELECT id, from_type, from_id, to_type, to_id, created_at
                     FROM links
                     WHERE (from_type = ? AND from_id = ?) OR (to_type = ? AND to_id = ?)
                     ORDER BY created_at ASC",
                )?;
                let rows: Vec<Link> = stmt
                    .query_map(params![node_type, node_id, node_type, node_id], |r| {
                        Ok(Link {
                            id: r.get(0)?,
                            from_type: r.get(1)?,
                            from_id: r.get(2)?,
                            to_type: r.get(3)?,
                            to_id: r.get(4)?,
                            created_at: r.get(5)?,
                        })
                    })?
                    .collect::<rusqlite::Result<_>>()?;
                for link in rows {
                    if !seen_links.contains(&link.id) {
                        seen_links.insert(link.id.clone());
                        links.push(link.clone());
                    }
                    let (n_type, n_id) =
                        if link.from_type == *node_type && link.from_id == *node_id {
                            (link.to_type.clone(), link.to_id.clone())
                        } else {
                            (link.from_type.clone(), link.from_id.clone())
                        };
                    let key = entity_key(&n_type, &n_id);
                    if visited.contains(&key) {
                        continue;
                    }
                    visited.insert(key.clone());
                    let neighbor_entity = resolve_entity(conn, &n_type, &n_id)?;
                    entities.insert(
                        key.clone(),
                        EntityEntry {
                            key: key.clone(),
                            entity_type: n_type.clone(),
                            entity: neighbor_entity,
                        },
                    );
                    entity_order.push(key);
                    next_frontier.push((n_type, n_id));
                }
            }
            if next_frontier.is_empty() {
                break;
            }
            frontier = next_frontier;
        }

        let entities_ordered: Vec<EntityEntry> = entity_order
            .into_iter()
            .filter_map(|k| entities.remove(&k))
            .collect();

        Ok(GetRelatedResponse {
            root: RootNode {
                entity_type: entity_type.to_string(),
                id: entity_id.to_string(),
            },
            depth: max_depth,
            links,
            entities: entities_ordered,
        })
    })
}

pub fn get_audit_trail(db: &Db, entity_type: &str, entity_id: &str) -> Result<Vec<AuditEvent>> {
    db.with(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, entity_type, entity_id, op, payload_before, payload_after, ts
             FROM events
             WHERE entity_type = ? AND entity_id = ?
             ORDER BY ts ASC",
        )?;
        let rows: Vec<AuditEvent> = stmt
            .query_map(params![entity_type, entity_id], |r| {
                let before: Option<String> = r.get(4)?;
                let after: Option<String> = r.get(5)?;
                Ok(AuditEvent {
                    id: r.get(0)?,
                    entity_type: r.get(1)?,
                    entity_id: r.get(2)?,
                    op: r.get(3)?,
                    payload_before: before
                        .as_deref()
                        .and_then(|s| serde_json::from_str(s).ok()),
                    payload_after: after.as_deref().and_then(|s| serde_json::from_str(s).ok()),
                    ts: r.get(6)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repo::{notes, projects};

    fn fresh_with_project() -> (Db, String) {
        let db = Db::new_in_memory().unwrap();
        let p = projects::upsert_force(&db, "p1", "", "development", &[]).unwrap();
        (db, p.id)
    }

    #[test]
    fn add_link_persists() {
        let (db, _) = fresh_with_project();
        let id = add_link(&db, "note", "a", "decision", "b").unwrap();
        assert!(!id.is_empty());
    }

    #[test]
    fn get_related_depth_zero_returns_only_root() {
        let (db, _) = fresh_with_project();
        let r = get_related(&db, "note", "absent", 0).unwrap();
        assert_eq!(r.depth, 0);
        assert!(r.links.is_empty());
        assert_eq!(r.entities.len(), 1);
        assert_eq!(r.entities[0].entity_type, "note");
    }

    #[test]
    fn get_related_depth_one_walks_one_hop() {
        let (db, pid) = fresh_with_project();
        let n1 = notes::add(&db, &pid, "first", &[], Some(3), None).unwrap();
        let n2 = notes::add(&db, &pid, "second", &[], Some(3), None).unwrap();
        add_link(&db, "note", &n1, "note", &n2).unwrap();
        let r = get_related(&db, "note", &n1, 1).unwrap();
        assert_eq!(r.links.len(), 1);
        // root + 1 neighbor
        assert_eq!(r.entities.len(), 2);
    }

    #[test]
    fn get_audit_trail_reads_events() {
        let (db, pid) = fresh_with_project();
        let id = notes::add(&db, &pid, "x", &[], Some(3), None).unwrap();
        let events = get_audit_trail(&db, "note", &id).unwrap();
        // The events table has insert triggers — at least one row should appear.
        assert!(!events.is_empty(), "expected at least one insert event");
        assert_eq!(events[0].op, "insert");
    }
}
