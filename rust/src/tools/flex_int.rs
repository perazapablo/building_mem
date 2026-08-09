//! Flexible i64 deserializer for MCP tool args.
//!
//! Some MCP clients (or LLMs constructing tool calls) serialize integers as
//! JSON strings (e.g. `"10"` instead of `10`). Strict `i64` deserialization
//! then fails with `-32602 invalid type: string, expected i64`.
//!
//! Use as:
//!   `#[serde(deserialize_with = "flex_int::deserialize")] pub x: i64,`
//!   `#[serde(default, deserialize_with = "flex_int::opt::deserialize")] pub x: Option<i64>,`

use serde::{de, Deserialize, Deserializer};

pub fn deserialize<'de, D>(d: D) -> Result<i64, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Any {
        Int(i64),
        Float(f64),
        Str(String),
    }

    match Any::deserialize(d)? {
        Any::Int(i) => Ok(i),
        Any::Float(f) => {
            if f.fract() == 0.0 && f.is_finite() {
                Ok(f as i64)
            } else {
                Err(de::Error::custom(format!(
                    "expected integer, got non-integral float: {f}"
                )))
            }
        }
        Any::Str(s) => s
            .trim()
            .parse::<i64>()
            .map_err(|e| de::Error::custom(format!("expected integer, got string {s:?}: {e}"))),
    }
}

pub mod opt {
    use super::*;

    pub fn deserialize<'de, D>(d: D) -> Result<Option<i64>, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Any {
            Int(i64),
            Float(f64),
            Str(String),
            Null,
        }

        match Option::<Any>::deserialize(d)? {
            None | Some(Any::Null) => Ok(None),
            Some(Any::Int(i)) => Ok(Some(i)),
            Some(Any::Float(f)) => {
                if f.fract() == 0.0 && f.is_finite() {
                    Ok(Some(f as i64))
                } else {
                    Err(de::Error::custom(format!(
                        "expected integer, got non-integral float: {f}"
                    )))
                }
            }
            Some(Any::Str(s)) => {
                let t = s.trim();
                if t.is_empty() {
                    Ok(None)
                } else {
                    t.parse::<i64>()
                        .map(Some)
                        .map_err(|e| de::Error::custom(format!("expected integer, got string {s:?}: {e}")))
                }
            }
        }
    }
}
